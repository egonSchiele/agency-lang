import { __globals } from "../runtime/asyncContext.js";

/**
 * Attach a tag to a value. Primitives are keyed by value (all equal
 * primitives share tags); objects by reference. No-op outside an Agency
 * execution frame, matching the lenient stdlib convention.
 */
export function _tag(value: unknown, key: string, val: unknown): void {
  const g = __globals();
  if (!g) return;
  g.setTag(value, key, val);
}

/** Return a shallow copy of a value's tags, or {} if none. */
export function _getTags(value: unknown): Record<string, unknown> {
  const t = __globals()?.getTagsFor(value);
  return t ? { ...t } : {};
}

/** Mark a value so it is replaced with "[REDACTED]" in state logs. */
export function _redact(value: unknown): void {
  __globals()?.markRedacted(value);
}
