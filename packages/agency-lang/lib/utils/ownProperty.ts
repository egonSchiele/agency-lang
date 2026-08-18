/**
 * Read a key from a record without falling through to `Object.prototype`.
 *
 * Records keyed by outside data (trace ids, user-chosen names) can hold a
 * key like `toString` or `__proto__`. On a plain object a plain lookup of a
 * missing key then returns the inherited function instead of `undefined`,
 * and the caller trips over it later. Use this for every read of such a
 * record, and `Object.create(null)` for the ones this code builds itself.
 */
export function own<Value>(
  record: Readonly<Record<string, Value>>,
  key: string,
): Value | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
