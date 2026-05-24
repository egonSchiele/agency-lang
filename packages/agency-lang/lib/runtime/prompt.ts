import * as smoltalk from "smoltalk";
import { PromptResult, Result, StreamChunk, ToolCallJSON } from "smoltalk";
import { createLogger } from "../logger.js";
import { AgencyFunction } from "./agencyFunction.js";
import { AgencyCancelledError, isAbortError } from "./errors.js";
import { callHook, invokeCallbacks } from "./hooks.js";
import { hasInterrupts, isRejected } from "./interrupts.js";
import type { PromptConfig } from "./llmClient.js";
import { setupFunction } from "./node.js";
// See docs/dev/promptRunner.md for the control-flow abstraction used here.
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

/** Result of `_runPrompt`. Callback bodies cannot raise interrupts
 *  (typechecker-enforced), so the result is always a plain `{messages,
 *  toolCalls}` shape — the LLM hooks (onLLMCallStart, onLLMCallEnd)
 *  fire as side effects only. */
export type RunPromptResult = {
  messages: MessageThread;
  toolCalls: smoltalk.ToolCallJSON[];
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

  await callHook({
    ctx,
    name: "onLLMCallStart",
    data: {
      prompt,
      tools,
      model: clientConfig.model,
      messages: messages.toJSON().messages,
    },
  });

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

  // Enforce active guards. Walked innermost-first so the deepest
  // (most recently pushed) guard reports its trip first. Innermost-
  // first is not the same as "smallest limit first" — a shallower
  // outer guard with a tighter budget would still trip on a later LLM
  // call if the inner guard doesn't fail first. This ordering is a
  // stable, scope-local rule rather than a global-minimum search.
  // The thrown GuardExceededError propagates up through _runPrompt /
  // runPrompt / the user's code; the stdlib `guard` function's `try`
  // catches it and returns a Failure. The function-body auto-wrap re-
  // throws GuardExceededError so it cannot be silently converted to a
  // generic failure value. See lib/runtime/guard.ts and
  // docs/superpowers/specs/2026-05-20-cost-and-guard-tracking-design.md.
  for (let i = targetStack.guards.length - 1; i >= 0; i--) {
    const err = targetStack.guards[i].check(targetStack);
    if (err) throw err;
  }

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

  await callHook({
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

  return { messages, toolCalls };
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

  let shouldPop = true;
  try {
  // Initial LLM call wrapped in pr.step so it's idempotent on resume
  // (re-entries after a later tool-batch bailout skip this step).
  await pr.step("initialLlmCall", async () => {
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

    // Inner helper for the per-branch tool invocation. Extracted from
    // the pr.parallel branchFn so that arrow stays within the
    // max-lines-per-function lint budget. Closes over `ctx`, `messages`,
    // `stack`, `removedTools`, and `toolErrorCounts` — all of which it
    // mutates in place. Returns the outcome so the caller can update its
    // own `toolResult` / `invokeOutcome` locals (which are then read by
    // the surrounding tool-call branch code).
    const runInvokeStep = async (args: {
      handler: AgencyFunction;
      toolCall: smoltalk.ToolCallJSON;
      namedArgs: Record<string, any>;
      branchKey: string;
      branchStack: StateStack;
    }): Promise<{
      toolResult: any;
      invokeOutcome:
        | "success"
        | "failed"
        | "rejected"
        | "interrupted"
        | "crashed";
      interrupts?: any[];
    }> => {
      const { handler, toolCall, namedArgs, branchKey, branchStack } = args;
      let toolResult: any;
      ctx.enterToolCall();
      try {
        const toolThreads = new ThreadStore();
        toolThreads.setStatelogClient(ctx.statelogClient);
        toolResult = await handler.invoke(
          { type: "named", positionalArgs: [], namedArgs },
          { ctx, threads: toolThreads, stateStack: branchStack },
        );
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error(
          `Tool call "${handler.name}" crashed: ${errorMessage}`,
        );
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
        return { toolResult, invokeOutcome: "crashed" };
      } finally {
        ctx.exitToolCall();
      }

      if (isFailure(toolResult)) {
        const errorMessage =
          typeof toolResult.error === "string"
            ? toolResult.error
            : String(toolResult.error);
        toolErrorCounts[handler.name] =
          (toolErrorCounts[handler.name] || 0) + 1;
        ctx.statelogClient.error({
          errorType: "toolError",
          message: errorMessage,
          functionName: handler.name,
          retryable: !!toolResult.retryable,
        });
        if (toolResult.retryable && toolErrorCounts[handler.name] < 5) {
          messages.push(
            smoltalk.toolMessage(
              `Error: ${errorMessage}. You may retry this tool call with corrected arguments.`,
              { tool_call_id: toolCall.id, name: toolCall.name },
            ),
          );
        } else if (toolResult.retryable) {
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
        return { toolResult, invokeOutcome: "failed" };
      }

      if (isRejected(toolResult)) {
        const message =
          typeof toolResult.value === "string"
            ? toolResult.value
            : "Tool call rejected by policy";
        messages.push(
          smoltalk.toolMessage(message, {
            tool_call_id: toolCall.id,
            name: toolCall.name,
          }),
        );
        stack.deleteBranch(branchKey);
        return { toolResult, invokeOutcome: "rejected" };
      }

      if (hasInterrupts(toolResult)) {
        stack.setInterruptOnBranch(
          branchKey,
          toolResult[0].interruptId,
          toolResult[0].interruptData,
          toolResult[0].checkpoint,
        );
        return {
          toolResult,
          invokeOutcome: "interrupted",
          interrupts: toolResult,
        };
      }

      // Success: cache the result, push tool message.
      toolResult =
        toolResult ||
        `${handler.name} ran successfully but did not return a value`;
      stack.setResultOnBranch(branchKey, toolResult);
      messages.push(
        smoltalk.toolMessage(toolResult, {
          tool_call_id: toolCall.id,
          name: toolCall.name,
        }),
      );
      return { toolResult, invokeOutcome: "success" };
    };

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

      // Tool calls in one round run concurrently via pr.parallel. Each
      // tool gets its own BranchRunner. If any branch's `step` returns
      // interrupts, sibling branches still run to completion; pr.parallel
      // batches the collected interrupts, stamps ONE shared checkpoint,
      // and throws PromptBailout — bailout is caught at the outer try.
      //
      // `removedTools` and `toolErrorCounts` use eventually-consistent
      // semantics across branches (strategy B in the plan): same-round
      // removal is best-effort and removals always take effect from the
      // NEXT round (the .filter() after this parallel call).
      const parallelResult = await pr.parallel(
        `round.${round}.tools`,
        toolCalls,
        // keyFor: MUST match the branchKey the body uses below
        // (`stack.getOrCreateBranch(branchKey)`) so runBatch and the body
        // operate on the same branch.
        (toolCall) => `tool_${toolCall.id}`,
        async (toolCall, b) => {
          if (ctx.isCancelled(stateStack)) throw new AgencyCancelledError();

          const handler = toolFunctions.find(
            (fn) => fn.name === toolCall.name,
          );
          if (!handler) {
            await b.step(
              `round.${round}.tool.${toolCall.id}.unhandled`,
              async () => {
                console.error(
                  `No handler found for tool call: ${toolCall.name}. This error will be sent back to the LLM.`,
                );
                messages.push(
                  smoltalk.toolMessage(
                    `Error: No handler found for tool call ${toolCall.name}`,
                    { tool_call_id: toolCall.id, name: toolCall.name },
                  ),
                );
              },
            );
            return;
          }

          // Gated start (strategy B): if the tool is already in
          // removedTools (either from a prior round or from an earlier
          // sibling in this round that pushed first), skip with a
          // notice toolMessage.
          if (removedTools.includes(handler.name)) {
            await b.step(
              `round.${round}.tool.${toolCall.id}.removed`,
              async () => {
                messages.push(
                  smoltalk.toolMessage(
                    `Error: Handler for tool call ${handler.name} has been removed already due to previous errors, and will not be executed.`,
                    { tool_call_id: toolCall.id, name: toolCall.name },
                  ),
                );
              },
            );
            return;
          }

          const branchKey = `tool_${toolCall.id}`;
          // Note: a "cached result" short-circuit used to live here for
          // resume after a sibling interrupt; idempotency is now handled
          // uniformly by completedSteps inside b.step (start/invoke/end
          // each get marked done on success and skipped on resume).
          const branchStack = stack.getOrCreateBranch(branchKey).stack;
          const namedArgs = { ...toolCall.arguments };

          await b.step(
            `round.${round}.tool.${toolCall.id}.start`,
            async () => {
              // Pass `branchStack` so scoped callbacks registered inside
              // the branch's frame chain are discovered by
              // `gatherCallbacks`. Callback bodies cannot interrupt
              // (typechecker-enforced), so this is purely about scope
              // discovery, not interrupt routing.
              await invokeCallbacks({
                ctx,
                name: "onToolCallStart",
                data: { toolName: handler.name, args: namedArgs },
                stateStack: branchStack,
              });
            },
          );
          if (b.interrupts) return;

          const toolSpanId = ctx.statelogClient.startSpan("toolExecution");
          let toolResult: any;
          let invokeOutcome:
            | "success"
            | "failed"
            | "rejected"
            | "interrupted"
            | "crashed" = "success";

          // Persist the measured tool execution duration in
          // self.runnerState so resume (where the invoke step is
          // skipped) doesn't report ~0ms to onToolCallEnd /
          // statelogClient.toolCall. Keyed per tool call id; rides
          // along with completedSteps on the same frame.
          self.runnerState.toolTimings ??= {};
          // IMPORTANT: keep the toolExecution span open across the
          // invoke + end-hook + log steps so the toolCall event inherits
          // the toolExecution span_id (logsViewer aggregates tool
          // duration off that). try/finally guarantees we close it even
          // on bailout / unexpected throw.
          try {
            const toolCallStartTime = performance.now();
            // Invoke step: returns the interrupts when the tool halts
            // with them so BranchRunner.step can collect. All other
            // outcomes (success, failure, reject, crash) update outer
            // state in place via runInvokeStep; the step completes
            // (returns void unless interrupted) and is marked done so
            // resume skips this whole block.
            await b.step(
              `round.${round}.tool.${toolCall.id}.invoke`,
              async () => {
                const outcome = await runInvokeStep({
                  handler,
                  toolCall,
                  namedArgs,
                  branchKey,
                  branchStack,
                });
                toolResult = outcome.toolResult;
                invokeOutcome = outcome.invokeOutcome;
                if (outcome.invokeOutcome === "success") {
                  self.runnerState.toolTimings[toolCall.id] =
                    performance.now() - toolCallStartTime;
                }
                return outcome.interrupts;
              },
            );

            if (b.interrupts || invokeOutcome !== "success") return;

            // On resume after an end-hook bailout, the `invoke` step is
            // skipped and `toolResult` is undefined. Restore it from the
            // per-branch result that `setResultOnBranch` persisted before
            // the bailout, so the end-hook sees the actual tool output.
            if (toolResult === undefined) {
              toolResult = stack.getBranch(branchKey)?.result?.result;
            }

            // Reuse the persisted duration so onToolCallEnd /
            // statelogClient.toolCall always report the real exec time,
            // not the resume pass's overhead.
            const timeTaken: number =
              self.runnerState.toolTimings[toolCall.id] ?? 0;
            await b.step(
              `round.${round}.tool.${toolCall.id}.end`,
              async () => {
                // Same scope-discovery rationale as the .start hook.
                await invokeCallbacks({
                  ctx,
                  name: "onToolCallEnd",
                  data: {
                    toolName: handler.name,
                    result: toolResult,
                    timeTaken,
                  },
                  stateStack: branchStack,
                });
              },
            );
            // Wrap the toolCall log in its own b.step so it's idempotent
            // when pr.parallel re-runs a fully-completed branch on resume
            // (e.g. after a later `nextLlmCall` step bails). Without this
            // guard, every re-entry would emit a duplicate toolCall event.
            await b.step(
              `round.${round}.tool.${toolCall.id}.log`,
              async () => {
                ctx.statelogClient.toolCall({
                  toolName: handler.name,
                  args: namedArgs,
                  output: toolResult,
                  model: JSON.stringify(clientConfig.model),
                  timeTaken,
                });
              },
            );
          } finally {
            ctx.statelogClient.endSpan(toolSpanId);
          }
        },
      );

      // pr.parallel returns a RunBatchResult tagged union; if any tool
      // branch surfaced interrupts, runBatch already stamped the shared
      // checkpoint. Bail out of runPrompt with the merged batch — the
      // outer caller checkpoints / propagates as usual. (Replaces the
      // former PromptBailout throw with an explicit return so runBatch's
      // no-throw-Interrupt contract is preserved.)
      if (parallelResult.kind === "interrupts") {
        shouldPop = false;
        return parallelResult.interrupts;
      }

      // All tool calls complete — runBatch already popped branches on the
      // no-interrupt success path, but call again defensively in case any
      // branchFn-level cleanup added new branches mid-flight.
      stack.popBranches();
      tools = tools.filter((t) => !removedTools.includes(t.name));
      toolFunctions = toolFunctions.filter(
        (fn) => !removedTools.includes(fn.name),
      );

      // Next LLM call wrapped in pr.step for resume idempotency. Once
      // marked done, resume re-entries skip the LLM call.
      await pr.step(`round.${round}.nextLlmCall`, async () => {
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
        messages = nextResult.messages;
        toolCalls = nextResult.toolCalls;
        // Increment the round counter only after a successful LLM round,
        // so resume after a tool-batch interrupt re-enters the SAME round.
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
