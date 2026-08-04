import type { JsonValue } from "@/utils/canonicalize.js";

/**
 * The single projection from source data to a field value.
 *
 * Its exact output is hashed into every output id, so changing this function
 * changes the identity of every record derived from structured data. Treat it
 * as a wire format, not an implementation detail. No loader may substitute its
 * own rule.
 *
 * `String(value)` is deliberately not used: it renders an object as
 * "[object Object]", merging unrelated structured outputs into one meaningless
 * string.
 */
export function projectArtifactField(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
