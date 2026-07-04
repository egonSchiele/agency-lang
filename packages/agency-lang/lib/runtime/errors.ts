import type { Checkpoint } from "./state/checkpointStore.js";
import type { MessageJSON } from "smoltalk";

export type RestoreOptions = {
  messages?: MessageJSON[];
  args?: Record<string, any>;
  /** Override global variables on restore. Applied to the checkpoint's module.
   * Only affects globals defined in the same file as the checkpoint.
   * Globals in other imported files are restored from checkpoint state. */
  globals?: Record<string, any>;
  /** Maximum number of times this checkpoint's source location may be restored.
   * Once the limit is reached, the restore is skipped (returns instead of throwing).
   * The count is keyed by the checkpoint's source location (moduleId:scopeName#stepPath),
   * so it persists across checkpoint ID changes caused by restore cycles. */
  maxRestores?: number;
};

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointError";
  }
}

export class RestoreSignal extends Error {
  checkpoint: Checkpoint;
  options?: RestoreOptions;

  constructor(checkpoint: Checkpoint, options?: RestoreOptions) {
    super(`Restoring to checkpoint ${checkpoint.id}`);
    this.name = "RestoreSignal";
    this.checkpoint = checkpoint;
    this.options = options;
  }
}

export class ConcurrentInterruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentInterruptError";
  }
}

/**
 * Structured reason carried by every abort — on `AbortController.abort(cause)`
 * (so it surfaces as `signal.reason`) and on the `agencyCause` field of a
 * thrown `AgencyCancelledError`. The `kind` discriminant lets every
 * catch/boundary READ the intent instead of re-deriving it (which is what the
 * runner's guard-sniff and the leaf bare-throws used to do). See
 * docs/superpowers/specs/2026-06-21-abort-taxonomy-design.md.
 */
export type AbortCause =
  | { kind: "userInterrupt" }
  | { kind: "userKill"; reason?: string }
  | {
      kind: "guardTrip";
      dimension: "cost" | "time";
      limit: number;
      spent: number;
      guardId: string;
      /**
       * Mutable de-dup flag. A time-guard trip can be delivered by EITHER
       * an aborted leaf op (→ `__tryCall` converts to a Failure) OR the
       * runner's `shouldSkip` (→ throws `GuardExceededError`). Whichever
       * fires first sets this; the other then knows the trip is already
       * handled and must not re-deliver. The cause object has stable
       * identity across the composed signal (`AbortSignal.any` adopts the
       * source's reason object), so this single flag is visible to both
       * paths. See docs/superpowers/specs/2026-06-21-abort-taxonomy-design.md §3.4.
       */
      delivered?: boolean;
    }
  | { kind: "raceLoser" }
  | { kind: "cleanup" }
  // A runaway-recursion trip: logical function-call nesting exceeded
  // `maxCallDepth`. Modeled as an abort (like `guardTrip`) so it propagates
  // untouched through every generated catch and halts the run instead of being
  // converted to a Failure that could silently re-descend into the recursion.
  | { kind: "callDepthExceeded"; limit: number; observed: number }
  // An abort WE initiate when a single llm() call exceeds its per-call deadline.
  // (This is the cause on the call's AbortController while retrying. A transient
  // LLM failure that EXHAUSTS retries is NOT an abort — it surfaces as a plain
  // Error that the catch ladder converts to a Failure, like today.)
  | { kind: "callTimeout"; limitMs: number };

/** Brand so a plain object on `signal.reason` is recognizable as ours. */
const ABORT_CAUSE_BRAND = "__agencyAbortCause";

export function makeAbortCause(
  cause: AbortCause,
): AbortCause & { [ABORT_CAUSE_BRAND]: true } {
  return { ...cause, [ABORT_CAUSE_BRAND]: true } as AbortCause & {
    [ABORT_CAUSE_BRAND]: true;
  };
}

function isAbortCause(value: unknown): value is AbortCause {
  return (
    value != null &&
    typeof value === "object" &&
    (value as Record<string, unknown>)[ABORT_CAUSE_BRAND] === true &&
    typeof (value as Record<string, unknown>).kind === "string"
  );
}

/**
 * Read the structured `AbortCause` off an `AbortSignal` (its `reason`), a
 * thrown `AgencyCancelledError` (its `agencyCause`), or a bare cause value.
 * Returns `undefined` when no structured cause is present — callers keep
 * their existing heuristics as a fallback for that case.
 *
 * Note: this uses `instanceof AgencyAbort`, NOT the name-based fallback that
 * `isAbortError` adds for errors that cross module instances (the resolver
 * shim — see below). Every abort producer and consumer lives in one runtime
 * module instance, so `instanceof` holds. If a cause ever needs reading
 * across that boundary, `readCause` returns `undefined` where `isAbortError`
 * would still recognize the error — the in-process sibling of the subprocess
 * cause-payload risk noted in the abort-taxonomy spec.
 */
export function readCause(source: unknown): AbortCause | undefined {
  if (source == null) return undefined;
  if (typeof AbortSignal !== "undefined" && source instanceof AbortSignal) {
    // `signal.reason` is kept as an Error (so `throw signal.reason` in
    // runBatch stays an Error), with the structured cause carried on it —
    // but a bare branded cause is also accepted for forward-compat.
    return readCause(source.reason);
  }
  if (source instanceof AgencyAbort && source.agencyCause) {
    return source.agencyCause;
  }
  if (isAbortCause(source)) return source;
  return undefined;
}

/**
 * The single unified abort type. EVERY abort — a user cancellation
 * (`AgencyCancelledError`) AND a guard trip (`GuardExceededError`) — is an
 * `AgencyAbort` carrying a structured `AbortCause`. Generated code catches
 * exactly one thing in its abort rung (`__error instanceof AgencyAbort`) and
 * re-throws it untouched; the owning guard's boundary converts its own
 * `guardTrip`, everything else unwinds. `RestoreSignal` stays separate (it is
 * not an abort). See docs/superpowers/specs/2026-06-21-abort-taxonomy-design.md §5.
 */
export class AgencyAbort extends Error {
  /** Structured intent for this abort. */
  readonly agencyCause: AbortCause;

  constructor(message: string, cause: AbortCause) {
    super(message);
    this.name = "AgencyAbort";
    this.agencyCause = cause;
  }
}

export class AgencyCancelledError extends AgencyAbort {
  constructor(reason?: string, cause?: AbortCause) {
    // The default cause MUST be branded via makeAbortCause — readCause only
    // recognizes branded causes (a bare {kind:...} reads back as undefined).
    // Matches what ctx.cancel() does today. The agencyCause field lives only
    // on AgencyAbort (readonly); this subclass inherits it through super().
    super(
      reason ?? "Agent execution was cancelled",
      cause ?? makeAbortCause({ kind: "userKill", reason }),
    );
    this.name = "AgencyCancelledError";
  }
}

/** Thrown by the call-depth guard (lib/runtime/callDepth.ts, invoked from
 *  every `AgencyFunction.invoke()`) when the logical function-call nesting
 *  depth exceeds `maxCallDepth`. Almost always indicates unbounded recursion —
 *  most dangerously the async kind, which flattens V8's stack and grows the
 *  promise chain until the process OOMs with no useful diagnostic. Modeled as
 *  an `AgencyAbort` (like `GuardExceededError`) so it propagates untouched
 *  through every generated catch rung and halts the run rather than being
 *  converted to a Failure and silently re-descending into the recursion. */
export class CallDepthExceededError extends AgencyAbort {
  readonly limit: number;
  readonly observed: number;
  constructor(limit: number, observed: number, recentFrames: string[]) {
    const chain = recentFrames.join(" → ");
    super(
      `Maximum call depth exceeded (${observed} > ${limit}). This usually ` +
        `means unbounded recursion. Recent calls: ${chain}. If your program ` +
        `legitimately recurses this deeply, raise the limit via the ` +
        `\`maxCallDepth\` config option.`,
      makeAbortCause({ kind: "callDepthExceeded", limit, observed }),
    );
    this.name = "CallDepthExceededError";
    this.limit = limit;
    this.observed = observed;
  }
}

/** Thrown by `runHandlerChain` (lib/runtime/interrupts.ts) when nested
 *  handler-chain dispatch depth exceeds `MAX_HANDLER_CHAIN_DEPTH`. Almost
 *  always indicates a handler raised an interrupt that re-enters the same
 *  handler (directly or via the chain dispatcher visiting every handler).
 *  Carries the interrupt effect that tripped the limit so the diagnostic
 *  points at the right place. */
export class HandlerRecursionError extends Error {
  readonly effect: string;
  readonly depth: number;
  constructor(effect: string, depth: number) {
    super(
      `Handler chain dispatch nested ${depth} levels deep while handling ` +
        `interrupt of effect "${effect}". This usually means a handler raised an ` +
        `interrupt that re-entered itself (the chain dispatcher visits every ` +
        `handler, even after one approves). Check whether the handler's body ` +
        `calls anything that raises an interrupt (\`with approve\`, file I/O, ` +
        `\`input()\`, etc.) and guard against re-entry — e.g. flip a sentinel ` +
        `flag BEFORE the call, not after.`,
    );
    this.name = "HandlerRecursionError";
    this.effect = effect;
    this.depth = depth;
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof AgencyAbort) return true;
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  ) {
    return true;
  }
  // Cross-module / cross-realm fallback: the `instanceof AgencyAbort` check
  // above misses an error reconstructed from a different module instance
  // (the spawned agent process under the resolver shim, etc.). Match by
  // `name` so abort identity survives even though `agencyCause` may not
  // survive serialization (spec §9). Note the `name === X || name === Y`
  // form — a chained `X || "Y" || "Z"` would always be truthy.
  if (error instanceof Error) {
    return (
      error.name === "AgencyAbort" ||
      error.name === "AgencyCancelledError" ||
      error.name === "GuardExceededError" ||
      error.name === "AbortError"
    );
  }
  return false;
}