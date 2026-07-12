/**
 * Nullish-normalize: collapse `undefined` into Agency's single nothing-value,
 * `null`. Wraps the value sites where the JS runtime produces `undefined`
 * (missing object key, out-of-bounds index, unmatched `match`) so the
 * "only null exists" invariant holds at the value level, not just at `__eq`.
 *
 * `x ?? null` returns `null` for `null`/`undefined` and `x` unchanged for every
 * other value (including `0`, `""`, `false`, `NaN`). The operand is evaluated
 * exactly once, so wrapping a side-effecting expression is safe.
 *
 * See docs/dev/null-and-undefined.md.
 */
export function __nn<T>(x: T): T | null {
  return x ?? null;
}
