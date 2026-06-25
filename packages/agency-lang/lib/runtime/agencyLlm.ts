/**
 * `agency.llm` — user-facing TS façade over `runPrompt`.
 *
 * Lets a TS helper issue an LLM call with full participation in the
 * surrounding agent run: cost tracking, the active LLM client, thread
 * accumulation, trace events, checkpoint integration. The codegen
 * emission for Agency-source `llm(...)` is unchanged — it continues to
 * call `runPrompt` directly with its own options shape (tools,
 * removedTools, etc.). Both paths converge inside `runPrompt`.
 *
 * Differences from the codegen path (intentional in v1):
 *  - **No tools.** The `__toolRegistry` is per-Agency-module and
 *    codegen-only; exposing it to TS would leak codegen internals
 *    into the public surface. If a TS helper needs LLM-driven tool
 *    dispatch, define the call as an Agency `def` (which gets the
 *    registry automatically) and invoke that `def` from TS.
 *  - **No `removedTools`, no `maxToolCallRounds`.** Those only make
 *    sense when tools are in play.
 *  - **`opts.model` overrides for THIS call only.** It does NOT
 *    mutate the active LLM client config — every subsequent call
 *    without `opts.model` uses the client's default. This is
 *    important: if the override "stuck" it would silently rebind the
 *    rest of the run to the wrong model.
 *
 * Cost tracking, thread accumulation, and trace events all flow
 * through `runPrompt` automatically — no extra wiring needed here.
 *
 * Throws if called outside an Agency frame. `runPrompt` reads
 * `ctx`/`stack`/`threads` from the active `agencyStore` frame; if no
 * frame is installed, `getRuntimeContext()` throws. TS callers must
 * run inside an Agency frame (either reached from generated code, or
 * wrapped explicitly with `agency.withTestContext` in unit tests).
 */
import type { z } from "zod";
import { agencyStore } from "./asyncContext.js";
import { runPrompt } from "./prompt.js";
import type { RetryConfig } from "./llmRetry.js";
import type { MessageThread } from "./state/messageThread.js";
import { getRuntimeContext } from "./asyncContext.js";

/**
 * Options for `agency.llm`. Extends `RetryConfig` (single source of truth for
 * `retries` / `timeout` / `backoff`, shared with `LlmDefaults` and the type-
 * checker's `llmOptions` shape) so adding a resilience field in one place
 * doesn't require updating three.
 */
export type LlmOpts<S extends z.ZodSchema = z.ZodSchema> = RetryConfig & {
  /** Override the model for this call only. Does NOT mutate the
   *  active LLM client config; the override applies to this single
   *  prompt. Subsequent `agency.llm` calls without `opts.model` use
   *  the client's default. */
  model?: string;
  /** Structured-output schema. Maps to `runPrompt`'s `responseFormat`.
   *  When set, the response is parsed and the call returns
   *  `z.infer<S>` instead of the raw string content. */
  schema?: S;
  /** Override the thread the prompt + response are appended to.
   *  Default: the active thread on the current `ThreadStore`. */
  thread?: MessageThread;
};

/** Module-private. Re-exposed only via `agency.llm`.
 *
 *  Overloads: when `opts.schema` is provided the return type is
 *  `z.infer<S>`; otherwise it's `string`. Order matters — the
 *  schema-bearing overload must come first so TS picks it over the
 *  string-returning fallback. */
export function llm<S extends z.ZodSchema>(
  prompt: string,
  opts: LlmOpts<S> & { schema: S },
): Promise<z.infer<S>>;
export function llm(prompt: string, opts?: LlmOpts): Promise<string>;
export async function llm(prompt: string, opts: LlmOpts = {}): Promise<any> {
  const thread = opts.thread ?? getRuntimeContext().threads.getOrCreateActive();
  // Build clientConfig with `model` only when explicitly overridden.
  // Passing `{ model: undefined }` would still let `runPrompt`'s merge
  // with smoltalkDefaults pick up the default, but being explicit keeps
  // the contract obvious: omit means "don't touch the model".
  const clientConfig: { model?: string } = {};
  if (opts.model !== undefined) clientConfig.model = opts.model;

  // Resilience options ride a dedicated `retryConfig` parameter (cleanly
  // separated from provider-shaped `clientConfig`). Pass even when all three
  // are undefined — `resolveRetryPolicy` uses `firstDefined` and just falls
  // through to branch defaults / built-ins.
  const retryConfig: RetryConfig = {
    retries: opts.retries,
    timeout: opts.timeout,
    backoff: opts.backoff,
  };

  return runPrompt({
    prompt,
    messages: thread,
    responseFormat: opts.schema,
    clientConfig,
    retryConfig,
    checkpointInfo: agencyStore.getStore()?.callsite,
  });
}
