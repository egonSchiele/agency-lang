import * as smoltalk from "smoltalk";
import { MessageThread } from "./state/messageThread.js";
import {
  Interrupt,
  hasInterrupts,
  isRejected,
} from "./interrupts.js";
import { updateTokenStats, extractResponse } from "./utils.js";
import { callHook } from "./hooks.js";
import { handleStreamingResponse, isGenerator } from "./streaming.js";
import type { RuntimeContext } from "./state/context.js";
import type { PromptConfig } from "./llmClient.js";
import type { SourceLocationOpts } from "./state/checkpointStore.js";
import { color } from "@/utils/termcolors.js";
import { GraphState } from "./types.js";
import { PromptResult, Result, StreamChunk, ToolCallJSON } from "smoltalk";
import { ZodType } from "zod/v3";
import { StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import { isFailure } from "./result.js";
import { AgencyCancelledError, isAbortError } from "./errors.js";
import { AgencyFunction } from "./agencyFunction.js";
import { setupFunction } from "./node.js";


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
  if (ctx.aborted) {
    throw new AgencyCancelledError();
  }

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

  // Re-check after hook — cancellation may have occurred during the callback
  if (ctx.aborted) {
    throw new AgencyCancelledError();
  }

  const promptConfig: PromptConfig = {
    ...clientConfig,
    messages: messages.getMessages(),
    tools,
    responseFormat,
    abortSignal: ctx.abortController.signal,
    metadata: clientConfig,
  } as any;

  let _completion: AsyncGenerator<StreamChunk> | Promise<Result<PromptResult>>;
  if (stream) {
    _completion = ctx.llmClient.textStream(promptConfig);
  } else {
    _completion = ctx.llmClient.text(promptConfig);
  }

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

export async function runPrompt(args: {
  ctx: RuntimeContext<GraphState>;
  prompt: string;
  messages: MessageThread;
  responseFormat?: any;
  clientConfig: Partial<smoltalk.SmolPromptConfig> & { tools?: any[] };
  maxToolCallRounds?: number;
  stateStack?: StateStack;
  removedTools?: string[];
  checkpointInfo?: SourceLocationOpts;
}): Promise<any> {
  const {
    ctx,
    prompt,
    responseFormat,
    maxToolCallRounds = 10,
    checkpointInfo,
  } = args;

  // Push a frame onto the state stack — runPrompt participates like any other function
  const { stateStack, stack } = setupFunction({
    state: args.stateStack
      ? { stateStack: args.stateStack, ctx: args.ctx, threads: new ThreadStore() }
      : undefined,
  });
  const self = stack.locals;

  // Frame-backed locals (survive checkpoint/restore)
  if (self.__initialized === undefined) {
    self.__initialized = true;
    self.removedTools = args.removedTools || [];
    self.toolErrorCounts = {};
    self.toolCallRound = 0;
    self.messagesJSON = null;
    self.pendingToolCalls = null;
  }

  const removedTools: string[] = self.removedTools;
  const toolErrorCounts: Record<string, number> = self.toolErrorCounts;

  const rawTools: any[] = args.clientConfig?.tools || [];
  const agencyFunctions: AgencyFunction[] = rawTools.map((entry: any) => {
    if (!AgencyFunction.isAgencyFunction(entry)) {
      const receivedType = entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry;
      throw new TypeError(
        `Invalid tool in clientConfig.tools. Expected an AgencyFunction instance, but received ${receivedType}.`,
      );
    }
    return entry;
  });
  let tools = agencyFunctions
    .filter((fn) => fn.toolDefinition)
    .map((fn) => fn.toolDefinition!)
    .filter((t) => !removedTools.includes(t.name));
  let toolFunctions = agencyFunctions
    .filter((fn) => !removedTools.includes(fn.name));

  // Remove tools key from clientConfig before passing to smoltalk
  const { tools: _extractedTools, ...restClientConfig } =
    args.clientConfig || {};
  const clientConfig = ctx.getSmoltalkConfig(restClientConfig);

  // Restore or initialize messages
  let messages: MessageThread;
  if (self.messagesJSON) {
    messages = MessageThread.fromJSON(self.messagesJSON);
  } else if (clientConfig.messages) {
    messages = MessageThread.fromJSON(clientConfig.messages);
  } else if (args.messages) {
    messages = args.messages;
  } else {
    messages = new MessageThread();
  }

  // Tool calls: restore from frame or make initial LLM call
  let toolCalls: smoltalk.ToolCallJSON[];
  if (self.pendingToolCalls) {
    toolCalls = self.pendingToolCalls;
  } else {
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
    // Save to frame
    self.messagesJSON = messages.toJSON().messages;
    self.pendingToolCalls = toolCalls.length > 0 ? toolCalls : null;
  }

  let shouldPop = true;
  try {
    // Handle tool calls
    while (toolCalls.length > 0) {
      if (ctx.aborted) throw new AgencyCancelledError();
      if (self.toolCallRound++ >= maxToolCallRounds) {
        throw new Error(`Exceeded maximum tool call rounds (${maxToolCallRounds})`);
      }

      if (!stack.branches) stack.branches = {};
      const interrupts: Interrupt[] = [];

      for (const toolCall of toolCalls) {
        if (ctx.aborted) throw new AgencyCancelledError();

        const handler = toolFunctions.find((fn) => fn.name === toolCall.name);
        if (!handler) {
          console.error(`No handler found for tool call: ${toolCall.name}. This error will be sent back to the LLM.`);
          messages.push(smoltalk.toolMessage(
            `Error: No handler found for tool call ${toolCall.name}`,
            { tool_call_id: toolCall.id, name: toolCall.name },
          ));
          continue;
        }

        if (removedTools.includes(handler.name)) {
          messages.push(smoltalk.toolMessage(
            `Error: Handler for tool call ${handler.name} has been removed already due to previous errors, and will not be executed.`,
            { tool_call_id: toolCall.id, name: toolCall.name },
          ));
          continue;
        }

        const branchKey = `tool_${toolCall.id}`;
        const existing = stack.branches[branchKey];

        // Skip completed branches (cached result from previous interrupt cycle)
        if (existing?.result !== undefined) {
          messages.push(smoltalk.toolMessage(existing.result.result, {
            tool_call_id: toolCall.id,
            name: toolCall.name,
          }));
          continue;
        }

        // Check if this branch was interrupted and user rejected
        if (existing?.interruptId) {
          const response = ctx.getInterruptResponse(existing.interruptId);
          if (response?.type === "reject") {
            messages.push(smoltalk.toolMessage("tool call rejected", {
              tool_call_id: toolCall.id,
              name: toolCall.name,
            }));
            ctx.statelogClient.debug(`Tool call rejected`, {
              tool_call_id: toolCall.id,
              name: toolCall.name,
            });
            delete stack.branches[branchKey];
            continue;
          }
        }

        // Create or restore branch stack
        const branchStack = existing ? existing.stack : new StateStack();
        if (existing) branchStack.deserializeMode();
        else stack.branches[branchKey] = { stack: branchStack };

        const namedArgs = { ...toolCall.arguments };
        await callHook({
          callbacks: ctx.callbacks,
          name: "onToolCallStart",
          data: { toolName: handler.name, args: namedArgs },
        });

        const toolCallStartTime = performance.now();
        let result: any;
        ctx.enterToolCall();
        try {
          result = await handler.invoke(
            { type: "named", positionalArgs: [], namedArgs },
            { ctx, threads: new ThreadStore(), stateStack: branchStack, isForked: true },
          );
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`Tool call "${handler.name}" crashed: ${errorMessage}`);
          toolErrorCounts[handler.name] = (toolErrorCounts[handler.name] || 0) + 1;
          messages.push(smoltalk.toolMessage(
            `Error: ${errorMessage}. This tool failed after performing side effects and cannot be retried.`,
            { tool_call_id: toolCall.id, name: toolCall.name },
          ));
          removedTools.push(handler.name);
          delete stack.branches[branchKey];
          continue;
        } finally {
          ctx.exitToolCall();
        }

        // Tool returned a failure Result — handle retry logic
        if (isFailure(result)) {
          const errorMessage = typeof result.error === "string" ? result.error : String(result.error);
          toolErrorCounts[handler.name] = (toolErrorCounts[handler.name] || 0) + 1;

          if (result.retryable && toolErrorCounts[handler.name] < 5) {
            messages.push(smoltalk.toolMessage(
              `Error: ${errorMessage}. You may retry this tool call with corrected arguments.`,
              { tool_call_id: toolCall.id, name: toolCall.name },
            ));
          } else if (result.retryable) {
            messages.push(smoltalk.toolMessage(
              `Error: ${errorMessage}. This tool has failed too many times and can no longer be called.`,
              { tool_call_id: toolCall.id, name: toolCall.name },
            ));
            removedTools.push(handler.name);
          } else {
            messages.push(smoltalk.toolMessage(
              `Error: ${errorMessage}. This operation failed and cannot be retried.`,
              { tool_call_id: toolCall.id, name: toolCall.name },
            ));
            removedTools.push(handler.name);
          }
          delete stack.branches[branchKey];
          continue;
        }

        if (isRejected(result)) {
          const message = typeof result.value === "string" ? result.value : "Tool call rejected by policy";
          messages.push(smoltalk.toolMessage(message, {
            tool_call_id: toolCall.id,
            name: toolCall.name,
          }));
          delete stack.branches[branchKey];
          continue;
        }

        // Check for interrupts
        if (hasInterrupts(result)) {
          interrupts.push(...result);
          stack.branches[branchKey].interruptId = result[0]?.interruptId;
          continue;
        }

        // Success — cache result and add tool message
        result = result || `${handler.name} ran successfully but did not return a value`;
        stack.branches[branchKey].result = { result };

        const toolCallEndTime = performance.now();
        await callHook({
          callbacks: ctx.callbacks,
          name: "onToolCallEnd",
          data: { toolName: handler.name, result, timeTaken: toolCallEndTime - toolCallStartTime },
        });
        ctx.statelogClient.toolCall({
          toolName: handler.name,
          args: namedArgs,
          output: result,
          model: JSON.stringify(clientConfig.model),
          timeTaken: toolCallEndTime - toolCallStartTime,
        });

        messages.push(smoltalk.toolMessage(result, {
          tool_call_id: toolCall.id,
          name: toolCall.name,
        }));
        delete stack.branches[branchKey];
      }

      // If any tool calls interrupted, create checkpoint and return
      if (interrupts.length > 0) {
        self.messagesJSON = messages.toJSON().messages;
        const cpId = ctx.checkpoints.create(ctx, {
          moduleId: checkpointInfo?.moduleId ?? "",
          scopeName: checkpointInfo?.scopeName ?? "",
          stepPath: checkpointInfo?.stepPath ?? "",
        });
        const cp = ctx.checkpoints.get(cpId);
        for (const intr of interrupts) {
          intr.checkpoint = cp;
          intr.checkpointId = cpId;
        }

        ctx.statelogClient.debug(`Tool call interrupted execution.`, {
          messages: messages.getMessages(),
          model: clientConfig.model,
        });

        shouldPop = false;
        return interrupts;
      }

      // All tool calls complete — clean up branches, next LLM round
      stack.branches = {};
      tools = tools.filter((t) => !removedTools.includes(t.name));
      toolFunctions = toolFunctions.filter((fn) => !removedTools.includes(fn.name));

      const nextResult = await _runPrompt({
        ctx, messages, tools: tools || [], prompt, responseFormat, clientConfig,
      });
      messages = nextResult.messages;
      toolCalls = nextResult.toolCalls;

      // Save to frame
      self.messagesJSON = messages.toJSON().messages;
      self.pendingToolCalls = toolCalls.length > 0 ? toolCalls : null;
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw error;
  } finally {
    if (shouldPop) stateStack.pop();
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
