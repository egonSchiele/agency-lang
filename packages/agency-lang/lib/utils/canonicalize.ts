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
 * Arrays keep their order — order is meaningful there. An `undefined` object
 * property is dropped and an `undefined` array element becomes `null`, which
 * is what `JSON.stringify` does; callers that must distinguish "absent" from
 * "present and undefined" cannot rely on this.
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
    // Null-prototype accumulator. On a normal object, assigning a "__proto__"
    // key sets the prototype instead of creating an own property, so the key
    // silently vanishes from the output — which means {"__proto__":{...},"a":2}
    // and {"a":2} canonicalize identically and therefore hash identically.
    // That is a content-hash collision an attacker controls.
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
