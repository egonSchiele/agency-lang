import * as smoltalk from "smoltalk";
import { PromptResult, ToolCallJSON, UserContentInput } from "smoltalk";
import { createLogger, type Logger } from "../logger.js";
import type { Run } from "./asyncContext.js";
import { AgencyCancelledError, isAbortError, readCause } from "./errors.js";
import { recordCompletionUsage } from "./recordPaidUsage.js";
import { projectProviderTokenUsage, type ProviderUsageKind } from "./invocationUsage.js";
import { resolveCompletionModel } from "./modelIdentity.js";
import type { RetryPolicy } from "./llmRetry.js";
import { dispatchWithRetry, usageKindFor } from "./llmDispatch.js";
import {
  emitPromptCompletion,
  emitPromptStart,
  redactMessagesForLog,
  redactPromptForLog,
} from "./promptEvents.js";
import type { DecisionLog } from "../statelog/wireTypes.js";
import { isGuardExceededError } from "./guard.js";
import { callHook } from "./hooks.js";
import { type PromptConfig } from "./llmClient.js";
import { GuardTripRetry, throwRetryForResumableTrip } from "./guardTripInterrupt.js";
import { failure } from "./result.js";
import type { RuntimeContext } from "./state/context.js";
import { MessageThread } from "./state/messageThread.js";
import { StateStack } from "./state/stateStack.js";
import { GraphState } from "./types.js";
import { buildReplyMessage, updateTokenStats } from "./utils.js";

/** One model request of an `llm()` call: send the thread, log the request
 *  and its completion, and append the reply. `runPrompt` in `prompt.ts`
 *  runs the tool loop around it. */

export type Tool = {
  name: string;
  description?: string;
  schema: any;
};

/** Result of `_runPrompt`. Callback bodies cannot raise interrupts
 *  (typechecker-enforced), so the result is always plain data — the LLM
 *  hooks (onLLMCallStart, onLLMCallEnd) fire as side effects only. */
export type RunPromptResult = {
  messages: MessageThread;
  toolCalls: smoltalk.ToolCallJSON[];
  /** Why this round ended, normalized by smoltalk across providers. */
  stopReason?: smoltalk.StopReason;
  /** How the round was booked: a text model's completion, or a decision
   *  model's answer. Set by `_runPrompt`; a direct-return path may omit it. */
  usageKind?: ProviderUsageKind;
};

/** In-flight visibility: record the request SHAPE before dispatch, so a
 *  call that never completes (hang, kill, runaway generation) still
 *  leaves a trace. Pairs with promptCompletion/llmError/promptCancelled
 *  by span + order. Un-awaited like promptCompletion (post() detaches
 *  the remote send; the file sink is a sync append). Called inside the
 *  same idempotent pr.step as the completion, so resumed runs do not
 *  double-emit for replayed steps. Retries inside dispatchWithRetry
 *  share the one start. */
/** The runtime's logger for a run: its level, writing to its host. */
export function ctxLogger(ctx: RuntimeContext<any>): Logger {
  return createLogger(ctx.logLevel, ctx.host.settings);
}

/** Turn a failed dispatch into the error `_runPrompt` should throw, logging
 *  the outcome on the way.
 *
 *  Cancellation normalization. When WE aborted the request (user pressed Esc →
 *  ctx.cancel(), a race loser, a timeout), the provider SDK surfaces its OWN
 *  abort error — e.g. Anthropic throws a plain `Error("Request was aborted.")`
 *  whose name isn't "AbortError", so `isAbortError` can't recognize it by
 *  identity. Our cancellation state is authoritative: if the call threw while
 *  we're cancelled, it's a cancellation. Normalize to AgencyCancelledError so
 *  the rest of the runtime (function/node catches re-throw it, the REPL prints
 *  "cancelled") handles it as one — and skip the llmError log, since a user
 *  cancel isn't a request failure worth recording.
 *
 *  Prefer the structured cause when present so the normalized error keeps its
 *  intent (guardTrip / userInterrupt / …); fall back to the isCancelled
 *  heuristic for provider errors that arrive with no cause. The cause object
 *  preserves identity (readCause off the error or the composed signal returns
 *  the SAME branded object the producer set), so the `delivered` de-dup flag
 *  stays shared across the two trip paths.
 *
 *  Returns rather than throws so the caller's `throw` keeps TypeScript's
 *  control flow honest. A resumable guard trip is the one exception: it throws
 *  `GuardTripRetry` from here and never returns. */
async function dispatchFailureToThrow(
  err: unknown,
  {
    run,
    stateStack,
    tools,
  }: {
    run: Run;
    stateStack: StateStack | undefined;
    tools: Tool[];
  },
): Promise<unknown> {
  const ctx = run.ctx as RuntimeContext<GraphState>;
  const cause = readCause(err) ?? readCause(ctx.getAbortSignal(stateStack));
  // Resumable trip? Throws GuardTripRetry and never returns.
  throwRetryForResumableTrip(cause, run, stateStack);
  if (cause || ctx.isCancelled(stateStack) || isAbortError(err)) {
    // Terminate the promptStart pair: a cancelled call (race loser, Esc,
    // timeout abort) is a NORMAL outcome, not a request failure — no
    // llmError — but leaving the start unpaired would make every healthy
    // race() render "never completed" warnings.
    run.log.promptCancelled({
      threadId: run.threads.activeId() ?? null,
    });
    return new AgencyCancelledError(undefined, cause);
  }
  try {
    await run.log.error({
      errorType: "llmError",
      message: err instanceof Error ? err.message : String(err),
      tools,
    });
  } catch {
    // ignore — never let logging shadow the original failure
  }
  return err;
}

/** Post-turn memory work: let the memory manager observe the completed turn
 *  and compact the thread if it has grown past its threshold. Skipped when a
 *  guard is already over budget, since memory's own LLM calls would spend
 *  past the cap. A memory failure is logged, not fatal — except a guard-
 *  exceeded error, which must keep unwinding. */
async function runPostTurnMemory(
  run: Run,
  targetStack: StateStack,
  messages: MessageThread,
): Promise<void> {
  if (targetStack.anyGuardOverBudget()) return;
  const memoryManager = run.ctx.getActiveMemoryManager(run.stack);
  if (!memoryManager) return;
  try {
    const original = messages.getMessages();
    await memoryManager.onTurn(run, original);
    const plan = await memoryManager.compactIfNeeded(run, original);
    if (plan) {
      // Reassemble the thread from the ORIGINAL smoltalk Message
      // instances so tool_call metadata, ids, and other class-level
      // fields survive untouched. Expiring messages from the compacted
      // range stay, after the summary, for their owners to remove.
      const pick = (indices: number[]) => indices.map((i) => original[i]);
      const summary = smoltalk.systemMessage(plan.summaryMessageContent);
      messages.setMessages([
        ...pick(plan.systemPrefixIndices),
        summary,
        ...pick(plan.keptIndices),
        ...pick(plan.tailIndices),
      ]);
    }
  } catch (err) {
    if (isGuardExceededError(err)) throw err;
    ctxLogger(run.ctx).warn(`[memory] post-turn hook failed: ${(err as Error).message}`);
  }
}

export async function _runPrompt({
  run,
  messages,
  tools,
  prompt,
  responseFormat,
  clientConfig,
  stateStack,
  retryPolicy,
  callLabel,
}: {
  run: Run;
  messages: MessageThread;
  tools: Tool[];
  prompt: string | UserContentInput;
  responseFormat?: any;
  clientConfig: Partial<smoltalk.SmolConfig>;
  /** The branch-local stack, if this _runPrompt call is running inside a
   * fork/race branch. Used for branch-aware cancellation checks and for
   * scoping the LLM HTTP abort signal to the current branch. */
  stateStack?: StateStack;
  retryPolicy: RetryPolicy;
  /** This call's `llm(label:)` debug tag (see `emitPromptStart`), or null. */
  callLabel?: string | null;
}): Promise<RunPromptResult> {
  const ctx = run.ctx as RuntimeContext<GraphState>;
  if (ctx.isCancelled(stateStack)) throw new AgencyCancelledError();

  // Pre-call cost-guard gate. If any active guard (including shared
  // parent guards inherited by this branch) is already over budget —
  // e.g. because a sibling branch's earlier LLM call pushed the shared
  // CostGuard over its limit, or because a prior call here did — refuse
  // to issue this call. Catches "another expensive call would have been
  // billed but we're already past the cap" before the request hits the
  // wire.
  const targetStack = stateStack ?? ctx.stateStack;
  targetStack.enforceGuards();

  // Note: the llmCall span is opened in the outer `runPrompt`, not here,
  // so that any tool executions triggered by this LLM response nest under
  // the same llmCall span (matching the design spec hierarchy
  // agentRun > nodeExecution > llmCall > toolExecution).
  const stream = !!(clientConfig as any)?.stream;
  const startTime = performance.now();

  await callHook(run, {
    name: "onLLMCallStart",
    data: {
      prompt: redactPromptForLog(prompt),
      tools,
      model: clientConfig.model,
      messages: redactMessagesForLog(messages),
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

  // "completion" for a text model; "decision" for a decision model, whose
  // call is booked under its own kind. See decision/dispatch.ts.
  const usageKind = usageKindFor(promptConfig);
  emitPromptStart({ run, messages, tools, responseFormat, clientConfig, callLabel, usageKind });

  let completion: PromptResult;
  let toolCalls: ToolCallJSON[];
  let decision: DecisionLog | undefined;
  try {
    ({ completion, toolCalls, decision } = await dispatchWithRetry({
      run,
      ctx,
      promptConfig,
      prompt,
      stream,
      retryPolicy,
      parentSignal: ctx.getAbortSignal(stateStack),
      stateStack,
    }));
  } catch (err) {
    throw await dispatchFailureToThrow(err, { run, stateStack, tools });
  }

  const endTime = performance.now();

  const modelName = resolveCompletionModel(completion.model, clientConfig.model);

  const projectedUsage = projectProviderTokenUsage(completion.usage, usageKind).usage;

  emitPromptCompletion({
    run,
    messages,
    completion,
    projectedUsage,
    modelName,
    timeTaken: endTime - startTime,
    tools,
    responseFormat,
    stream,
    usageKind,
    decision,
  });

  const reply = buildReplyMessage(completion, toolCalls, ctx.logLevel, ctx.host.settings);
  messages.push(reply, callLabel);

  updateTokenStats({
    globals: ctx.globals,
    usage: projectedUsage,
    cost: completion.cost,
    model: modelName,
  });

  recordCompletionUsage(ctx, targetStack, completion, clientConfig.model, usageKind);
  await runPostTurnMemory(run, targetStack, messages);

  await callHook(run, {
    name: "onLLMCallEnd",
    data: {
      model: modelName,
      result: completion,
      usage: completion.usage,
      cost: completion.cost,
      timeTaken: endTime - startTime,
      messages: redactMessagesForLog(messages),
    },
  });

  return { messages, toolCalls, stopReason: completion.stopReason, usageKind };
}
