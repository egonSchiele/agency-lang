import * as smoltalk from "smoltalk";
import { MessageThread } from "./state/messageThread.js";
import {
  interrupt,
  Interrupt,
  InterruptData,
  isInterrupt,
  isRejected,
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
import { ToolCallError } from "./errors.js";

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
  clientConfig,
}: {
  ctx: RuntimeContext<GraphState>;
  messages: MessageThread;
  tools: Tool[];
  prompt: string;
  responseFormat?: any;
  clientConfig: Partial<smoltalk.SmolPromptConfig>;
}): Promise<{ messages: MessageThread; toolCalls: smoltalk.ToolCallJSON[] }> {
  const stream = !!(clientConfig as any)?.stream;
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
    globals: ctx.globals,
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
  removedTools,
  toolErrorCounts,
}: {
  toolCalls: smoltalk.ToolCallJSON[];
  toolHandlers: ToolHandler[];
  messages: MessageThread;
  ctx: RuntimeContext<GraphState>;
  clientConfig: Partial<smoltalk.SmolPromptConfig>;
  interruptData?: InterruptData;
  removedTools: string[];
  toolErrorCounts: Record<string, number>;
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

    // Without this, if the LLM makes multiple tool calls to the same tool in the same message,
    // we keep calling the tool even though it's been removed
    if (removedTools.includes(handler.name)) {
      messages.push(
        smoltalk.toolMessage(
          `Error: Handler for tool call ${handler.name} has been removed already due to previous errors, and will not be executed.`,
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
      try {
        result = await handler.execute(...params);
      } catch (error: unknown) {
        const retryable =
          error instanceof ToolCallError ? error.retryable : false;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        toolErrorCounts[handler.name] =
          (toolErrorCounts[handler.name] || 0) + 1;

        if (retryable && toolErrorCounts[handler.name] < 5) {
          messages.push(
            smoltalk.toolMessage(
              `Error: ${errorMessage}. You may retry this tool call with corrected arguments.`,
              {
                tool_call_id: toolCall.id,
                name: toolCall.name,
              },
            ),
          );
        } else if (retryable) {
          messages.push(
            smoltalk.toolMessage(
              `Error: ${errorMessage}. This tool has failed too many times and can no longer be called.`,
              {
                tool_call_id: toolCall.id,
                name: toolCall.name,
              },
            ),
          );
          removedTools.push(handler.name);
        } else {
          messages.push(
            smoltalk.toolMessage(
              `Error: ${errorMessage}. This tool failed after performing side effects and cannot be retried.`,
              {
                tool_call_id: toolCall.id,
                name: toolCall.name,
              },
            ),
          );
          removedTools.push(handler.name);
        }
        continue;
      }
      if (isRejected(result)) {
        const message =
          typeof result.value === "string"
            ? result.value
            : "Tool call rejected by policy";
        messages.push(
          smoltalk.toolMessage(message, {
            tool_call_id: toolCall.id,
            name: toolCall.name,
          }),
        );
        continue;
      }

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
  clientConfig: Partial<smoltalk.SmolPromptConfig> & { tools?: any[] };
  maxToolCallRounds?: number;
  interruptData?: InterruptData;
  removedTools?: string[];
}): Promise<any> {
  const {
    ctx,
    prompt,
    responseFormat,
    maxToolCallRounds = 10,
    removedTools = [],
  } = args;

  // Extract tool registry entries from clientConfig.tools and split into
  // definitions (for smoltalk) and handlers (for execution).
  const toolEntries: { definition: Tool; handler: ToolHandler }[] = (
    args.clientConfig?.tools || []
  ).map((entry: any) => entry);
  let tools = toolEntries
    .map((e) => e.definition)
    .filter((t) => !removedTools.includes(t.name));
  let toolHandlers = toolEntries
    .map((e) => e.handler)
    .filter((h) => !removedTools.includes(h.name));

  // Remove tools key from clientConfig before passing to smoltalk
  const { tools: _extractedTools, ...restClientConfig } =
    args.clientConfig || {};
  const clientConfig = ctx.getSmoltalkConfig(restClientConfig);
  /* in order, either:
  1. restore messages from interruptData if present (resuming after an interrupt)
  2. use messages passed in as argument (add onto message thread)
  3. create an empty message thread just for this prompt
  */
  let messages: MessageThread;

  if (args.interruptData?.messages) {
    messages = MessageThread.fromJSON(args.interruptData.messages);
  } else if (clientConfig.messages) {
    messages = MessageThread.fromJSON(clientConfig.messages);
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
  const toolErrorCounts: Record<string, number> = {};
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
      removedTools,
      toolErrorCounts,
    });

    messages = executeToolCallsResult.messages;

    // Filter out tools that failed after side effects
    tools = tools.filter((t) => !removedTools.includes(t.name));
    toolHandlers = toolHandlers.filter((h) => !removedTools.includes(h.name));

    if (executeToolCallsResult.isInterrupt) {
      const { interrupt } = executeToolCallsResult;

      ctx.statelogClient.debug(`Tool call interrupted execution.`, {
        messages: messages.getMessages(),
        model: clientConfig.model,
      });

      const checkpointId = ctx.checkpoints.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      interrupt.checkpointId = checkpointId;
      interrupt.checkpoint = ctx.checkpoints.get(checkpointId);
      return interrupt;
    }

    const result = await _runPrompt({
      ctx,
      messages,
      tools: tools || [],
      prompt,
      responseFormat,
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
