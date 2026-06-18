import type { JSONPath } from "./types.js";

/**
 * Read a value out of arbitrary data by a path of object keys / array indices.
 * String segments index objects; number segments index arrays. Returns
 * undefined if any segment is missing, mistyped for its container, or descends
 * into a non-object.
 */
export function getPath(root: unknown, path: JSONPath): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      if (typeof key !== "number") return undefined;
      current = current[key];
    } else {
      if (typeof key !== "string") return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    if (current === undefined) return undefined;
  }
  return current;
}
