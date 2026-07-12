import * as smoltalk from "smoltalk";
import {
  PromptResult,
  ToolCallJSON,
  UserContentInput,
  redactAttachments,
} from "smoltalk";
import { createLogger } from "../logger.js";
import { AgencyFunction, type FuncParam } from "./agencyFunction.js";
import { agencyStore, getRuntimeContext, __threads } from "./asyncContext.js";
import {
  harvestReplyAttachments,
  buildReplyUserMessage,
  appendReplyMarker,
  type HarvestedReplyAttachment,
} from "./replyAttachments.js";
import { AgencyCancelledError, isAbortError, makeAbortCause, readCause } from "./errors.js";
import { abortableSleep } from "../stdlib/abortable.js";
import { decideRetry, decideValidationRetry, enrichSchemaLimitationError, resolveRetryPolicy } from "./llmRetry.js";
import type { RetryPolicy, RetryConfig, LLMRetryReason } from "./llmRetry.js";
import type { NormalizedLLMError } from "./llmClient.js";
import {
  markThreadCancelled,
  needsThreadRepair,
} from "./threadRepair.js";
import { isGuardExceededError } from "./guard.js";
import { callHook, invokeCallbacks } from "./hooks.js";
import { hasInterrupts, isRejected } from "./interrupts.js";
import type { PromptConfig } from "./llmClient.js";
import { setupFunction } from "./node.js";
// See docs/dev/promptRunner.md for the control-flow abstraction used here.
import { PromptBailout, PromptRunner } from "./promptRunner.js";
import { failure, isFailure, isSuccess, markDestructiveWork } from "./result.js";
import type { SourceLocationOpts } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { LlmDefaults } from "../stdlib/llm.js";
import { MessageThread } from "./state/messageThread.js";
import { StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import { handleStreamingResponse } from "./streaming.js";
import { GraphState } from "./types.js";
import { extractStructuredResponse, updateTokenStats } from "./utils.js";

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

/** Flatten a prompt (a string, or an array of text/attachment parts) to plain
 *  text for consumers that require a string — e.g. memory recall and log
 *  previews. Attachments are dropped. Statelog does NOT use this: it keeps the
 *  structured prompt, redacted (see `redactMessagesForLog`). */
export function promptText(p: string | UserContentInput): string {
  if (typeof p === "string") return p;
  return p
    .map((x) => (typeof x === "string" ? x : x.type === "text" ? x.text : null))
    .filter((s): s is string => s !== null)
    .join(" ");
}

/** Deep copy of a thread's messages with attachment payloads (base64 / data
 *  URIs) redacted, for statelog. Uses `toJSON()` — the same plain shape
 *  `JSON.stringify` would emit — so wire consumers like
 *  `wireAccessors.userMessageOf` keep working. Redaction only shortens base64
 *  string values, so the result is still structurally `MessageJSON[]`. */
export function redactMessagesForLog(
  messages: MessageThread,
): smoltalk.MessageJSON[] {
  return redactAttachments(messages.toJSON().messages) as smoltalk.MessageJSON[];
}

/** A prompt with attachment payloads redacted, preserving its string-or-array
 *  shape, for statelog / hook data. */
export function redactPromptForLog(
  p: string | UserContentInput,
): string | UserContentInput {
  return redactAttachments(p) as string | UserContentInput;
}

/** Dispatch the LLM request and extract `{completion, toolCalls}`,
 *  branching on the `stream` flag. Streaming uses `handleStreamingResponse`
 *  to accumulate chunks; non-streaming awaits the single response Promise.
 *  Throws on transport/protocol errors. */
async function dispatchLLMRequest({
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
      throw new Error(
        `No completion returned from streaming LLM call! This shouldn't happen.`,
      );
    }
    if (!response.success) {
      throw new Error(
        `Error getting completion from streaming response: ${response.error}`,
      );
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

/** LLMs routinely emit an explicit `null` for an optional tool argument
 *  they chose not to set (e.g. `bash(command, cwd: null, timeout: null)`).
 *  Agency default-parameter values only fill `undefined`, so a `null` would
 *  sail past the default into the function body — `bash(cwd: null)` reaches
 *  `applyAgentCwd` → `path.resolve(base, null)` and throws. Drop any argument
 *  whose value is `null` when its parameter declares a default, so the call
 *  behaves exactly as if the LLM had omitted the key (the default applies).
 *  Params without a default keep their value untouched: a required arg passed
 *  `null` still surfaces its normal type error for the model to correct, and
 *  an intentionally-nullable param is left alone. */
function dropNullDefaultedArgs(
  args: Record<string, any> | null | undefined,
  params: readonly FuncParam[],
): Record<string, any> {
  const out: Record<string, any> = { ...args };
  for (const param of params) {
    if (param.hasDefault && out[param.name] === null) {
      delete out[param.name];
    }
  }
  return out;
}

/** Default cap on characters of a single tool result fed back to the
 *  LLM. A recursive `ls`/`grep` can return megabytes; without a cap one
 *  tool call can blow the context window. The FULL result is still
 *  returned to Agency code — only what the model sees is truncated. */
const DEFAULT_TOOL_RESULT_CHARS = 100_000;

/** Coerce an arbitrary tool result to the string the LLM would see.
 *  Strings pass through; everything else is JSON-stringified, with a
 *  `String()` fallback for values JSON can't represent (e.g. circular). */
function stringifyToolResult(result: any): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** Unwrap a SUCCESS Result before it goes back to the model: the LLM
 *  should see the tool's value, not the `{__type, success, value}`
 *  envelope (a wrapped envelope makes the model re-derive `.value` and,
 *  worse, reconstruct wrapped objects when echoing them into later tool
 *  arguments — the compile→run CompiledProgram bug). Only the LLM-facing
 *  message unwraps; the Result cached on the branch for Agency code is
 *  untouched. Failures/rejections never reach this point (handled
 *  upstream in the invoke path), but pass through unchanged
 *  defensively. */
function unwrapToolResultForLlm(result: any, toolName: string): any {
  if (!isSuccess(result)) return result;
  return (
    result.value ?? `${toolName} ran successfully but did not return a value`
  );
}

/** Render a failure Result's error for the model. String errors pass
 *  through; structured errors (e.g. writeAgency's `{source, errors}`)
 *  JSON-stringify — `String(error)` would send the useless
 *  "[object Object]". */
function toolErrorMessage(error: any): string {
  return typeof error === "string" ? error : stringifyToolResult(error);
}

/** A failed tool is removed only after this many failures (the circuit
 *  breaker against retry spirals), or immediately on the destructive tier. */
const MAX_TOOL_FAILURES = 5;

type FailureTier = "destructive" | "neverStarted" | "idempotent" | "neutral";

/** Classify a tool failure. Most-specific fact wins: a started destructive
 *  operation, then a proved-nothing-ran, then the tool's own idempotent
 *  declaration, else neutral. */
function failureTier(
  f: { destructiveRan?: boolean; neverStarted?: boolean },
  markers?: { idempotent?: boolean },
): FailureTier {
  if (f.destructiveRan) return "destructive";
  if (f.neverStarted) return "neverStarted";
  if (markers?.idempotent) return "idempotent";
  return "neutral";
}

const TIER_SUFFIX: Record<FailureTier, string> = {
  destructive:
    "The call failed after starting a destructive operation. This tool can no longer be called in this conversation. Verify state manually.",
  neverStarted: "Nothing was executed. Correct the arguments and call again.",
  idempotent:
    "This tool is idempotent: calling it again is safe. Correct the arguments and call again.",
  neutral: "The call failed. You may call this tool again.",
};

/** Truncate a tool result for the LLM if its serialized form exceeds
 *  `cap` characters. Returns the ORIGINAL value untouched when within
 *  the cap (so smoltalk serializes it exactly as before) or when the cap
 *  is disabled (`cap <= 0` or non-finite). Over the cap, returns the
 *  first `cap` characters plus a marker noting the original length, so
 *  the model knows it was cut. */
function capToolResultForLlm(result: any, cap: number): any {
  if (!Number.isFinite(cap) || cap <= 0) return result;
  const text = stringifyToolResult(result);
  if (text.length <= cap) return result;
  return (
    text.slice(0, cap) +
    `\n\n[tool result truncated: showing ${cap} of ${text.length} chars]`
  );
}

/** Provider APIs (Anthropic, OpenAI) reject an LLM request whose tool list
 *  contains duplicate names, and tool-call dispatch here matches handlers by
 *  name — so duplicate names are always a bug. They're easy to introduce
 *  by accident because `.partial()` / `.describe()` preserve the base
 *  function's name (e.g. `skillsDir` returns `read.partial(dir)`, so four
 *  skill tools are all named `read`). Catch it before the request hits the
 *  wire with a message that names the collision and points at `.rename()`,
 *  instead of an opaque transport-layer 400 that never reaches the statelog. */
function assertUniqueToolNames(tools: { name: string }[]): void {
  const counts: Record<string, number> = {};
  for (const t of tools) {
    counts[t.name] = (counts[t.name] || 0) + 1;
  }
  const dups = Object.keys(counts).filter((n) => counts[n] > 1);
  if (dups.length > 0) {
    const detail = dups.map((n) => `"${n}" (×${counts[n]})`).join(", ");
    throw new Error(
      `Duplicate tool name(s) passed to an LLM call: ${detail}. Tool names ` +
        `must be unique. This usually happens when several tools are derived ` +
        `from the same function via .partial() or .describe(), which preserve ` +
        `the base name. Give each derived tool a distinct name with ` +
        `.rename("...").`,
    );
  }
}

/**
 * Bound one LLM-call attempt by a per-call deadline. Returns a signal that
 * aborts (carrying a `callTimeout` cause) after `limitMs`, composed with the
 * parent (guard / Esc) signal so either source cancels the call. `limitMs <= 0`
 * means "no deadline" — the parent signal passes through unchanged. Structurally
 * a `TimeGuard`, scoped to a single call rather than a block.
 */
function armCallTimeout(
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
async function runWithRetry<T>(
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
async function dispatchWithRetry(args: {
  ctx: RuntimeContext<GraphState>;
  promptConfig: PromptConfig;
  prompt: string | UserContentInput;
  stream: boolean;
  retryPolicy: RetryPolicy;
  parentSignal: AbortSignal | undefined;
  stateStack?: StateStack;
}): Promise<{ completion: PromptResult; toolCalls: ToolCallJSON[] }> {
  const { ctx, promptConfig, prompt, stream, retryPolicy, parentSignal, stateStack } =
    args;

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

  return runWithRetry(
    (signal) =>
      dispatchLLMRequest({
        ctx,
        promptConfig: { ...promptConfig, abortSignal: signal } as PromptConfig,
        prompt,
        stream,
        stateStack,
      }),
    retryPolicy,
    parentSignal,
    retryHooks,
    normalizeError,
  );
}

/** Test-only surface for the pure tool-result-cap helpers. Not part of
 *  the supported runtime API. */
export const _internal = {
  DEFAULT_TOOL_RESULT_CHARS,
  stringifyToolResult,
  capToolResultForLlm,
  assertUniqueToolNames,
  unwrapToolResultForLlm,
  toolErrorMessage,
  failureTier,
  TIER_SUFFIX,
  MAX_TOOL_FAILURES,
  armCallTimeout,
  runWithRetry,
  dropNullDefaultedArgs,
};

/** In-flight visibility: record the request SHAPE before dispatch, so a
 *  call that never completes (hang, kill, runaway generation) still
 *  leaves a trace. Pairs with promptCompletion/llmError/promptCancelled
 *  by span + order. Un-awaited like promptCompletion (post() detaches
 *  the remote send; the file sink is a sync append). Called inside the
 *  same idempotent pr.step as the completion, so resumed runs do not
 *  double-emit for replayed steps. Retries inside dispatchWithRetry
 *  share the one start. */
function emitPromptStart({
  ctx,
  messages,
  tools,
  responseFormat,
  clientConfig,
}: {
  ctx: RuntimeContext<GraphState>;
  messages: MessageThread;
  tools: Tool[];
  responseFormat?: any;
  clientConfig: Partial<smoltalk.SmolConfig>;
}): void {
  ctx.statelogClient.promptStart({
    model: JSON.stringify(clientConfig.model),
    threadId: __threads()?.activeId() ?? null,
    messageCount: messages.getMessages().length,
    toolCount: tools.length,
    hasResponseFormat: responseFormat != null,
    maxTokens: clientConfig.maxTokens ?? null,
  });
}

async function _runPrompt({
  ctx,
  messages,
  tools,
  prompt,
  responseFormat,
  clientConfig,
  stateStack,
  retryPolicy,
}: {
  ctx: RuntimeContext<GraphState>;
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
}): Promise<RunPromptResult> {
  if (ctx.isCancelled(stateStack)) {
    throw new AgencyCancelledError();
  }

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

  await callHook({
    ctx,
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

  emitPromptStart({ ctx, messages, tools, responseFormat, clientConfig });

  let completion: PromptResult;
  let toolCalls: ToolCallJSON[];
  try {
    ({ completion, toolCalls } = await dispatchWithRetry({
      ctx,
      promptConfig,
      prompt,
      stream,
      retryPolicy,
      parentSignal: ctx.getAbortSignal(stateStack),
      stateStack,
    }));
  } catch (err) {
    // Cancellation normalization. When WE aborted the request (user pressed
    // Esc → ctx.cancel(), a race loser, a timeout), the provider SDK
    // surfaces its OWN abort error — e.g. Anthropic throws a plain
    // `Error("Request was aborted.")` whose name isn't "AbortError", so
    // `isAbortError` can't recognize it by identity. Our cancellation state
    // is authoritative: if the call threw while we're cancelled, it's a
    // cancellation. Normalize to AgencyCancelledError so the rest of the
    // runtime (function/node catches re-throw it, the REPL prints
    // "cancelled") handles it as one — and skip the llmError log below,
    // since a user cancel isn't a request failure worth recording.
    // Prefer the structured cause when present so the normalized error keeps
    // its intent (guardTrip / userInterrupt / …); fall back to the
    // isCancelled heuristic for provider errors that arrive with no cause.
    // The cause object preserves identity (readCause off the error or the
    // composed signal returns the SAME branded object the producer set), so
    // the `delivered` de-dup flag stays shared across the two trip paths.
    const cause = readCause(err) ?? readCause(ctx.getAbortSignal(stateStack));
    if (cause || ctx.isCancelled(stateStack) || isAbortError(err)) {
      // Terminate the promptStart pair: a cancelled call (race loser,
      // Esc, timeout abort) is a NORMAL outcome, not a request failure —
      // no llmError — but leaving the start unpaired would make every
      // healthy race() render "never completed" warnings.
      ctx.statelogClient.promptCancelled({
        threadId: __threads()?.activeId() ?? null,
      });
      throw new AgencyCancelledError(undefined, cause);
    }
    // The success-path `promptCompletion` event below is the only place the
    // request payload (messages + tools) is logged, and it never runs when
    // the dispatch throws — so a provider rejection (e.g. a 400 over the
    // tool list) otherwise leaves no record of what was sent. Emit an
    // `llmError` carrying the tool list so the failed request is
    // diagnosable, then rethrow the ORIGINAL error unchanged. The emit is
    // best-effort: a statelog failure (e.g. a JSON.stringify error inside
    // post()) must not mask the real LLM/transport error, so swallow it.
    try {
      await ctx.statelogClient.error({
        errorType: "llmError",
        message: err instanceof Error ? err.message : String(err),
        tools,
      });
    } catch {
      // ignore — never let logging shadow the original failure
    }
    throw err;
  }

  // Capture endTime AFTER the response has been fully received. The
  // request Promise is created above but only awaited inside the
  // stream/non-stream branches; sampling earlier would only measure
  // request setup, not the actual round-trip time.
  const endTime = performance.now();

  const modelName = completion.model || clientConfig.model || "unknown model";

  ctx.statelogClient.promptCompletion({
    messages: redactMessagesForLog(messages),
    completion,
    model: JSON.stringify(modelName),
    timeTaken: endTime - startTime,
    tools,
    responseFormat,
    usage: completion.usage,
    cost: completion.cost,
    finishReason: (completion as any).finishReason ?? (completion as any).finish_reason,
    stream,
    threadId: __threads()?.activeId() ?? null,
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
    model: modelName,
  });

  // Per-branch accumulator: adds to the active stack so std::thread's
  // getCost()/getTokens() can report per-branch totals; complementary
  // to the global __tokenStats above. Then bill every active guard
  // for this call's cost and enforce limits. Shared parent guards see
  // descendants' spend in real time; mid-fork trips fire on the next
  // enforceGuards() call. See docs/superpowers/specs/2026-05-20-thread-
  // builtins-and-stdlib-design.md.
  const callCost = completion.cost?.totalCost ?? 0;
  targetStack.billCharge(callCost);
  targetStack.localTokens += completion.usage?.totalTokens ?? 0;
  targetStack.enforceGuards();

  // Memory layer: auto-extraction and compaction run unconditionally
  // whenever a MemoryManager is attached (resolved decision #6).
  // Tool-call results have not been pushed yet, so we operate on the
  // current message slice. Compaction is a best-effort hint — failures
  // never break the LLM call.
  const memoryManager = ctx.getActiveMemoryManager();
  if (memoryManager) {
    try {
      const original = messages.getMessages();
      await memoryManager.onTurn(original);
      const plan = await memoryManager.compactIfNeeded(original);
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
      // Cost / time guard trips are NOT best-effort failures — they
      // signal the surrounding `withCostGuard` / `withTimeGuard` has
      // been exceeded and the agent should stop. Re-throw so the
      // signal reaches the user's scope instead of being silently
      // logged here.
      if (isGuardExceededError(err)) throw err;
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
      messages: redactMessagesForLog(messages),
    },
  });

  return { messages, toolCalls };
}

// eslint-disable-next-line max-lines-per-function -- core prompt execution loop; refactor tracked separately
export async function runPrompt(args: {
  prompt: string | UserContentInput;
  messages: MessageThread;
  responseFormat?: any;
  /** Provider-shaped config (model/temperature/...). Retry fields may also
   *  appear here when the Agency-source `llm()` codegen passes through a
   *  user-written options object verbatim; they are extracted below and
   *  stripped before the config is forwarded to the LLM client. Direct TS
   *  callers (e.g. `agency.llm`) should use the dedicated `retryConfig`
   *  parameter instead. */
  clientConfig: Partial<smoltalk.SmolConfig> & RetryConfig & { tools?: any[] };
  /** Per-call resilience policy. Takes precedence over any retry fields
   *  piggybacked on `clientConfig`. */
  retryConfig?: RetryConfig;
  maxToolCallRounds?: number;
  removedTools?: string[];
  checkpointInfo?: SourceLocationOpts;
}): Promise<any> {
  const {
    prompt,
    responseFormat,
    maxToolCallRounds = 10,
    checkpointInfo,
  } = args;

  // ctx + stack come from the active ALS frame — the codegen used to
  // pass them explicitly as `ctx` / `stateStack` keys on `args`, but
  // post-ALS migration every Agency execution path runs inside an
  // `agencyStore.run(...)` frame seeded with the same values.
  const runtime = getRuntimeContext();
  const ctx = runtime.ctx as RuntimeContext<GraphState>;

  // Push a frame onto the state stack — runPrompt participates like any other function
  const { stateStack, stack } = setupFunction();
  const self = stack.locals;

  // Frame-backed locals (survive checkpoint/restore)
  if (self.__initialized === undefined) {
    self.__initialized = true;
    self.removedTools = args.removedTools || [];
    self.toolErrorCounts = {};
    self.toolCallRound = 0;
    self.validationAttempt = 0;
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
  // Drop removed tools first — they're never exposed to the LLM, so they
  // shouldn't block the call with a backstop error for an unbound block
  // they wouldn't have been asked to invoke anyway.
  const exposedFunctions = agencyFunctions.filter(
    (fn) => !removedTools.includes(fn.name),
  );
  // Runtime backstop for compile-time-undetectable cases (dynamic tool
  // assembly, hand-written TS). Runs once per exposed tool — before the
  // LLM ever sees the schema — so failures surface at registration time,
  // not deep inside an invocation when the missing block is called.
  for (const fn of exposedFunctions) {
    fn.validateForLLM();
  }
  let tools = exposedFunctions
    .filter((fn) => fn.toolDefinition)
    .map((fn) => fn.toolDefinition!);
  // Pre-flight: reject duplicate tool names before they reach the provider,
  // where they surface as an opaque 400 with no request payload in the
  // statelog. See assertUniqueToolNames.
  assertUniqueToolNames(tools);
  let toolFunctions = exposedFunctions;

  // Remove agency-only / runtime-only keys from clientConfig before passing
  // to smoltalk. `tools` is consumed above. `memory` is a runtime directive
  // smoltalk doesn't understand. `retries` / `timeout` / `backoff` are the
  // resilience policy (resolved below); if the codegen forwarded them on
  // `clientConfig` they'd otherwise hit the LLM client as foreign options.
  const {
    tools: _extractedTools,
    memory: memoryOption,
    maxToolResultChars: callMaxToolResultChars,
    retries: ccRetries,
    timeout: ccTimeout,
    backoff: ccBackoff,
    validationRetries: ccValidationRetries,
    ...restClientConfig
  } = (args.clientConfig || {}) as Partial<smoltalk.SmolConfig> &
    RetryConfig & {
      tools?: any[];
      memory?: boolean | { model?: string };
      maxToolResultChars?: number;
    };

  // Resolve the resilience policy. Precedence:
  //   1. `args.retryConfig` (preferred — what `agency.llm` passes directly)
  //   2. retry fields piggybacked on `args.clientConfig` (the codegen path —
  //      the Agency `llm()` compiler forwards the user options object
  //      verbatim as `clientConfig`, which may include retry/timeout/backoff)
  //   3. branch defaults (`stack.other.llmDefaults`, set by `setLlmOptions`)
  //   4. built-in defaults
  // Known limitation: when a direct TS caller passes `args.retryConfig`,
  // only the fields that caller sets apply (same as retries/timeout/backoff
  // have always behaved on that path).
  const perCallRetry: RetryConfig =
    args.retryConfig ?? {
      retries: ccRetries,
      timeout: ccTimeout,
      backoff: ccBackoff,
      validationRetries: ccValidationRetries,
    };
  const branchRetryDefaults = (stateStack?.other?.llmDefaults as RetryConfig | undefined) ?? {};
  const retryPolicy = resolveRetryPolicy(perCallRetry, branchRetryDefaults);

  // Run-wide LLM defaults set at runtime via `std::llm`
  // (setLlmOptions/setModel) live on the ACTIVE branch stack's
  // `other.llmDefaults` (branch-scoped, serialized; seeded from the
  // parent at fork time). Layer them BETWEEN the baked
  // `smoltalkDefaults` and the per-call options, so precedence is
  // baked agency.json < stack defaults < per-call `llm({...})`.
  const stackDefaults: Partial<LlmDefaults> =
    stateStack?.other?.llmDefaults ?? {};
  const {
    maxToolResultChars: stackMaxToolResultChars,
    maxToolCallRounds: stackMaxToolCallRounds,
    ...stackSmolDefaults
  } = stackDefaults;
  // maxToolCallRounds precedence: a branch default (setLlmOptions) overrides the
  // baked per-call value (agency.json → codegen literal, default 10). Kept out
  // of stackSmolDefaults above — it isn't a smoltalk config field.
  const effectiveMaxToolCallRounds = stackMaxToolCallRounds ?? maxToolCallRounds;
  const clientConfig = ctx.getSmoltalkConfig({
    ...stackSmolDefaults,
    ...restClientConfig,
  });

  // Cap on characters of a single tool result fed back to the LLM. The
  // full result is still cached for Agency code via `setResultOnBranch`;
  // only what the model sees is truncated. Resolution precedence:
  // per-call `llm(..., { maxToolResultChars })` > runtime
  // `setLlmOptions` (active stack) > agency.json (`ctx.maxToolResultChars`)
  // > default. `0`/non-finite disables.
  const toolResultCap =
    callMaxToolResultChars ??
    stackMaxToolResultChars ??
    ctx.maxToolResultChars ??
    DEFAULT_TOOL_RESULT_CHARS;

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

  // One llmCall span covers the WHOLE `llm()` call — every tool-loop
  // round plus the tool executions they trigger. So all rounds'
  // promptCompletion events and all toolExecution spans nest under a
  // single llmCall span, matching the
  // agentRun > nodeExecution > llmCall > toolExecution hierarchy and
  // the "one llmCall span == one llm() call" model the viewer renders.
  // Opened once below (outside `pr.step` so resume re-opens it on
  // re-entry) and closed once in `finally`.
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
  // Open the single llmCall span before the round-trip loop. Done here
  // (not inside the idempotent `initialLlmCall` step) so a resumed run —
  // which skips completed steps — still re-opens the span that the tool
  // loop expects to be active.
  currentLlmSpanId = ctx.statelogClient.startSpan("llmCall");
  try {
    // Initial LLM call wrapped in pr.step so it's idempotent on resume
    // (re-entries after a later tool-batch bailout skip this step).
    await pr.step("initialLlmCall", async () => {
      let injectedFactsContent: string | null = null;
      const recallManager = ctx.getActiveMemoryManager();
      if (memoryOption && recallManager) {
        try {
          const facts = await recallManager.recallForInjection(
            promptText(prompt),
          );
          if (facts) {
            injectedFactsContent = `Relevant context from memory:\n${facts}`;
            messages.push(smoltalk.systemMessage(injectedFactsContent));
          }
        } catch (err) {
          // Guard trips are signals, not best-effort failures — let
          // them bubble to the surrounding `withCostGuard` scope.
          if (isGuardExceededError(err)) throw err;
          createLogger(ctx.logLevel).warn(
            `[memory] recall injection failed: ${(err as Error).message}`,
          );
        }
      }
      messages.push(smoltalk.userMessage(prompt));
      // The llmCall span is already open (before the loop). On error,
      // the outer `finally` closes it.
      const result = await _runPrompt({
        ctx,
        messages,
        tools: tools || [],
        prompt,
        responseFormat,
        clientConfig,
        stateStack,
        retryPolicy,
      });
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
        // The tool body inherits the calling ALS frame's `ctx` and
        // `stack` (the branch's per-tool-call stack, set up by
        // `runBatch.runInBranchAlsFrame`) — those are correct for
        // branch-aware cancellation and per-branch state. The
        // `threads` slot, however, must NOT be inherited. If the tool
        // body issues its own `llm()` call, that nested prompt would
        // push messages into the OUTER prompt's MessageThread (whose
        // last message is `assistant(tool_calls=[this tool])`),
        // producing a thread shape OpenAI rejects with "An assistant
        // message with 'tool_calls' must be followed by tool
        // messages". A nested tool invocation is logically a fresh
        // conversation, so install a fresh ThreadStore for the
        // duration of this invoke. Pre-ALS, `setupFunction` produced
        // the same outcome via its `state.threads || new ThreadStore()`
        // fallback whenever a function was reached via tool dispatch.
        const parentFrame = agencyStore.getStore();
        // Lazy, NOT `withDefaultActive`: the latter eagerly creates and
        // logs a default thread on every tool call, so a leaf tool that
        // never calls llm() (the common case) emits a confusing phantom
        // `threadCreated thread #0` in the trace. With a bare store the
        // default thread is created + logged lazily by `getOrCreateActive`
        // only if the tool body actually issues an llm()/userMessage()
        // call — at which point the thread is real and worth logging.
        const freshThreads = new ThreadStore();
        freshThreads.setStatelogClient(ctx.statelogClient);
        const invokeAsTool = () =>
          handler.invoke({
            type: "named",
            positionalArgs: [],
            namedArgs,
          });
        toolResult = parentFrame
          ? await agencyStore.run(
            { ...parentFrame, threads: freshThreads },
            invokeAsTool,
          )
          : await invokeAsTool();
      } catch (error: unknown) {
        // A cancellation (user pressed Esc, race-loser, timeout) is not a
        // tool crash. Let it propagate so the turn unwinds cleanly —
        // logging it as an error and feeding a bogus failure message back
        // to the model (as the crash path below does) would both spam
        // "Tool call X crashed" for every tool on the stack and corrupt
        // the thread. Mirrors the function/node catch re-throws.
        if (isAbortError(error)) {
          stack.deleteBranch(branchKey);
          throw error;
        }
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        // Keep the crash visible in the terminal, then convert to a failure
        // and fall through to the unified failure branch below. The tool
        // STAYS callable (the old remove-on-crash policy is abolished): a
        // pre-execution tag (argument binding failed → body never ran) maps
        // to the neverStarted tier; any other crash is neutral.
        console.error(
          `Tool call "${handler.name}" crashed: ${errorMessage}`,
        );
        const preExecution = !!(error as { preExecution?: boolean })
          ?.preExecution;
        toolResult = failure(errorMessage, { neverStarted: preExecution });
      } finally {
        ctx.exitToolCall();
      }

      // Decision 8: destructive work performed via a tool inside an llm()
      // call must propagate to the calling function's activation, so a later
      // failure THERE reports destructiveRan. Write the same locals slot the
      // codegen flag lives in; the enclosing function's exit stamp reads it.
      //
      // Mirror the codegen assignment-flip EXACTLY (`isFailure(r) ?
      // r.destructiveRan : true` for a destructive callee): a FAILURE carries
      // precisely whether destructive work ran, so trust that bit rather than
      // the marker. A destructive tool that failed pre-execution
      // (neverStarted) or cleanly refused (returned a failure before its
      // effectful work) has destructiveRan === false and must NOT poison the
      // caller — otherwise a later failure in an enclosing agent-as-tool would
      // wrongly report destructiveRan. A SUCCESS of a destructive-marked tool
      // is taken to have done its work (successes carry no destructiveRan bit).
      const toolDidDestructiveWork = isFailure(toolResult)
        ? toolResult.destructiveRan
        : !!handler.markers?.destructive;
      if (toolDidDestructiveWork) {
        // `stack` is the calling function's activation frame (a State with
        // `.locals`); its exit stamp reads `__self.__destructiveRan` ===
        // `stack.locals.__destructiveRan`.
        markDestructiveWork(stack);
      }

      if (isFailure(toolResult)) {
        const errorMessage = toolErrorMessage(toolResult.error);
        // Cap only what the LLM sees; statelog keeps the full message.
        const cappedError = String(
          capToolResultForLlm(errorMessage, toolResultCap),
        );
        toolErrorCounts[handler.name] =
          (toolErrorCounts[handler.name] || 0) + 1;
        ctx.statelogClient.error({
          errorType: "toolError",
          message: errorMessage,
          functionName: handler.name,
          neverStarted: !!toolResult.neverStarted,
          destructiveRan: !!toolResult.destructiveRan,
        });
        const tier = failureTier(toolResult, handler.markers);
        const pushMessage = (suffix: string) => {
          messages.push(
            smoltalk.toolMessage(`Error: ${cappedError}. ${suffix}`, {
              tool_call_id: toolCall.id,
              name: toolCall.name,
            }),
          );
        };
        if (tier === "destructive") {
          pushMessage(TIER_SUFFIX.destructive);
          removedTools.push(handler.name);
        } else if (toolErrorCounts[handler.name] >= MAX_TOOL_FAILURES) {
          pushMessage(
            "This tool has failed too many times and can no longer be called.",
          );
          removedTools.push(handler.name);
        } else {
          pushMessage(TIER_SUFFIX[tier]);
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
          smoltalk.toolMessage(capToolResultForLlm(message, toolResultCap), {
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

      // Success: cache the result, push tool message (extracted helper
      // keeps this arrow inside the max-lines-per-function budget). The
      // branch cache keeps the FULL value (Agency code may match on a
      // Result); the model-facing message gets the unwrapped success
      // value via unwrapToolResultForLlm inside the push helper.
      // Nullish, NOT ||: legitimate falsy returns (false, 0, "") must
      // reach the model and the branch cache as-is.
      toolResult =
        toolResult ??
        `${handler.name} ran successfully but did not return a value`;
      stack.setResultOnBranch(branchKey, toolResult);
      pushSuccessToolMessage({ toolResult, toolCall, handler, branchStack });
      return { toolResult, invokeOutcome: "success" };
    };

    // Push the success ToolMessage for one invocation, with any reply-
    // attachment marker appended. Reply attachments: drain what this
    // invocation queued via attachToReply (branch-local, so parallel
    // tools cannot mix), gate and id it, and append the model-facing
    // marker to THIS tool's result. Called from inside the idempotent
    // invoke b.step, so it fires exactly once per tool call across
    // interrupt/resume. Survivors land in self.runnerState (serialized
    // per-llm()-call) and are injected after the round completes.
    //
    // `clientConfig.model` passes through unmodified — smoltalk's own
    // send-time gate calls modelSupportsInputModality(config.model, ...)
    // with the same value, so this pre-check is bug-for-bug identical
    // with send. Do NOT extract/stringify the model here.
    const pushSuccessToolMessage = (args: {
      toolResult: any;
      toolCall: smoltalk.ToolCallJSON;
      handler: AgencyFunction;
      branchStack: StateStack;
    }): void => {
      const { toolResult, toolCall, handler, branchStack } = args;
      const replyMarker = harvestReplyAttachments({
        queued: branchStack.drainPendingReplyAttachments(),
        runnerState: self.runnerState,
        model: clientConfig.model,
        toolName: handler.name,
      });
      messages.push(
        smoltalk.toolMessage(
          // `as any` mirrors the pre-existing call: capToolResultForLlm
          // returns `any` (an under-cap structured result passes through
          // unstringified) and ToolMessage accepts it at runtime.
          appendReplyMarker(
            capToolResultForLlm(
              unwrapToolResultForLlm(toolResult, handler.name),
              toolResultCap,
            ),
            replyMarker,
            stringifyToolResult,
          ) as any,
          {
            tool_call_id: toolCall.id,
            name: toolCall.name,
          },
        ),
      );
    };

    // Validation-retry outer loop: each iteration drains tool calls, then
    // validates the final assistant message when a responseFormat is set.
    // A "retry" decision pushes the validation error back to the model as
    // a user message, dispatches one more round, and loops. Bounded by
    // retryPolicy.validationRetries via decideValidationRetry.
    while (true) {
      // Handle tool calls
      while (toolCalls.length > 0) {
        if (ctx.isCancelled(stateStack)) throw new AgencyCancelledError();
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
          // operate on the same branch. Keyed by the tool call's POSITION in
          // the round, not its id: some providers (notably Google Gemini)
          // return tool calls with no id — Gemini matches responses to calls
          // by function name + position, so smoltalk defaults the missing id
          // to "". Two id-less parallel calls would otherwise collide on the
          // branch key ("tool_") and trip `runBatch: duplicate child key`.
          // The id is folded in after the index only for readability; the
          // index alone guarantees uniqueness within the round.
          (toolCall, i) => `tool_${i}_${toolCall.id}`,
          async (toolCall, b, index) => {
            if (ctx.isCancelled(stateStack)) throw new AgencyCancelledError();

            // Per-call slug used for the branch key, every resume-idempotency
            // step path, and the per-tool timing key below. Position-based so
            // it stays unique even when `toolCall.id` is "" (see keyFor). Must
            // NOT leak into message `tool_call_id` fields — those keep the
            // real (possibly empty) id so provider pairing / threadRepair are
            // byte-for-byte unchanged.
            const callSlug = `${index}_${toolCall.id}`;

            const handler = toolFunctions.find(
              (fn) => fn.name === toolCall.name,
            );
            if (!handler) {
              await b.step(
                `round.${round}.tool.${callSlug}.unhandled`,
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

            if (self.toolCallRound >= effectiveMaxToolCallRounds) {
              await b.step(
                `round.${round}.tool.${callSlug}.tooManyRounds`,
                async () => {
                  messages.push(
                    smoltalk.toolMessage(
                      `Error: Maximum number of tool call rounds (${effectiveMaxToolCallRounds}) exceeded. This tool call will not be executed.`,
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
                `round.${round}.tool.${callSlug}.removed`,
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

            const branchKey = `tool_${callSlug}`;
            // Note: a "cached result" short-circuit used to live here for
            // resume after a sibling interrupt; idempotency is now handled
            // uniformly by completedSteps inside b.step (start/invoke/end
            // each get marked done on success and skipped on resume).
            const branchStack = stack.getOrCreateBranch(branchKey).stack;
            const namedArgs = dropNullDefaultedArgs(
              toolCall.arguments,
              handler.params,
            );

            await b.step(
              `round.${round}.tool.${callSlug}.start`,
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
              // Emit toolCallStart inside the same toolExecution span as
              // the (later) toolCall end event so consumers can pair the
              // two by span_id. Wrap in b.step so resume-replay doesn't
              // duplicate the event. Designed to leave a trace of every
              // tool that began even when the run is killed before it
              // completes (the matching toolCall event won't fire).
              await b.step(
                `round.${round}.tool.${callSlug}.logStart`,
                async () => {
                  ctx.statelogClient.toolCallStart({
                    toolName: handler.name,
                    args: namedArgs,
                    model: JSON.stringify(clientConfig.model),
                    threadId: __threads()?.activeId() ?? null,
                  });
                },
              );
              // Invoke step: returns the interrupts when the tool halts
              // with them so BranchRunner.step can collect. All other
              // outcomes (success, failure, reject, crash) update outer
              // state in place via runInvokeStep; the step completes
              // (returns void unless interrupted) and is marked done so
              // resume skips this whole block.
              await b.step(
                `round.${round}.tool.${callSlug}.invoke`,
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
                    self.runnerState.toolTimings[callSlug] =
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
                self.runnerState.toolTimings[callSlug] ?? 0;
              await b.step(
                `round.${round}.tool.${callSlug}.end`,
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
                `round.${round}.tool.${callSlug}.log`,
                async () => {
                  ctx.statelogClient.toolCall({
                    toolName: handler.name,
                    args: namedArgs,
                    output: toolResult,
                    model: JSON.stringify(clientConfig.model),
                    timeTaken,
                    threadId: __threads()?.activeId() ?? null,
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

        // Reply attachments harvested from this round's tools (and any
        // earlier round whose injection was pre-empted by an interrupt):
        // inject ONE labeled user message after ALL tool results — the
        // provider adjacency rules require the assistant's tool calls to
        // be answered by every tool result before any other message.
        // Resume-safety (verified): pr.step marks the key in
        // completedSteps and skips it on resume; PromptRunner snapshots
        // messagesJSON in beforeCheckpoint (promptRunner.ts) so a
        // checkpoint stamped after this step completes carries the
        // injected message, and resume restores messages from
        // messagesJSON — the same mechanism that preserves sibling
        // tool-message pushes. Clearing the buffer inside the step keeps
        // the outer guard consistent on replay. The explicit messagesJSON
        // write matches the pattern at the first-LLM-call and nextLlmCall
        // sites.
        const pendingReplies = (self.runnerState.replyAttachments ??
          []) as HarvestedReplyAttachment[];
        if (pendingReplies.length > 0) {
          await pr.step(`round.${round}.attachReplies`, async () => {
            messages.push(
              smoltalk.userMessage(
                buildReplyUserMessage(pendingReplies) as smoltalk.UserContentInput,
              ),
            );
            self.runnerState.replyAttachments = [];
            self.messagesJSON = messages.toJSON().messages;
          });
        }

        // Next LLM call wrapped in pr.step for resume idempotency. Once
        // marked done, resume re-entries skip the LLM call. The llmCall
        // span stays open across rounds (one span per llm() call), so we
        // do NOT close/reopen it here — this round's promptCompletion
        // nests under the same span as the first round's.
        await pr.step(`round.${round}.nextLlmCall`, async () => {
          const nextResult = await _runPrompt({
            ctx,
            messages,
            tools: tools || [],
            prompt,
            responseFormat,
            clientConfig,
            stateStack,
            retryPolicy,
          });
          messages = nextResult.messages;
          toolCalls = nextResult.toolCalls;
          // Increment the round counter only after a successful LLM round,
          // so resume after a tool-batch interrupt re-enters the SAME round.
          self.toolCallRound = round + 1;
          self.messagesJSON = messages.toJSON().messages;
          self.pendingToolCalls = toolCalls.length > 0 ? toolCalls : null;
        });
      }
      // Tool calls are drained. No schema means nothing to validate; the
      // plain-content return after the finally handles it.
      if (!responseFormat) {
        break;
      }

      // Validate the last ASSISTANT message, not the last message: a
      // resume that replays past a completed feedback step arrives here
      // with our own feedback user message at the tail, and a string
      // schema would happily "validate" it via envelope-skip recovery.
      const lastAssistant = [...messages.getMessages()]
        .reverse()
        .find((m) => m.role === "assistant");
      const validationExtract = extractStructuredResponse(
        lastAssistant?.content,
        responseFormat,
      );
      const validationAttempt = self.validationAttempt as number;
      const decision = decideValidationRetry(
        validationExtract,
        lastAssistant?.content,
        validationAttempt,
        retryPolicy,
      );

      if (decision.kind === "accept") {
        return decision.value;
      }
      if (decision.kind === "surfaceFailure") {
        // Strict contract (issue #494): schema-constrained output either
        // validates or comes back as a failure Result, never raw content.
        // Loud in the statelog too, so a rotting integration is visible
        // even when the caller swallows the failure. Fires with the
        // llmCall span still open; pairing consumers ignore error events.
        ctx.statelogClient.error({
          errorType: "structuredOutput",
          message: decision.message,
        });
        return failure(decision.message);
      }

      // decision.kind === "retry". Steps mirror attachReplies/nextLlmCall:
      // keys derive from the PERSISTED counter, and the counter only
      // advances inside the dispatch step, so a resume re-entry recomputes
      // identical keys and skips completed steps instead of double-pushing
      // feedback or double-counting the attempt.
      await pr.step(`validation.${validationAttempt}.feedback`, async () => {
        // Same hook transport retries fire (the agent renders it as a
        // "retrying" line). Inside the step so a resume replay does not
        // re-emit it. No backoff sleep: the provider is healthy, the
        // content was just wrong.
        await callHook({
          ctx,
          name: "onLLMRetry",
          data: {
            attempt: validationAttempt + 1,
            maxRetries: retryPolicy.validationRetries,
            delayMs: 0,
            reason: decision.reason,
            detail: decision.detail,
          },
        });
        messages.push(smoltalk.userMessage(decision.feedback));
        self.messagesJSON = messages.toJSON().messages;
      });
      await pr.step(`validation.${validationAttempt}.llmCall`, async () => {
        const nextResult = await _runPrompt({
          ctx,
          messages,
          tools: tools || [],
          prompt,
          responseFormat,
          clientConfig,
          stateStack,
          retryPolicy,
        });
        messages = nextResult.messages;
        toolCalls = nextResult.toolCalls;
        // Advance ONLY here, like nextLlmCall advances toolCallRound: a
        // bailout before this step completes leaves the counter unchanged,
        // so resume re-enters the SAME attempt with the same step keys.
        self.validationAttempt = validationAttempt + 1;
        self.messagesJSON = messages.toJSON().messages;
        self.pendingToolCalls = toolCalls.length > 0 ? toolCalls : null;
      });
      // Loop: the retry response may itself contain tool calls; the inner
      // loop drains them before validation runs again.
    }
  } catch (error) {
    if (error instanceof PromptBailout) {
      shouldPop = false;
      return error.interrupts;
    }
    if (isAbortError(error)) {
      // Hard cancel (e.g. user pressed Esc): repair the live thread so the
      // next turn starts from a clean, role-valid state, then re-throw so
      // the cancellation still propagates to the caller / REPL. Only a
      // user-initiated cancel warrants repair — a guard trip or race-loser
      // abort wants the in-flight turn left intact for its Failure path.
      if (needsThreadRepair(readCause(error))) markThreadCancelled(messages);
      throw error;
    }
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

  // Only the no-schema path reaches here; schema-constrained calls return
  // from inside the validation-retry loop above (issue #494).
  return responseMessage.content;
}
