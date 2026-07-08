import { getRuntimeContext } from "../runtime/asyncContext.js";
import type { GlobalStore } from "../runtime/state/globalStore.js";

// Shallow copy of a value's tags, or {}. Shallow on purpose: a tag whose value
// is itself an object is returned by reference (tag values are usually
// primitives). Callers must not mutate nested tag values.
function tagsCopy(globals: GlobalStore, value: unknown): Record<string, unknown> {
  const record = globals.getTagsFor(value);
  return record ? { ...record } : {};
}

/**
 * Attach a tag to a value and return the value's current tags. Primitives are
 * keyed by value (all equal primitives share tags); objects by reference.
 */
export function _tag(
  value: unknown,
  key: string,
  val: unknown,
): Record<string, unknown> {
  const { globals } = getRuntimeContext();
  globals.setTag(value, key, val);
  return tagsCopy(globals, value);
}

/**
 * Attach every key/value in `tags` to `value`, then return its current tags.
 */
export function _setTags(
  value: unknown,
  tags: Record<string, unknown>,
): Record<string, unknown> {
  const { globals } = getRuntimeContext();
  for (const key of Object.keys(tags)) globals.setTag(value, key, tags[key]);
  return tagsCopy(globals, value);
}

/** Return a shallow copy of a value's tags, or {} if none. */
export function _getTags(value: unknown): Record<string, unknown> {
  const { globals } = getRuntimeContext();
  return tagsCopy(globals, value);
}

/** Mark a value for statelog redaction and return its current tags. */
export function _redact(value: unknown): Record<string, unknown> {
  const { globals } = getRuntimeContext();
  globals.markRedacted(value);
  return tagsCopy(globals, value);
}

/** Remove a single tag from a value and return its remaining tags. */
export function _removeTag(value: unknown, key: string): Record<string, unknown> {
  const { globals } = getRuntimeContext();
  globals.removeTag(value, key);
  return tagsCopy(globals, value);
}

/** Remove all tags from a value and return the (now empty) tags. */
export function _removeAllTags(value: unknown): Record<string, unknown> {
  const { globals } = getRuntimeContext();
  globals.removeAllTags(value);
  return tagsCopy(globals, value);
}
