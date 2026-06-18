import type { JsonPath } from "./types.js";

/**
 * Read a value out of arbitrary data by a path of object keys / array indices.
 * Returns undefined if any segment is missing or descends into a non-object.
 */
export function getPath(root: unknown, path: JsonPath): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      current = typeof key === "number" ? current[key] : undefined;
    } else {
      current = (current as Record<string, unknown>)[key as string];
    }
    if (current === undefined) return undefined;
  }
  return current;
}
