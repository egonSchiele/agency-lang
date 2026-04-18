import { z } from "zod";
import { success, failure, isFailure, isSuccess } from "./result.js";
import type { ResultValue, ResultFailure } from "./result.js";

export class Schema {
  private zodSchema: z.ZodType;

  constructor(zodSchema: z.ZodType) {
    this.zodSchema = zodSchema;
  }

  parse(data: unknown): ResultValue {
    return __validateType(data, this.zodSchema);
  }

  parseJSON(jsonString: string): ResultValue {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonString);
    } catch (e) {
      return failure(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    return this.parse(parsed);
  }
}

export function __validateType(value: unknown, schema: z.ZodType): ResultValue {
  // Don't validate failures — surface the original error, not a schema mismatch
  if (isFailure(value as any)) {
    return value as ResultFailure;
  }
  const result = schema.safeParse(value);
  if (result.success) {
    // If the validated value is already a Result, return it directly
    // instead of wrapping it in another success(). This avoids double-wrapping
    // when validating with Result types (e.g. const r: Result! = compute()).
    if (isSuccess(result.data as any) || isFailure(result.data as any)) {
      return result.data as ResultValue;
    }
    return success(result.data);
  }
  return failure(result.error.message);
}
