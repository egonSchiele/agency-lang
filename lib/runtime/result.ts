import { z } from "zod";

export type ResultValue = ResultSuccess | ResultFailure;

const resultValueSchema = z.union([
  z.object({ success: z.literal(true), value: z.any() }),
  z.object({ success: z.literal(false), error: z.any() }),
]);

export type ResultSuccess = {
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
  success: false;
  error: any;
  checkpoint: any;
  retryable: boolean;
  functionName: string | null;
  args: Record<string, any> | null;
};

export function success(value: any): ResultSuccess {
  return { success: true, value };
}

export function failure(error: any, opts?: FailureOpts): ResultFailure {
  return {
    success: false,
    error,
    checkpoint: opts?.checkpoint ?? null,
    retryable: opts?.retryable ?? false,
    functionName: opts?.functionName ?? null,
    args: opts?.args ?? null,
  };
}

export function isSuccess(result: ResultValue): result is ResultSuccess {
  return result != null && result.success === true;
}

export function isFailure(result: ResultValue): result is ResultFailure {
  return result != null && result.success === false;
}

/** Wrap a function call in try-catch, returning a Result.
 * If the function already returns a Result, pass it through (no double-wrapping). */
export async function __tryCall(fn: () => any, opts?: FailureOpts): Promise<ResultValue> {
  try {
    const value = await fn();
    if (resultValueSchema.safeParse(value).success) return value;
    return success(value);
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : String(error),
      opts,
    );
  }
}

/** Unwrap a Result: return value on success, evaluate fallback on failure. */
export async function __catchResult(result: ResultValue, fallback: () => any): Promise<any> {
  if (result.success) return result.value;
  return await fallback();
}

export async function __pipeBind(result: ResultValue, fn: (value: any) => any): Promise<any> {
  if (!result.success) return result;
  const output = await fn(result.value);
  // Propagate interrupts directly — they must bubble up to the node runner
  if (output != null && typeof output === "object" && output.type === "interrupt") {
    return output;
  }
  // Smart bind/fmap: if fn returns a Result, use it directly
  if (output != null && typeof output === "object" && "success" in output && typeof output.success === "boolean") {
    return output;
  }
  return { success: true, value: output };
}
