import { PromptResult, ToolCallJSON, UserContentInput } from "smoltalk";
import { abortableSleep } from "../stdlib/abortable.js";
import { AgencyCancelledError, makeAbortCause, readCause } from "./errors.js";
import { callHook } from "./hooks.js";
import type { NormalizedLLMError, PromptConfig } from "./llmClient.js";
import { decideRetry, enrichSchemaLimitationError } from "./llmRetry.js";
import type { LLMRetryReason, RetryPolicy } from "./llmRetry.js";
import { meteredDispatch } from "./recordPaidUsage.js";
import type { StateStack } from "./state/stateStack.js";
import type { RuntimeContext } from "./state/context.js";
import { handleStreamingResponse } from "./streaming.js";
import { GraphState } from "./types.js";

/** Dispatch the LLM request and extract `{completion, toolCalls}`,
 *  branching on the `stream` flag. Streaming uses `handleStreamingResponse`
 *  to accumulate chunks; non-streaming awaits the single response Promise.
 *  Throws on transport/protocol errors. */
export async function dispatchLLMRequest({
  ctx,
  promptConfig,
  prompt,
  stream,
  stateStack,
}: {
  ctx: RuntimeContext<GraphState>;
  promptConfig: PromptConfig;
  prompt: string | UserContentInput;
  stream: boolean;
  stateStack?: StateStack;
}): Promise<{ completion: PromptResult; toolCalls: ToolCallJSON[] }> {
  if (stream) {
    const streamGen = ctx.llmClient.textStream(promptConfig);
    const response = await handleStreamingResponse({
      ctx,
      completion: streamGen,
      prompt,
      stateStack,
    });
    if (!response) {
      throw new Error(`No completion returned from streaming LLM call! This shouldn't happen.`);
    }
    if (!response.success) {
      throw new Error(`Error getting completion from streaming response: ${response.error}`);
    }
    return {
      completion: response.value.completion,
      toolCalls: response.value.toolCalls,
    };
  }
  const response = await ctx.llmClient.text(promptConfig);
  if (!response.success) {
    throw new Error(`Error getting completion: ${response.error}`);
  }
  return {
    completion: response.value,
    toolCalls: response.value.toolCalls || [],
  };
}

/**
 * Bound one LLM-call attempt by a per-call deadline. Returns a signal that
 * aborts (carrying a `callTimeout` cause) after `limitMs`, composed with the
 * parent (guard / Esc) signal so either source cancels the call. `limitMs <= 0`
 * means "no deadline" — the parent signal passes through unchanged. Structurally
 * a `TimeGuard`, scoped to a single call rather than a block.
 */
export function armCallTimeout(
  parentSignal: AbortSignal | undefined,
  limitMs: number,
): { signal: AbortSignal | undefined; dispose: () => void } {
  if (limitMs <= 0) {
    return { signal: parentSignal, dispose: () => {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new AgencyCancelledError(
        `llm call exceeded ${limitMs}ms`,
        makeAbortCause({ kind: "callTimeout", limitMs }),
      ),
    );
  }, limitMs);

  let signal: AbortSignal;
  if (parentSignal) {
    signal = AbortSignal.any([parentSignal, controller.signal]);
  } else {
    signal = controller.signal;
  }

  return {
    signal,
    dispose: () => clearTimeout(timer),
  };
}

type RetryHooks = {
  onRetry: (d: {
    attempt: number;
    maxRetries: number;
    delayMs: number;
    reason: LLMRetryReason;
    detail: string;
  }) => void | Promise<void>;
  onTimeout: (d: { limitMs: number; attempt: number }) => void | Promise<void>;
};

/**
 * Run `dispatch(signal)` under the retry policy. Each attempt is bounded by a
 * per-call timeout (armCallTimeout). On a classified-transient failure with
 * attempts remaining, fire onLLMRetry and wait a cancellable backoff, then
 * re-issue. A user/abort cause is always re-thrown untouched (never retried);
 * an exhausted provider error is converted by the catch ladder into a normal
 * Failure (we throw a plain Error so `try llm(...)` can handle it, rather than
 * a branded abort that would unwind the whole run). The policy decision lives
 * in the pure `decideRetry`; this loop is the thin driver.
 */
export async function runWithRetry<T>(
  dispatch: (signal: AbortSignal | undefined) => Promise<T>,
  policy: RetryPolicy,
  parentSignal: AbortSignal | undefined,
  hooks: RetryHooks,
  normalizeError: (err: unknown) => NormalizedLLMError,
): Promise<T> {
  // Bound the loop so a buggy `decideRetry` (e.g. always returning `retry`)
  // can never spin forever. `policy.retries + 1` is the intended attempt
  // count (1 initial + N retries); the extra +1 belt-and-suspenders catches
  // an off-by-one before it becomes an infinite loop.
  const maxAttempts = policy.retries + 2;
  let attempt = 0;
  while (attempt < maxAttempts) {
    const { signal, dispose } = armCallTimeout(parentSignal, policy.timeout);
    try {
      const result = await dispatch(signal);
      dispose();
      return result;
    } catch (err) {
      dispose();

      // The user (parent) abort ALWAYS wins a race with our own call timer.
      // If the parent aborted for any reason OTHER than a callTimeout
      // (userInterrupt / guardTrip / raceLoser / ...), surface the parent's
      // cause — not whatever `err` happens to be — so a callTimeout that
      // raced ahead never masks the real cancel reason.
      if (parentSignal?.aborted) {
        const parentCause = readCause(parentSignal);
        if (parentCause && parentCause.kind !== "callTimeout") {
          throw new AgencyCancelledError(undefined, parentCause);
        }
      }

      const cause = readCause(err);
      if (cause?.kind === "callTimeout") {
        await hooks.onTimeout({ limitMs: cause.limitMs, attempt });
      }

      const normalized = normalizeError(err);
      const decision = decideRetry(err, normalized, attempt, policy);

      if (decision.kind === "propagate") {
        // A user/abort cause re-throws untouched (cancel).
        throw err;
      }
      if (decision.kind === "terminal") {
        // A terminal provider error (e.g. content policy / 4xx) is a plain
        // Error → the function/node catch ladder converts it to a Failure.
        // Known schema-limitation 400s are rethrown with actionable
        // guidance (#487) — the raw provider text names zod internals.
        throw enrichSchemaLimitationError(err) ?? err;
      }
      if (decision.kind === "surfaceFailure") {
        // Retries exhausted. Surface a plain Error (NOT an AgencyAbort) so the
        // catch ladder converts it to a handleable Failure rather than aborting
        // the run — this is what `try llm(...)` catches. The +1 in
        // `attempt + 1` makes "1 attempt" read correctly when retries:0.
        const attempts = attempt + 1;
        throw new Error(
          `LLM call failed after ${attempts} ${attempts === 1 ? "attempt" : "attempts"} (${decision.reason}): ${decision.detail}`,
        );
      }

      // decision.kind === "retry"
      await hooks.onRetry({
        attempt: attempt + 1,
        maxRetries: policy.retries,
        delayMs: decision.delayMs,
        reason: decision.reason,
        detail: decision.detail,
      });
      // Esc during the wait throws → aborts the loop with the user cancel.
      await abortableSleep(decision.delayMs, parentSignal);
    }
    attempt += 1;
  }
  // Defensive: the loop body always either returns or throws above. Reaching
  // here means `decideRetry` repeatedly returned `retry` past `maxAttempts`,
  // which would be a programming error.
  throw new Error(`runWithRetry exceeded ${maxAttempts} attempts without resolving`);
}

/**
 * One LLM dispatch wrapped in the retry loop: builds the provider-neutral
 * error normalizer (from the active client) and the notification hooks, then
 * runs `dispatchLLMRequest` under `runWithRetry`. Kept out of `_runPrompt` so
 * that function stays focused.
 */
export async function dispatchWithRetry(args: {
  ctx: RuntimeContext<GraphState>;
  promptConfig: PromptConfig;
  prompt: string | UserContentInput;
  stream: boolean;
  retryPolicy: RetryPolicy;
  parentSignal: AbortSignal | undefined;
  stateStack?: StateStack;
}): Promise<{ completion: PromptResult; toolCalls: ToolCallJSON[] }> {
  const { ctx, promptConfig, prompt, stream, retryPolicy, parentSignal, stateStack } = args;

  const normalizeError = (err: unknown): NormalizedLLMError => {
    if (ctx.llmClient.normalizeError) {
      return ctx.llmClient.normalizeError(err);
    }
    if (err instanceof Error) {
      return { message: err.message };
    }
    return { message: String(err) };
  };

  const retryHooks = {
    onRetry: (data: {
      attempt: number;
      maxRetries: number;
      delayMs: number;
      reason: LLMRetryReason;
      detail: string;
    }) => callHook({ ctx, name: "onLLMRetry", data }),
    onTimeout: (data: { limitMs: number; attempt: number }) =>
      callHook({ ctx, name: "onLLMTimeout", data }),
  };

  const targetStack = stateStack ?? ctx.stateStack;
  return runWithRetry(
    (signal) =>
      meteredDispatch(ctx, targetStack, "completion", () =>
        dispatchLLMRequest({
          ctx,
          promptConfig: {
            ...promptConfig,
            abortSignal: signal,
          } as PromptConfig,
          prompt,
          stream,
          stateStack,
        }),
      ),
    retryPolicy,
    parentSignal,
    retryHooks,
    normalizeError,
  );
}
