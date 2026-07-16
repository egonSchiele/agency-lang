import { z } from "zod";
import { isAbortError, readCause } from "./errors.js";
import { isAborted } from "./abortedResult.js";
import { hasInterrupts } from "./interrupts.js";

/** Structured `GuardFailureData` for a tripped guard. Shared by the
 *  `guardTrip`-cause path (a trip that surfaced as an aborted leaf op)
 *  and the `GuardExceededError` path (a trip thrown at a sync point).
 *  Both must produce the identical Failure shape the stdlib `guard`
 *  documents. */
function guardFailureData(
  dimension: "cost" | "time",
  limit: number,
  spent: number,
): {
  type: string;
  maxCost: number | null;
  actualCost: number | null;
  maxTime: number | null;
  actualTime: number | null;
} {
  if (dimension === "time") {
    return {
      type: "timeoutFailure",
      maxCost: null,
      actualCost: null,
      maxTime: limit,
      actualTime: spent,
    };
  }
  return {
    type: "guardFailure",
    maxCost: limit,
    actualCost: spent,
    maxTime: null,
    actualTime: null,
  };
}

export type ResultValue = ResultSuccess | ResultFailure;

const resultValueSchema = z.union([
  z.object({ __type: z.literal("resultType"), success: z.literal(true), value: z.any() }),
  z.object({ __type: z.literal("resultType"), success: z.literal(false), error: z.any() }),
]);

export type ResultSuccess = {
  __type: "resultType";
  success: true;
  value: any;
};

export type FailureOpts = {
  checkpoint?: any;
  /** The call failed before its function body began (argument binding,
   *  arity, schema). Its only producer is the tool loop, from the invoke
   *  layer's pre-execution tag — trust-the-producer, because nothing can
   *  correct a wrongly-true claim. */
  neverStarted?: boolean;
  /** Execution entered a destructive region — a `destructive def` body (which
   *  commits at entry) or a `destructive { }` region. */
  destructiveRan?: boolean;
  functionName?: string;
  args?: Record<string, any>;
  /** The guard ids this `try` boundary OWNS. A `guardTrip` cause is
   *  converted to a Failure ONLY when its `guardId` is in this list;
   *  any other guard's trip (an outer guard, or a plain `try` that owns
   *  no guards) re-throws so it reaches its owning boundary. Set by the
   *  stdlib `guard`'s `_runGuarded`. Absent for a plain `try`. */
  ownedGuardIds?: string[];
};

/** One hop in a propagated failure's journey: the function whose body was
 *  skipped and the parameter that rejected the failure. */
export type SkippedFunction = { name: string; param: string };

export type ResultFailure = {
  __type: "resultType";
  success: false;
  error: any;
  checkpoint: any;
  /** The call failed before its function body began. Birth default false;
   *  set only by the tool loop from the invoke layer's pre-execution tag.
   *  Trust-the-producer: there is no correcting machinery, so nothing else
   *  may set it. */
  neverStarted: boolean;
  /** Execution had entered a destructive region — a `destructive def` body
   *  (commits at function entry) or a `destructive { }` region (commits at
   *  region entry) — when this failure was produced. Birth default false;
   *  boundaries OR the activation's flag in via stampFailureBoundary. */
  destructiveRan: boolean;
  functionName: string | null;
  args: Record<string, any> | null;
  skippedFunctions: SkippedFunction[];
};

export function success(value: any): ResultSuccess {
  return { __type: "resultType", success: true, value };
}

export function failure(error: any, opts?: FailureOpts): ResultFailure {
  return {
    __type: "resultType",
    success: false,
    error,
    checkpoint: opts?.checkpoint ?? null,
    // Birth false: boundary stamps are the authority. A false birth
    // default for destructiveRan is safe because the exit stamp ORs the
    // activation flag in; neverStarted has no correcting stamp, so its
    // sole producer sets it explicitly.
    neverStarted: opts?.neverStarted ?? false,
    destructiveRan: opts?.destructiveRan ?? false,
    functionName: opts?.functionName ?? null,
    args: opts?.args ?? null,
    skippedFunctions: [],
  };
}

/** Fold an activation's destructive flag into a failure crossing a
 *  boundary (function exit, block halt, block join). OR: once destructive
 *  work started anywhere below, the failure reports it. */
export function stampFailureBoundary(
  f: ResultFailure,
  destructiveRan: boolean,
): ResultFailure {
  f.destructiveRan = f.destructiveRan || destructiveRan;
  return f;
}

/** Record that destructive work ran in the given activation. Writes the
 *  slot the codegen flag lives in (frame.locals IS the generated
 *  function's __self — see lib/runtime/node.ts), so the exit stamp picks
 *  it up with no second source. Sole caller: the tool loop, when a
 *  destructive-marked tool executed or a tool failed destructively. */
export function markDestructiveWork(
  frame: { locals: Record<string, any> } | undefined,
): void {
  if (frame) {
    frame.locals.__destructiveRan = true;
  }
}

/** Shallow-clone a failure with one more skip entry. Used by the
 *  failure-propagation check when a call short-circuits: the ORIGINAL
 *  failure's error/functionName/args survive untouched so the origin is
 *  never hidden. `failure()` is the single initializer of
 *  skippedFunctions — no `?? []` fallback here (spec: no backward-compat
 *  handling for pre-feature serialized failures). */
export function propagateFailure(
  orig: ResultFailure,
  skipped: SkippedFunction,
): ResultFailure {
  return {
    ...orig,
    skippedFunctions: [...orig.skippedFunctions, skipped],
  };
}

export function isSuccess(result: unknown): result is ResultSuccess {
  return result != null && typeof result === "object" && (result as any).__type === "resultType" && (result as any).success === true;
}

export function isFailure(result: unknown): result is ResultFailure {
  return result != null && typeof result === "object" && (result as any).__type === "resultType" && (result as any).success === false;
}

/** Wrap a function call in try-catch, returning a Result.
 * If the function already returns a Result, pass it through (no double-wrapping). */
export async function __tryCall(fn: () => any, opts?: FailureOpts): Promise<ResultValue> {
  try {
    const value = await fn();
    // Interrupts are control flow, not values: a callee that paused on an
    // unresolved interrupt bubbles the Interrupt[] up as its return value,
    // and `try` must pass it through untouched — wrapping it in success()
    // would make the batch look like a completed Result and strand the
    // paused state. (First hit by `try _run(...)` when a subprocess
    // pauses; applies to any interrupting callee under `try`.)
    if (hasInterrupts(value)) return value as any;
    // Aborted results travel as values (lib/runtime/abortedResult.ts).
    // This boundary is where a guard turns its OWN trip into a Result:
    // salvage the partial as a success, or produce exactly the failure a
    // trip produced before saveDraft existed. A trip belonging to some
    // OUTER guard keeps travelling as a value — `try` must not catch it.
    if (isAborted(value)) {
      const cause = value.cause;
      if (
        cause.kind === "guardTrip" &&
        opts?.ownedGuardIds?.includes(cause.guardId)
      ) {
        // De-dup flag, shared by identity with the abort signal's cause:
        // the runner's shouldSkip must not re-throw an already-delivered
        // trip. Same contract as the exception path below.
        cause.delivered = true;
        const salvaged = value.deliver();
        if (salvaged !== undefined) {
          return success(salvaged.value);
        }
        return failure(
          guardFailureData(cause.dimension, cause.limit, cause.spent),
          opts,
        );
      }
      // Not this guard's trip: an outer guard's trip, or a non-guard
      // abort (Esc, kill, race loss). Pass the value through — `try`
      // must never swallow those. The caller's post-call check keeps it
      // travelling: defs and blocks stop with their own drafts, and a
      // node rebuilds the exception, so a kill still terminates the run
      // through the graph engine exactly as before.
      return value as any;
    }
    if (resultValueSchema.safeParse(value).success) return value;
    return success(value);
  } catch (error) {
    // Cancellation must always propagate — never get silently
    // converted into a Failure value. A `try fetch(...)` whose
    // underlying request was aborted by Ctrl-C, race-loser cleanup,
    // or a time guard must surface as an actual cancellation up
    // the call stack, not as a vague Failure that the caller might
    // swallow with `catch fallback`. See lib/stdlib/http.ts's
    // `runHttp` helper that translates DOMException("AbortError")
    // into AgencyCancelledError specifically so this re-throw fires.
    // A guard trip can surface here in TWO shapes: as a thrown
    // `GuardExceededError` (the trip caught at a sync point) OR as an
    // aborted leaf op (e.g. an in-flight `sleep`) whose cancellation
    // CARRIES a `guardTrip` cause. The cause-carrying shape is ALSO an
    // abort error, so this guardTrip check MUST run BEFORE the blanket
    // `isAbortError -> throw` below — otherwise `isAbortError` re-throws
    // the cancel first, the conversion never runs, and the bare cancel
    // escapes the guarded block as an unhandled rejection (the bug this
    // fixes). See docs/superpowers/specs/2026-06-21-abort-taxonomy-design.md.
    const guardCause = readCause(error);
    if (guardCause?.kind === "guardTrip") {
      // Convert to a Failure ONLY if THIS boundary owns the tripped guard.
      // An inner guard's `try` must re-throw an OUTER guard's trip (and a
      // plain `try`, which owns no guards, must re-throw any trip) so it
      // reaches the guard that actually set the limit — fixing the nested
      // outer-tighter-than-inner mis-attribution. See spec §4.1.1.
      if (opts?.ownedGuardIds?.includes(guardCause.guardId)) {
        // Mark the trip delivered so the runner's `shouldSkip` (which may
        // step the guard's own `_popGuard` next, while the signal is still
        // aborted) does NOT re-throw a GuardExceededError for the same trip.
        // The cause object is shared by identity with `signal.reason`.
        guardCause.delivered = true;
        // Backstop for trips still in exception form when they reach the
        // guard: a trip thrown from runtime code between the block and
        // this boundary (e.g. the subprocess adapter), where no compiled
        // frame existed to convert it into an AbortedResult. Exceptions
        // carry no partial — the value path above is the salvage path.
        return failure(
          guardFailureData(guardCause.dimension, guardCause.limit, guardCause.spent),
          opts,
        );
      }
      throw error; // belongs to an outer guard (or a plain try) — propagate
    }
    if (isAbortError(error)) {
      throw error;
    }
    // NOTE: a thrown GuardExceededError no longer needs its own branch here.
    // Since unification it is an AgencyAbort carrying a `guardTrip` cause, so
    // the `guardCause?.kind === "guardTrip"` branch above already converts it
    // (reading the same dimension/limit/spent off the cause). That branch is
    // the single place a guard trip becomes a Failure.
    return failure(
      error instanceof Error ? error.message : String(error),
      opts,
    );
  }
}

/** Unwrap a Result: return value on success, evaluate fallback on failure.
 * If the input is not a valid Result, returns it as-is. */
export function __catchResult(result: any, fallback: () => any): any {
  if (!resultValueSchema.safeParse(result).success) return result;
  if (result.success) return result.value;
  return fallback();
}

export async function __pipeBind(result: any, fn: (value: any) => any): Promise<any> {
  if (isFailure(result)) return result;
  const value = isSuccess(result) ? result.value : result;
  const output = await fn(value);
  // Propagate interrupts directly — they must bubble up to the node runner
  if (hasInterrupts(output)) {
    return output;
  }
  // Smart bind/fmap: if fn returns a Result, use it directly
  if (output != null && typeof output === "object" && (output as any).__type === "resultType" && typeof output.success === "boolean") {
    return output;
  }
  return success(output);
}
