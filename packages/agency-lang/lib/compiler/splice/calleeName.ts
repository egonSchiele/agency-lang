import type { Splice } from "../../types/splice.js";

/** A splice calls its generator; anything else has no generator to name. */
export function calleeName(splice: Splice): string | null {
  const expression = splice.expression as { type: string; functionName?: string };
  return expression.type === "functionCall" && expression.functionName !== undefined
    ? expression.functionName
    : null;
}
