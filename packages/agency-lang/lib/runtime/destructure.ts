/**
 * Object-rest helper: returns a shallow copy of `source` with `excludedKeys` omitted.
 * Used by `let { a, b, ...rest } = obj` lowering.
 */
export function __objectRest<T extends Record<string, unknown>>(
  source: T,
  excludedKeys: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const exclude = new Set(excludedKeys);
  for (const key of Object.keys(source)) {
    if (!exclude.has(key)) result[key] = source[key];
  }
  return result;
}

/**
 * Asserts that `source` is non-null and non-undefined before object destructuring.
 *
 * Throws a TypeError if the source is null/undefined. The error propagates up to
 * the surrounding `__tryCall` (used for safe function calls), which converts it
 * into a `failure` Result.
 */
export function __assertDestructurable(source: unknown): void {
  if (source == null) {
    throw new TypeError(
      `Cannot destructure ${source === null ? "null" : "undefined"}`,
    );
  }
}
