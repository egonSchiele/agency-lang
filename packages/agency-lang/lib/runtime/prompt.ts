import * as smoltalk from "smoltalk";
import { PromptResult, Result, StreamChunk, ToolCallJSON } from "smoltalk";
import { AgencyFunction } from "./agencyFunction.js";
import { AgencyCancelledError, isAbortError } from "./errors.js";
import { callHook } from "./hooks.js";
import { Interrupt, hasInterrupts, isRejected } from "./interrupts.js";
import type { PromptConfig } from "./llmClient.js";
import { setupFunction } from "./node.js";
import { isFailure } from "./result.js";
import type { SourceLocationOpts } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import { MessageThread } from "./state/messageThread.js";
import { StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import { handleStreamingResponse } from "./streaming.js";
import { GraphState } from "./types.js";
import { extractResponse, updateTokenStats } from "./utils.js";

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
  stateStack,
}: {
  ctx: RuntimeContext<GraphState>;
  messages: MessageThread;
  tools: Tool[];
  prompt: string;
  responseFormat?: any;
  clientConfig: Partial<smoltalk.SmolConfig>;
  /** The branch-local stack, if this _runPrompt call is running inside a
   * fork/race branch. Used for branch-aware cancellation checks and for
   * scoping the LLM HTTP abort signal to the current branch. */
  stateStack?: StateStack;
}): Promise<{ messages: MessageThread; toolCalls: smoltalk.ToolCallJSON[] }> {
  if (ctx.isCancelled(stateStack)) {
    throw new AgencyCancelledError();
  }

  ctx.statelogClient.startSpan("llmCall");
  try { // try/finally for llmCall span
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
  if (ctx.isCancelled(stateStack)) {
    throw new AgencyCancelledError();
  }

  const promptConfig: PromptConfig = {
    ...clientConfig,
    messages: messages.getMessages(),
    tools,
    responseFormat,
    abortSignal: ctx.getAbortSignal(stateStack),
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
    usage: completion.usage,
    cost: completion.cost,
    stream,
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

  // Memory layer: auto-extraction and compaction run unconditionally
  // whenever a MemoryManager is attached (resolved decision #6).
  // Tool-call results have not been pushed yet, so we operate on the
  // current message slice. Compaction is a best-effort hint — failures
  // never break the LLM call.
  if (ctx.memoryManager) {
    try {
      const original = messages.getMessages();
      await ctx.memoryManager.onTurn(original);
      const plan = await ctx.memoryManager.compactIfNeeded(original);
      if (plan) {
        // Reassemble the thread from the ORIGINAL smoltalk Message
        // instances so tool_call metadata, ids, and other class-level
        // fields survive untouched.
        const head = plan.systemPrefixIndices.map((i) => original[i]);
        const tail = plan.tailIndices.map((i) => original[i]);
        const summary = smoltalk.systemMessage(plan.summaryMessageContent);
        messages.setMessages([...head, summary, ...tail]);
      }
    } catch (err) {
      console.warn(
        `[memory] post-turn hook failed: ${(err as Error).message}`,
      );
    }
  }

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
  } finally {
    ctx.statelogClient.endSpan(); // end llmCall span
  }
}

export async function runPrompt(args: {
  ctx: RuntimeContext<GraphState>;
  prompt: string;
  messages: MessageThread;
  responseFormat?: any;
  clientConfig: Partial<smoltalk.SmolConfig> & { tools?: any[] };
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
      ? {
        stateStack: args.stateStack,
        ctx: args.ctx,
        threads: new ThreadStore(),
      }
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
      const receivedType =
        entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry;
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
  let toolFunctions = agencyFunctions.filter(
    (fn) => !removedTools.includes(fn.name),
  );

  // Remove tools key from clientConfig before passing to smoltalk.
  // Also strip `memory` — it's a runtime-only directive that smoltalk
  // doesn't understand.
  const {
    tools: _extractedTools,
    memory: memoryOption,
    ...restClientConfig
  } = (args.clientConfig || {}) as Partial<smoltalk.SmolConfig> & {
    tools?: any[];
    memory?: boolean | { model?: string };
  };
  const clientConfig = ctx.getSmoltalkConfig(restClientConfig);

  // Restore or initialize messages.
  //
  // On resume we need `messages` to stay aliased to `args.messages` (the
  // caller's shared thread). Otherwise, mutations during the resumed run
  // (pushing tool responses, the final assistant message) won't propagate
  // back to the caller's thread. Then any subsequent reader — another
  // `llm()` call in a loop, a `thread {}` block, a debug hook — sees a
  // stale snapshot from the original interrupt time, missing everything
  // that was appended after resume.
  //
  // To keep the alias on resume, we write the saved JSON contents INTO
  // args.messages rather than constructing a fresh MessageThread. The
  // saved JSON and args.messages are equivalent on resume (both were
  // captured in the same checkpoint), so this is effectively a no-op
  // overwrite — but it preserves the alias for the rest of the run.
  let messages: MessageThread;
  if (self.messagesJSON) {
    const restored = MessageThread.fromJSON(self.messagesJSON);
    if (args.messages) {
      args.messages.setMessages(restored.getMessages());
      messages = args.messages;
    } else {
      messages = restored;
    }
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
    // Memory injection (resolved decision #6): only retrieves and
    // injects when the caller passed `memory: true` (or an object) on
    // this llm() call. Best-effort: failures don't block the LLM call.
    //
    // The injected system message is transient — it's for THIS llm()
    // call only and must not persist into the shared thread, otherwise
    // subsequent llm() calls would see stacked stale context blobs (and
    // recallForInjection would re-add a fresh one on top each turn).
    // We track the exact injected content so we can strip it after the
    // LLM call resolves, even if compaction (which can reshape indices)
    // ran inside _runPrompt.
    let injectedFactsContent: string | null = null;
    if (memoryOption && ctx.memoryManager) {
      try {
        const facts = await ctx.memoryManager.recallForInjection(prompt);
        if (facts) {
          injectedFactsContent = `Relevant context from memory:\n${facts}`;
          messages.push(smoltalk.systemMessage(injectedFactsContent));
        }
      } catch (err) {
        console.warn(
          `[memory] recall injection failed: ${(err as Error).message}`,
        );
      }
    }
    messages.push(smoltalk.userMessage(prompt));
    const result = await _runPrompt({
      ctx,
      messages,
      tools: tools || [],
      prompt,
      responseFormat,
      clientConfig,
      stateStack,
    });
    messages = result.messages;
    toolCalls = result.toolCalls;

    // Strip the transient memory injection (most recent matching system
    // message). If compaction inside _runPrompt already removed it, this
    // is a no-op.
    if (injectedFactsContent !== null) {
      const all = messages.getMessages();
      for (let i = all.length - 1; i >= 0; i--) {
        if (
          all[i].role === "system" &&
          all[i].content === injectedFactsContent
        ) {
          messages.setMessages([...all.slice(0, i), ...all.slice(i + 1)]);
          break;
        }
      }
    }

    // Save to frame (after stripping the injection so resume sees the
    // cleaned thread, not a duplicate-injection-on-resume).
    self.messagesJSON = messages.toJSON().messages;
    self.pendingToolCalls = toolCalls.length > 0 ? toolCalls : null;
  }

  let shouldPop = true;
  try {
    // Handle tool calls
    while (toolCalls.length > 0) {
      if (ctx.isCancelled(stateStack)) throw new AgencyCancelledError();
      if (self.toolCallRound++ >= maxToolCallRounds) {
        throw new Error(
          `Exceeded maximum tool call rounds (${maxToolCallRounds})`,
        );
      }

      const interrupts: Interrupt[] = [];

      for (const toolCall of toolCalls) {
        if (ctx.isCancelled(stateStack)) throw new AgencyCancelledError();

        const handler = toolFunctions.find((fn) => fn.name === toolCall.name);
        if (!handler) {
          console.error(
            `No handler found for tool call: ${toolCall.name}. This error will be sent back to the LLM.`,
          );
          messages.push(
            smoltalk.toolMessage(
              `Error: No handler found for tool call ${toolCall.name}`,
              { tool_call_id: toolCall.id, name: toolCall.name },
            ),
          );
          continue;
        }

        if (removedTools.includes(handler.name)) {
          messages.push(
            smoltalk.toolMessage(
              `Error: Handler for tool call ${handler.name} has been removed already due to previous errors, and will not be executed.`,
              { tool_call_id: toolCall.id, name: toolCall.name },
            ),
          );
          continue;
        }

        const branchKey = `tool_${toolCall.id}`;
        const existing = stack.getBranch(branchKey);

        // Skip completed branches (cached result from previous interrupt cycle).
        // The toolMessage was already pushed in the original run and restored
        // via messagesJSON, so we don't push it again here.
        if (existing?.result !== undefined) {
          continue;
        }

        // Note: there used to be a coarse short-circuit here that, when
        // existing.interruptId was set and the user's response was "reject",
        // pushed "tool call rejected" and removed the tool without
        // re-invoking it. That broke fork-in-tool: the tool branch only
        // tracks `result[0].interruptId`, so a reject of the first interrupt
        // ignored every per-interrupt response on sibling fork branches.
        //
        // Instead, we always re-invoke the tool on resume. Each inner
        // interrupt site reads its own response via ctx.getInterruptResponse
        // and either continues or halts with `failure("interrupt rejected")`.
        // - Simple tool, user rejected → tool returns the failure Result;
        //   the isFailure path below pushes "Error: interrupt rejected ..."
        //   and removes the tool. Same observable outcome as the old
        //   short-circuit, just routed through the failure path.
        // - Fork-in-tool with rejects → each branch produces success or
        //   failure independently; fork returns a mixed array; the tool
        //   returns it as a regular value. It's the agency author's job to
        //   detect embedded failures (e.g. with isFailure / isSuccess) and
        //   surface them to the LLM however they want.

        // Create or restore branch stack
        const branchStack = stack.getOrCreateBranch(branchKey).stack;

        const namedArgs = { ...toolCall.arguments };
        await callHook({
          callbacks: ctx.callbacks,
          name: "onToolCallStart",
          data: { toolName: handler.name, args: namedArgs },
        });

        const toolCallStartTime = performance.now();
        ctx.statelogClient.startSpan("toolExecution");
        let result: any;
        try { // try/finally for toolExecution span
        ctx.enterToolCall();
        try {
          const toolThreads = new ThreadStore();
          toolThreads.setStatelogClient(ctx.statelogClient);
          result = await handler.invoke(
            { type: "named", positionalArgs: [], namedArgs },
            {
              ctx,
              threads: toolThreads,
              stateStack: branchStack,
            },
          );
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error(`Tool call "${handler.name}" crashed: ${errorMessage}`);
          ctx.statelogClient.error({
            errorType: "toolError",
            message: errorMessage,
            functionName: handler.name,
            retryable: false,
          });
          toolErrorCounts[handler.name] =
            (toolErrorCounts[handler.name] || 0) + 1;
          messages.push(
            smoltalk.toolMessage(
              `Error: ${errorMessage}. This tool failed after performing side effects and cannot be retried.`,
              { tool_call_id: toolCall.id, name: toolCall.name },
            ),
          );
          removedTools.push(handler.name);
          stack.deleteBranch(branchKey);
          continue;
        } finally {
          ctx.exitToolCall();
        }

        // Tool returned a failure Result — handle retry logic
        if (isFailure(result)) {
          const errorMessage =
            typeof result.error === "string"
              ? result.error
              : String(result.error);
          toolErrorCounts[handler.name] =
            (toolErrorCounts[handler.name] || 0) + 1;
          ctx.statelogClient.error({
            errorType: "toolError",
            message: errorMessage,
            functionName: handler.name,
            retryable: !!result.retryable,
          });

          if (result.retryable && toolErrorCounts[handler.name] < 5) {
            messages.push(
              smoltalk.toolMessage(
                `Error: ${errorMessage}. You may retry this tool call with corrected arguments.`,
                { tool_call_id: toolCall.id, name: toolCall.name },
              ),
            );
          } else if (result.retryable) {
            messages.push(
              smoltalk.toolMessage(
                `Error: ${errorMessage}. This tool has failed too many times and can no longer be called.`,
                { tool_call_id: toolCall.id, name: toolCall.name },
              ),
            );
            removedTools.push(handler.name);
          } else {
            messages.push(
              smoltalk.toolMessage(
                `Error: ${errorMessage}. This operation failed and cannot be retried.`,
                { tool_call_id: toolCall.id, name: toolCall.name },
              ),
            );
            removedTools.push(handler.name);
          }
          stack.deleteBranch(branchKey);
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
          stack.deleteBranch(branchKey);
          continue;
        }

        // Check for interrupts
        // Note: interruptThrown is already emitted by interruptWithHandlers
        // when the interrupt propagates, so we don't emit it again here.
        if (hasInterrupts(result)) {
          interrupts.push(...result);
          stack.setInterruptOnBranch(
            branchKey,
            result[0].interruptId,
            result[0].interruptData,
            result[0].checkpoint,
          );
          continue;
        }

        // Success — cache result and add tool message
        result =
          result ||
          `${handler.name} ran successfully but did not return a value`;
        stack.setResultOnBranch(branchKey, result);

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
          args: namedArgs,
          output: result,
          model: JSON.stringify(clientConfig.model),
          timeTaken: toolCallEndTime - toolCallStartTime,
        });

        } finally { // end toolExecution span
          ctx.statelogClient.endSpan();
        }

        messages.push(
          smoltalk.toolMessage(result, {
            tool_call_id: toolCall.id,
            name: toolCall.name,
          }),
        );
        // Don't deleteBranch here. If a sibling tool in this same round
        // interrupts, the saved messagesJSON already contains this success's
        // toolMessage; on resume, the cached-result short-circuit relies on
        // `existing.result` being present to avoid re-invoking the tool.
        // popBranches() at the end of a successful round handles cleanup.
      }

      // If any tool calls interrupted, create checkpoint and return
      if (interrupts.length > 0) {
        self.messagesJSON = messages.toJSON().messages;
        const cpId = ctx.checkpoints.create(stateStack, ctx, {
          moduleId: checkpointInfo?.moduleId ?? "",
          scopeName: checkpointInfo?.scopeName ?? "",
          stepPath: checkpointInfo?.stepPath ?? "",
        });
        const cp = ctx.checkpoints.get(cpId)!;
        for (const intr of interrupts) {
          intr.checkpoint = cp;
          intr.checkpointId = cpId;
        }

        ctx.statelogClient.checkpointCreated({
          checkpointId: cpId,
          reason: "interrupt",
          sourceLocation: { moduleId: cp.moduleId, scopeName: cp.scopeName, stepPath: cp.stepPath },
        });
        ctx.statelogClient.debug(`Tool call interrupted execution.`, {
          messages: messages.getMessages(),
          model: clientConfig.model,
        });

        shouldPop = false;
        return interrupts;
      }

      // All tool calls complete — clean up branches, next LLM round
      stack.popBranches();
      tools = tools.filter((t) => !removedTools.includes(t.name));
      toolFunctions = toolFunctions.filter(
        (fn) => !removedTools.includes(fn.name),
      );

      const nextResult = await _runPrompt({
        ctx,
        messages,
        tools: tools || [],
        prompt,
        responseFormat,
        clientConfig,
        stateStack,
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
