import * as smoltalk from "smoltalk";
import { PromptResult, Result, StreamChunk, ToolCallJSON } from "smoltalk";
import { createLogger } from "../logger.js";
import { AgencyFunction } from "./agencyFunction.js";
import { AgencyCancelledError, isAbortError } from "./errors.js";
import { callHook } from "./hooks.js";
import { Interrupt, hasInterrupts, isRejected } from "./interrupts.js";
import type { PromptConfig } from "./llmClient.js";
import { setupFunction } from "./node.js";
import { PromptBailout, PromptRunner } from "./promptRunner.js";
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

/** Result of `_runPrompt`. `interrupt` carries interrupts raised by an
 *  `onLLMCallStart` or `onLLMCallEnd` callback so the outer `pr.step` can
 *  checkpoint and bail uniformly with the tool-interrupt path. */
export type RunPromptResult =
  | { kind: "ok"; messages: MessageThread; toolCalls: smoltalk.ToolCallJSON[] }
  | { kind: "interrupt"; interrupts: Interrupt[] };

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
}): Promise<RunPromptResult> {
  if (ctx.isCancelled(stateStack)) {
    throw new AgencyCancelledError();
  }

  // Note: the llmCall span is opened in the outer `runPrompt`, not here,
  // so that any tool executions triggered by this LLM response nest under
  // the same llmCall span (matching the design spec hierarchy
  // agentRun > nodeExecution > llmCall > toolExecution).
  const stream = !!(clientConfig as any)?.stream;
  const startTime = performance.now();

  const startInterrupts = await callHook({
    ctx,
    name: "onLLMCallStart",
    data: {
      prompt,
      tools,
      model: clientConfig.model,
      messages: messages.toJSON().messages,
    },
  });
  if (startInterrupts) return { kind: "interrupt", interrupts: startInterrupts };

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

  // Capture endTime AFTER the response has been fully received. The
  // request Promise is created above but only awaited inside the
  // stream/non-stream branches; sampling earlier would only measure
  // request setup, not the actual round-trip time.
  const endTime = performance.now();

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
    finishReason: (completion as any).finishReason ?? (completion as any).finish_reason,
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

  // Per-branch accumulator: in addition to the global __tokenStats above,
  // add cost/tokens to the active stack so std::thread's getCost()/getTokens()
  // can report per-branch totals. See docs/superpowers/specs/2026-05-20-
  // thread-builtins-and-stdlib-design.md for the model.
  const targetStack = stateStack ?? ctx.stateStack;
  targetStack.localCost += completion.cost?.totalCost ?? 0;
  targetStack.localTokens += completion.usage?.totalTokens ?? 0;

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
      // The memory hook is best-effort: a failure here must never
      // break the LLM call. Logged at `warn` so users see the failure
      // by default; the manager already emitted finer-grained debug
      // lines and a statelog `error` event if applicable.
      createLogger(ctx.logLevel).warn(
        `[memory] post-turn hook failed: ${(err as Error).message}`,
      );
    }
  }

  const endInterrupts = await callHook({
    ctx,
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
  if (endInterrupts) return { kind: "interrupt", interrupts: endInterrupts };

  return { kind: "ok", messages, toolCalls };
}

// eslint-disable-next-line max-lines-per-function -- core prompt execution loop; refactor tracked separately
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

  // Resumable-step + checkpoint-on-interrupt helper. See
  // docs/superpowers/plans/2026-05-22-prompt-runner.md.
  // `snapshotMessages` reads the current `messages` binding at call time;
  // reassignments below (e.g. `messages = result.messages`) are observed.
  const pr = new PromptRunner({
    self,
    ctx,
    stateStack,
    checkpointInfo,
    snapshotMessages: () => messages.toJSON().messages,
  });

  // Manage llmCall spans across the prompt round-trip loop. Each
  // llmCall span covers one `_runPrompt` call PLUS the tool executions
  // triggered by its returned tool_calls, so toolExecution spans nest
  // under their parent llmCall — matching the
  // agentRun > nodeExecution > llmCall > toolExecution hierarchy.
  let currentLlmSpanId: string | undefined;
  const closeLlmSpan = () => {
    if (currentLlmSpanId) {
      ctx.statelogClient.endSpan(currentLlmSpanId);
      currentLlmSpanId = undefined;
    }
  };

  // Tool calls: on resume, restore from frame; otherwise start at [] and
  // let the initialLlmCall step populate it.
  let toolCalls: smoltalk.ToolCallJSON[] = self.pendingToolCalls ?? [];

  // Initial LLM call wrapped in pr.step so any callback interrupts
  // (onLLMCallStart / onLLMCallEnd) bail uniformly. To keep the step
  // body idempotent on re-entry, we capture the messages length before
  // any mutation and revert if the body bails — this prevents duplicate
  // user / memory / assistant messages from accumulating across resumes.
  await pr.step("initialLlmCall", async () => {
    const lenBefore = messages.getMessages().length;
    let injectedFactsContent: string | null = null;
    if (memoryOption && ctx.memoryManager) {
      try {
        const facts = await ctx.memoryManager.recallForInjection(prompt);
        if (facts) {
          injectedFactsContent = `Relevant context from memory:\n${facts}`;
          messages.push(smoltalk.systemMessage(injectedFactsContent));
        }
      } catch (err) {
        createLogger(ctx.logLevel).warn(
          `[memory] recall injection failed: ${(err as Error).message}`,
        );
      }
    }
    messages.push(smoltalk.userMessage(prompt));
    currentLlmSpanId = ctx.statelogClient.startSpan("llmCall");
    let result: RunPromptResult;
    try {
      result = await _runPrompt({
        ctx,
        messages,
        tools: tools || [],
        prompt,
        responseFormat,
        clientConfig,
        stateStack,
      });
    } catch (e) {
      closeLlmSpan();
      throw e;
    }
    if (result.kind === "interrupt") {
      // Revert any messages pushed during this step (user message, memory
      // injection, and the assistant message pushed by _runPrompt) so
      // the bailout snapshot captures pre-step state. On resume, the
      // step body re-runs cleanly from that state.
      messages.setMessages(messages.getMessages().slice(0, lenBefore));
      closeLlmSpan();
      return result.interrupts;
    }
    messages = result.messages;
    toolCalls = result.toolCalls;
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
    self.messagesJSON = messages.toJSON().messages;
    self.pendingToolCalls = toolCalls.length > 0 ? toolCalls : null;
  });

  // After resume (initialLlmCall skipped), make sure there's an open
  // llmCall span if we have pending tool calls — the tool loop expects
  // one to be open so toolExecution spans nest correctly.
  if (toolCalls.length > 0 && currentLlmSpanId === undefined) {
    currentLlmSpanId = ctx.statelogClient.startSpan("llmCall");
  }

  let shouldPop = true;
  try {
    // Handle tool calls
    while (toolCalls.length > 0) {
      if (ctx.isCancelled(stateStack)) throw new AgencyCancelledError();
      if (self.toolCallRound >= maxToolCallRounds) {
        throw new Error(
          `Exceeded maximum tool call rounds (${maxToolCallRounds})`,
        );
      }
      // Capture round BEFORE incrementing so pr.step keys are stable
      // across resume. The actual increment happens inside the
      // `nextLlmCall` step body, after a successful LLM round — that
      // way bailout from a per-tool callback leaves the counter
      // unchanged and resume re-enters this iteration with the same
      // `round` value, so completedSteps keys match.
      const round = self.toolCallRound;

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
        await pr.step(
          `round.${round}.tool.${toolCall.id}.start`,
          async () =>
            await callHook({
              ctx,
              name: "onToolCallStart",
              data: { toolName: handler.name, args: namedArgs },
            }),
        );

        const toolCallStartTime = performance.now();
        const toolSpanId = ctx.statelogClient.startSpan("toolExecution");
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
        await pr.step(
          `round.${round}.tool.${toolCall.id}.end`,
          async () =>
            await callHook({
              ctx,
              name: "onToolCallEnd",
              data: {
                toolName: handler.name,
                result,
                timeTaken: toolCallEndTime - toolCallStartTime,
              },
            }),
        );
        ctx.statelogClient.toolCall({
          toolName: handler.name,
          args: namedArgs,
          output: result,
          model: JSON.stringify(clientConfig.model),
          timeTaken: toolCallEndTime - toolCallStartTime,
        });

        } finally { // end toolExecution span
          ctx.statelogClient.endSpan(toolSpanId);
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

      // If any tool calls interrupted, route through pr.step so the
      // checkpoint + bailout happen uniformly with every other interrupt
      // site. This step is unique — it always throws when reached, so
      // the completedSteps marker is irrelevant.
      if (interrupts.length > 0) {
        ctx.statelogClient.debug(`Tool call interrupted execution.`, {
          messages: messages.getMessages(),
          model: clientConfig.model,
        });
        await pr.step(
          `round.${round}.toolInterrupts`,
          async () => interrupts,
        );
        // unreachable — pr.step throws PromptBailout
      }

      // All tool calls complete — clean up branches, next LLM round
      stack.popBranches();
      tools = tools.filter((t) => !removedTools.includes(t.name));
      toolFunctions = toolFunctions.filter(
        (fn) => !removedTools.includes(fn.name),
      );

      // Next LLM call wrapped in pr.step. Same idempotency trick as
      // initialLlmCall: snapshot messages length pre-call and revert if
      // a callback inside _runPrompt returns interrupts.
      await pr.step(`round.${round}.nextLlmCall`, async () => {
        const lenBefore = messages.getMessages().length;
        closeLlmSpan();
        currentLlmSpanId = ctx.statelogClient.startSpan("llmCall");
        let nextResult: RunPromptResult;
        try {
          nextResult = await _runPrompt({
            ctx,
            messages,
            tools: tools || [],
            prompt,
            responseFormat,
            clientConfig,
            stateStack,
          });
        } catch (e) {
          closeLlmSpan();
          throw e;
        }
        if (nextResult.kind === "interrupt") {
          messages.setMessages(messages.getMessages().slice(0, lenBefore));
          closeLlmSpan();
          return nextResult.interrupts;
        }
        messages = nextResult.messages;
        toolCalls = nextResult.toolCalls;
        // Increment the round counter only after a successful LLM round,
        // so resume after a callback interrupt re-enters the SAME round.
        self.toolCallRound = round + 1;
        self.messagesJSON = messages.toJSON().messages;
        self.pendingToolCalls = toolCalls.length > 0 ? toolCalls : null;
      });
    }
  } catch (error) {
    if (error instanceof PromptBailout) {
      shouldPop = false;
      return error.interrupts;
    }
    if (isAbortError(error)) throw error;
    throw error;
  } finally {
    // Close any open llmCall span. This covers normal completion,
    // thrown errors, and early returns when tool calls interrupted
    // (the resumed run opens a fresh llmCall span). The helper is a
    // no-op if no span is currently open.
    closeLlmSpan();
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
