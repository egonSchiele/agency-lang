import * as smoltalk from "smoltalk";
import { MessageThread } from "./state/messageThread.js";
import { isInterrupt } from "./interrupts.js";
import { updateTokenStats, extractResponse } from "./utils.js";
import { callHook } from "./hooks.js";
import { handleStreamingResponse, isGenerator } from "./streaming.js";
import type { RuntimeContext } from "./state/context.js";
import { color } from "@/utils/termcolors.js";
import { GraphState } from "./types.js";

export interface ToolHandler {
  name: string;
  params: string[];
  execute: (...args: any[]) => Promise<any>;
  isBuiltin: boolean;
}

export async function runPrompt(args: {
  ctx: RuntimeContext<GraphState>;
  statelogClient: any;
  graph: any;
  prompt: string;
  messages: MessageThread;
  responseFormat?: any;
  tools?: any[];
  toolHandlers?: ToolHandler[];
  clientConfig?: Record<string, any>;
  stream?: boolean;
  maxToolCallRounds?: number;
}): Promise<any> {
  const {
    ctx,
    statelogClient,
    graph,
    prompt,
    responseFormat,
    tools,
    toolHandlers = [],
    stream = false,
    maxToolCallRounds = 10,
  } = args;
  const messages = args.messages || new MessageThread();
  const clientConfig = ctx.getSmoltalkConfig(args.clientConfig || {});

  const startTime = performance.now();

  // Restore state after interrupt
  let toolCalls = ctx.stateStack.interruptData?.toolCall
    ? [ctx.stateStack.interruptData.toolCall]
    : [];
  const interruptResponse =
    ctx.stateStack.interruptData?.interruptResponse || null;

  let responseMessage: any;

  if (toolCalls.length === 0) {
    messages.push(smoltalk.userMessage(prompt));

    await callHook({
      callbacks: ctx.callbacks,
      name: "onLLMCallStart",
      data: { prompt, tools, model: clientConfig.model },
    });

    let completion: any = await (smoltalk.text as Function)({
      messages: messages.getMessages(),
      tools,
      responseFormat,
      stream,
      ...clientConfig,
    });

    const endTime = performance.now();

    if (stream) {
      completion = await handleStreamingResponse({
        ctx,
        completion,
        statelogClient,
        prompt,
        toolCalls,
      });
    }

    const modelName = completion.model || clientConfig.model || "unknown model";

    statelogClient.promptCompletion({
      messages: messages.getMessages(),
      completion,
      model: modelName,
      timeTaken: endTime - startTime,
      tools,
      responseFormat,
    });

    if (!completion.success) {
      throw new Error(
        `Error getting response from ${modelName}: ${completion.error}`,
      );
    }

    responseMessage = completion.value;
    toolCalls = responseMessage.toolCalls || [];

    if (toolCalls.length > 0) {
      messages.push(
        smoltalk.assistantMessage(responseMessage.output, {
          toolCalls,
        }),
      );
    }

    updateTokenStats({
      stateStack: ctx.stateStack,
      usage: responseMessage.usage,
      cost: responseMessage.cost,
    });
    await callHook({
      callbacks: ctx.callbacks,
      name: "onLLMCallEnd",
      data: {
        result: responseMessage,
        usage: responseMessage.usage,
        cost: responseMessage.cost,
        timeTaken: endTime - startTime,
      },
    });
  }

  // Handle tool calls
  let toolCallRound = 0;
  while (toolCalls.length > 0) {
    if (toolCallRound++ >= maxToolCallRounds) {
      throw new Error(
        `Exceeded maximum tool call rounds (${maxToolCallRounds})`,
      );
    }
    let haltExecution = false;
    let haltToolCall: any = {};
    let haltInterrupt: any = null;

    for (const toolCall of toolCalls) {
      const handler = toolHandlers.find((h) => h.name === toolCall.name);
      if (!handler) continue;

      const params = handler.params.map(
        (param: string) => toolCall.arguments[param],
      );
      const toolCallStartTime = performance.now();

      let result: any;
      if (interruptResponse && interruptResponse.type === "reject") {
        messages.push(
          smoltalk.toolMessage("tool call rejected", {
            tool_call_id: toolCall.id,
            name: toolCall.name,
          }),
        );
        statelogClient.debug(`Tool call rejected`, {
          tool_call_id: toolCall.id,
          name: toolCall.name,
        });
      } else {
        await callHook({
          callbacks: ctx.callbacks,
          name: "onToolCallStart",
          data: { toolName: handler.name, args: params },
        });

        result = await handler.execute(...params);
        result =
          result ||
          `${handler.name} ran successfully but did not return a value`;

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

        statelogClient.toolCall({
          toolName: handler.name,
          params,
          output: result,
          model: clientConfig.model,
          timeTaken: toolCallEndTime - toolCallStartTime,
        });

        if (isInterrupt(result)) {
          haltInterrupt = result;
          haltToolCall = {
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          };
          haltExecution = true;
          break;
        }

        messages.push(
          smoltalk.toolMessage(result, {
            tool_call_id: toolCall.id,
            name: toolCall.name,
          }),
        );
      }
    }

    if (haltExecution) {
      statelogClient.debug(`Tool call interrupted execution.`, {
        messages: messages.getMessages(),
        model: clientConfig.model,
      });

      ctx.stateStack.interruptData = {
        messages: messages.toJSON().messages,
        nodesTraversed: graph.getNodesTraversed(),
        toolCall: haltToolCall,
      };
      haltInterrupt.__state = ctx.stateStack.toJSON();
      return haltInterrupt;
    }

    const nextStartTime = performance.now();
    await callHook({
      callbacks: ctx.callbacks,
      name: "onLLMCallStart",
      data: { prompt, tools, model: clientConfig.model, toolCalls },
    });

    let completion: any = await (smoltalk.text as Function)({
      messages: messages.getMessages(),
      tools,
      responseFormat,
      stream,
      ...clientConfig,
    });

    const nextEndTime = performance.now();

    if (stream) {
      completion = await handleStreamingResponse({
        ctx,
        completion,
        statelogClient,
        prompt,
        toolCalls,
      });
    }

    const modelName = completion.model || clientConfig.model || "unknown model";

    statelogClient.promptCompletion({
      messages: messages.getMessages(),
      completion,
      model: modelName,
      timeTaken: nextEndTime - nextStartTime,
      tools,
      responseFormat,
    });

    if (!completion.success) {
      throw new Error(
        `Error getting response from ${modelName}: ${completion.error}`,
      );
    }
    responseMessage = completion.value;
    toolCalls = responseMessage.toolCalls || [];

    if (toolCalls.length > 0) {
      messages.push(
        smoltalk.assistantMessage(responseMessage.output, {
          toolCalls,
        }),
      );
    }

    updateTokenStats({
      stateStack: ctx.stateStack,
      usage: responseMessage.usage,
      cost: responseMessage.cost,
    });
    await callHook({
      callbacks: ctx.callbacks,
      name: "onLLMCallEnd",
      data: {
        result: responseMessage,
        usage: responseMessage.usage,
        cost: responseMessage.cost,
        timeTaken: nextEndTime - nextStartTime,
      },
    });
  }

  // Add final assistant response to history
  messages.push(smoltalk.assistantMessage(responseMessage.output));

  if (responseFormat) {
    try {
      const rawResult = JSON.parse(responseMessage.output || "");
      const extracted = extractResponse(rawResult, responseFormat);
      return extracted;
    } catch (e) {
      const extracted = extractResponse(responseMessage.output, responseFormat);
      return extracted;
    }
  }

  return responseMessage.output;
}
