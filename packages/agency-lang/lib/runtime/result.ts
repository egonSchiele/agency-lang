import { z } from "zod";
import { isAbortError, readCause } from "./errors.js";
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
  retryable?: boolean;
  functionName?: string;
  args?: Record<string, any>;
};

export type ResultFailure = {
  __type: "resultType";
  success: false;
  error: any;
  checkpoint: any;
  retryable: boolean;
  functionName: string | null;
  args: Record<string, any> | null;
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
    retryable: opts?.retryable ?? false,
    functionName: opts?.functionName ?? null,
    args: opts?.args ?? null,
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
      // Mark the trip delivered so the runner's `shouldSkip` (which may
      // step the guard's own `_popGuard` next, while the signal is still
      // aborted) does NOT re-throw a GuardExceededError for the same
      // trip. The cause object is shared by identity with `signal.reason`.
      guardCause.delivered = true;
      return failure(
        guardFailureData(guardCause.dimension, guardCause.limit, guardCause.spent),
        opts,
      );
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
