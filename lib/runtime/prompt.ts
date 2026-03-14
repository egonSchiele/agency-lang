import * as smoltalk from "smoltalk";
import { MessageThread } from "./state/messageThread.js";
import {
  interrupt,
  Interrupt,
  InterruptData,
  isInterrupt,
} from "./interrupts.js";
import { updateTokenStats, extractResponse } from "./utils.js";
import { callHook } from "./hooks.js";
import { handleStreamingResponse, isGenerator } from "./streaming.js";
import type { RuntimeContext } from "./state/context.js";
import { color } from "@/utils/termcolors.js";
import { GraphState } from "./types.js";
import { PromptResult, Result, StreamChunk, ToolCallJSON } from "smoltalk";
import { ZodType } from "zod/v3";
import { ThreadStore } from "./state/threadStore.js";

export interface ToolHandler {
  name: string;
  params: string[];
  execute: (...args: any[]) => Promise<any>;
  isBuiltin: boolean;
}

type Tool = {
  name: string;
  description?: string;
  schema: any;
};

async function _runPrompt({
  ctx,
  messages,
  tools,
  prompt,
  responseFormat,
  stream,
  clientConfig,
}: {
  ctx: RuntimeContext<GraphState>;
  messages: MessageThread;
  tools: Tool[];
  prompt: string;
  responseFormat?: any;
  stream?: boolean;
  clientConfig: Partial<smoltalk.SmolPromptConfig>;
}): Promise<{ messages: MessageThread; toolCalls: smoltalk.ToolCallJSON[] }> {
  const startTime = performance.now();

  const startHookResult = await callHook({
    callbacks: ctx.callbacks,
    name: "onLLMCallStart",
    data: {
      prompt,
      tools,
      model: clientConfig.model,
      messages: messages.toJSON().messages,
    },
  });
  if (startHookResult) {
    messages = MessageThread.fromJSON(startHookResult);
  }

  let _completion: AsyncGenerator<StreamChunk> | Promise<Result<PromptResult>> =
    await (smoltalk.text as Function)({
      messages: messages.getMessages(),
      tools,
      responseFormat,
      stream,
      ...clientConfig,
    });

  const endTime = performance.now();
  let completion: PromptResult;
  let toolCalls: ToolCallJSON[] = [];

  if (stream) {
    const response = await handleStreamingResponse({
      ctx,
      completion: _completion as AsyncGenerator<StreamChunk>,
      prompt,
    });
    if (!response) {
      throw new Error(
        `No completion returned from streaming LLM call! This shouldn't happen.`,
      );
    }
    if (!response.success) {
      throw new Error(
        `Error getting completion from streaming response: ${response.error}`,
      );
    }
    completion = response.value.completion;
    toolCalls = response.value.toolCalls;
  } else {
    const response = await (_completion as Promise<Result<PromptResult>>);
    if (!response.success) {
      throw new Error(`Error getting completion: ${response.error}`);
    }
    completion = response.value;
    toolCalls = completion.toolCalls || [];
  }

  const modelName = completion.model || clientConfig.model || "unknown model";

  ctx.statelogClient.promptCompletion({
    messages: messages.getMessages(),
    completion,
    model: JSON.stringify(modelName),
    timeTaken: endTime - startTime,
    tools,
    responseFormat,
  });

  if (toolCalls.length > 0) {
    messages.push(
      smoltalk.assistantMessage(completion.output, {
        toolCalls,
      }),
    );
  } else {
    messages.push(smoltalk.assistantMessage(completion.output));
  }

  updateTokenStats({
    stateStack: ctx.stateStack,
    usage: completion.usage,
    cost: completion.cost,
  });
  const endHookResult = await callHook({
    callbacks: ctx.callbacks,
    name: "onLLMCallEnd",
    data: {
      model: JSON.stringify(modelName),
      result: completion,
      usage: completion.usage,
      cost: completion.cost,
      timeTaken: endTime - startTime,
      messages: messages.toJSON().messages,
    },
  });
  if (endHookResult) {
    messages = MessageThread.fromJSON(endHookResult);
  }

  return { messages, toolCalls };
}

type ExecuteToolCallsResult =
  | {
      isInterrupt: true;
      interrupt: Interrupt;
      messages: MessageThread;
    }
  | { isInterrupt: false; messages: MessageThread };

async function executeToolCalls({
  toolCalls,
  toolHandlers,
  messages,
  ctx,
  clientConfig,
  interruptData,
}: {
  toolCalls: smoltalk.ToolCallJSON[];
  toolHandlers: ToolHandler[];
  messages: MessageThread;
  ctx: RuntimeContext<GraphState>;
  clientConfig: Partial<smoltalk.SmolPromptConfig>;
  interruptData?: InterruptData;
}): Promise<ExecuteToolCallsResult> {
  for (const toolCall of toolCalls) {
    const handler = toolHandlers.find((h) => h.name === toolCall.name);
    if (!handler) {
      console.error(
        `No handler found for tool call: ${toolCall.name}. This error will be sent back to the LLM.`,
      );
      messages.push(
        smoltalk.toolMessage(
          `Error: No handler found for tool call ${toolCall.name}`,
          {
            tool_call_id: toolCall.id,
            name: toolCall.name,
          },
        ),
      );
      continue;
    }

    const params = handler.params.map(
      (param: string) => toolCall.arguments[param],
    );

    let result: any;
    if (
      interruptData &&
      interruptData.interruptResponse &&
      interruptData.interruptResponse.type === "reject"
    ) {
      const toolCallData = {
        tool_call_id: toolCall.id,
        name: toolCall.name,
      };
      messages.push(smoltalk.toolMessage("tool call rejected", toolCallData));
      ctx.statelogClient.debug(`Tool call rejected`, toolCallData);
    } else {
      if (
        interruptData &&
        interruptData.interruptResponse &&
        interruptData.interruptResponse.type === "modify"
      ) {
        const iResponse = interruptData.interruptResponse;
        Object.keys(iResponse.newArguments).forEach((argName) => {
          const index = handler.params.indexOf(argName);
          if (index !== -1) {
            params[index] = iResponse.newArguments[argName];
          }
        });
      }
      await callHook({
        callbacks: ctx.callbacks,
        name: "onToolCallStart",
        data: { toolName: handler.name, args: params },
      });

      // todo do we want to pass an existing message thread
      // into tool calls
      params.push({
        ctx,
        threads: new ThreadStore(),
        interruptData,
        isToolCall: true,
      });

      const toolCallStartTime = performance.now();
      result = await handler.execute(...params);
      result =
        result || `${handler.name} ran successfully but did not return a value`;

      const toolCallEndTime = performance.now();
      await callHook({
        callbacks: ctx.callbacks,
        name: "onToolCallEnd",
        data: {
          toolName: handler.name,
          result,
          timeTaken: toolCallEndTime - toolCallStartTime,
        },
      });

      ctx.statelogClient.toolCall({
        toolName: handler.name,
        args: params,
        output: result,
        model: JSON.stringify(clientConfig.model),
        timeTaken: toolCallEndTime - toolCallStartTime,
      });

      if (isInterrupt(result)) {
        return {
          isInterrupt: true,
          interrupt: {
            ...result,
            interruptData: {
              messages: messages.toJSON().messages,
              toolCall,
            },
          },
          messages,
        };
      }

      messages.push(
        smoltalk.toolMessage(result, {
          tool_call_id: toolCall.id,
          name: toolCall.name,
        }),
      );
    }
  }

  return { isInterrupt: false, messages };
}

export async function runPrompt(args: {
  ctx: RuntimeContext<GraphState>;
  prompt: string;
  messages: MessageThread;
  responseFormat?: any;
  tools?: Tool[];
  toolHandlers?: ToolHandler[];
  clientConfig: Partial<smoltalk.SmolPromptConfig>;
  stream?: boolean;
  maxToolCallRounds?: number;
  interruptData?: InterruptData;
}): Promise<any> {
  const {
    ctx,
    prompt,
    responseFormat,
    tools,
    toolHandlers = [],
    stream = false,
    maxToolCallRounds = 10,
  } = args;
  const clientConfig = ctx.getSmoltalkConfig(args.clientConfig || {});
  // console.log(color.magenta(JSON.stringify(clientConfig, null, 2)) + "\n");
  /* in order, either:
  1. restore messages from interruptData if present (resuming after an interrupt)
  2. use messages passed in as argument (add onto message thread)
  3. create an empty message thread just for this prompt
  */
  let messages: MessageThread;

  if (args.interruptData?.messages) {
    messages = MessageThread.fromJSON(args.interruptData.messages);
  } else if (clientConfig.messages) {
    messages = MessageThread.fromJSON(
      clientConfig.messages
        .map((m) => m.toJSON())
        .map((m) => smoltalk.messageFromJSON(m)),
    );
  } else if (args.messages) {
    messages = args.messages;
  } else {
    messages = new MessageThread();
  }
  // Restore state after interrupt
  let toolCalls: smoltalk.ToolCallJSON[] = [];

  if (args.interruptData === undefined) {
    // not resuming after an interrupt
    messages.push(smoltalk.userMessage(prompt));

    const result = await _runPrompt({
      ctx,
      messages,
      tools: tools || [],
      prompt,
      responseFormat,
      stream,
      clientConfig,
    });
    messages = result.messages;
    toolCalls = result.toolCalls;
  } else {
    if (!args.interruptData.toolCall) {
      throw new Error(
        `Interrupt data is present but no tool call found. This shouldn't happen: ${JSON.stringify(args.interruptData)}`,
      );
    }
    toolCalls = [args.interruptData.toolCall];
  }

  // Handle tool calls
  let toolCallRound = 0;
  while (toolCalls.length > 0) {
    if (toolCallRound++ >= maxToolCallRounds) {
      throw new Error(
        `Exceeded maximum tool call rounds (${maxToolCallRounds})`,
      );
    }

    const executeToolCallsResult = await executeToolCalls({
      toolCalls,
      toolHandlers,
      messages,
      ctx,
      clientConfig,
      interruptData: args.interruptData,
    });

    messages = executeToolCallsResult.messages;
    if (executeToolCallsResult.isInterrupt) {
      const { interrupt } = executeToolCallsResult;

      ctx.statelogClient.debug(`Tool call interrupted execution.`, {
        messages: messages.getMessages(),
        model: clientConfig.model,
      });

      // @ts-ignore
      ctx.stateStack.nodesTraversed = ctx.graph.getNodesTraversed();
      interrupt.state = ctx.stateStack.toJSON();
      return interrupt;
    }

    const result = await _runPrompt({
      ctx,
      messages,
      tools: tools || [],
      prompt,
      responseFormat,
      stream,
      clientConfig,
    });
    messages = result.messages;
    toolCalls = result.toolCalls;
  }

  const responseMessage = messages.getMessages().at(-1);

  if (!responseMessage) {
    throw new Error(
      `No response message found after running prompt! This shouldn't happen. Messages: ${JSON.stringify(
        messages.getMessages(),
      )}`,
    );
  }

  if (responseFormat) {
    try {
      const rawResult = JSON.parse(responseMessage.content || "");
      const extracted = extractResponse(rawResult, responseFormat);
      return extracted;
    } catch (e) {
      try {
        const extracted = extractResponse(
          responseMessage.content,
          responseFormat,
        );
        return extracted;
      } catch (e) {
        return responseMessage.content;
      }
    }
  }

  return responseMessage.content;
}
