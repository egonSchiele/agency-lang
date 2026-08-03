/** A value that survives a JSON round trip unchanged. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * JSON with object keys sorted at every depth, so two structurally equal
 * values produce the same string and therefore the same hash.
 *
 * Arrays keep their order — order is meaningful there. `undefined` members are
 * dropped, which is what `JSON.stringify` does anyway; callers that need to
 * distinguish "absent" from "present and undefined" must not rely on this.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
