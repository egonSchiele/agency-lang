import { z } from "zod";
import { success, failure } from "./result.js";
import type { ResultValue } from "./result.js";

export class Schema {
  private zodSchema: z.ZodType;

  constructor(zodSchema: z.ZodType) {
    this.zodSchema = zodSchema;
  }

  parse(data: unknown): ResultValue {
    const result = this.zodSchema.safeParse(data);
    if (result.success) {
      return success(result.data);
    }
    return failure(result.error.message);
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
  const result = schema.safeParse(value);
  if (result.success) {
    return success(result.data);
  }
  return failure(result.error.message);
}
