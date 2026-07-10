import type { StatelogClient } from "../statelogClient.js";

/**
 * Wrap the onThreadEnd hook invocation with observability: a
 * `threadEndHooks` span (so hook-initiated LLM calls — the eager thread
 * summarizer — nest under an explanation of WHY they ran) and a
 * threadEndHooksStart/End event pair (so a hook that hangs before
 * reaching its own LLM call is still visible as an unpaired start).
 *
 * The end event and span close post from a finally: a throwing hook
 * still gets bracketed, and the error propagates to the caller
 * (Runner.thread's existing catch owns swallow-vs-rethrow policy).
 * The event posts are deliberately un-awaited, matching the
 * promptCompletion idiom — the file sink appends synchronously, so
 * on-disk ordering holds.
 *
 * Degrades to a bare fn() when the client is missing or lacks the new
 * methods: older test contexts construct partial statelog clients, and
 * this runs inside thread's finally, where a throw would mask the
 * primary exception.
 *
 * Extracted from Runner.thread so the bracket-on-throw and degraded-
 * client guarantees are unit-testable without constructing a Runner.
 */
export async function withThreadEndHooksEvents<T>(
  client: StatelogClient,
  payload: { threadId: string; eagerSummarize: boolean; messageCount: number },
  fn: () => Promise<T>,
): Promise<T> {
  // Degrade unless EVERY method the bracket uses is present: a client
  // with the start method but not the end method would otherwise throw
  // from the finally — exactly the mask-the-primary-exception hazard
  // this guard exists to prevent.
  const partial = client as any;
  if (
    !client ||
    typeof partial.threadEndHooksStart !== "function" ||
    typeof partial.threadEndHooksEnd !== "function" ||
    typeof partial.startSpan !== "function" ||
    typeof partial.endSpan !== "function"
  ) {
    return fn();
  }
  const spanId = client.startSpan("threadEndHooks");
  const startTime = performance.now();
  client.threadEndHooksStart(payload);
  try {
    return await fn();
  } finally {
    client.threadEndHooksEnd({
      threadId: payload.threadId,
      timeTaken: performance.now() - startTime,
    });
    client.endSpan(spanId);
  }
}
