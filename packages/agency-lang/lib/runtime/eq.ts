/**
 * Equality with unified nullish semantics. `null` and `undefined` are one
 * nothing-value in Agency, so `==`/`!=` (and `===`/`!==`) lower to this helper
 * instead of strict `===`/`!==`. For two non-nullish values it is identical to
 * `===`; the only difference is that `null` and `undefined` compare equal.
 *
 * `a == null` (loose) is true for exactly `null` and `undefined` (never `0`,
 * `""`, `false`, `NaN`), so `(a == null && b == null)` means "both nullish."
 *
 * See docs/dev/null-and-undefined.md.
 */
export function __eq(a: unknown, b: unknown): boolean {
  return a === b || (a == null && b == null);
}
