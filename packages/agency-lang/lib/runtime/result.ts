import { z } from "zod";
import { isAbortError } from "./errors.js";
import { isGuardExceededError } from "./guard.js";
import { hasInterrupts } from "./interrupts.js";

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
    if (isAbortError(error)) {
      throw error;
    }
    // Preserve GuardExceededError's structured data so the stdlib
    // `guard` function can surface { type, maxCost, actualCost,
    // maxTime, actualTime } directly via `result.error`. Without
    // this branch the user would see only the stringified error
    // message and lose the numeric limits. See lib/runtime/guard.ts.
    if (isGuardExceededError(error)) {
      if (error.type === "time") {
        return failure(
          {
            type: "timeoutFailure",
            maxCost: null,
            actualCost: null,
            maxTime: error.limit,
            actualTime: error.spent,
          },
          opts,
        );
      }
      return failure(
        {
          type: "guardFailure",
          maxCost: error.limit,
          actualCost: error.spent,
          maxTime: null,
          actualTime: null,
        },
        opts,
      );
    }
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
