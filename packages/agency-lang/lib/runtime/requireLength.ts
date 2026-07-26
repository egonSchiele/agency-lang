/**
 * Guard for a destructuring pattern whose rest binder has elements after it:
 * `const [a, ...mid, b] = xs`.
 *
 * Matching protects itself — an array pattern emits a length check, so a value
 * too short to fill both ends simply does not match. A DECLARATION emits no
 * such check: it binds rather than tests. Without this, `["a"]` would bind
 * both `a` and `b` to the same element, because `xs[xs.length - 1]` is
 * `xs[0]`, and the wrong values would be silent.
 *
 * Throws, which Agency surfaces as a `failure` Result — the behavior
 * `pattern-matching.md` already documents for a destructuring that cannot be
 * satisfied, and what Python does for `a, *m, b = ["x"]`.
 */
export function __requireLength(value: unknown[], min: number): unknown[] {
  if (value.length < min) {
    throw new TypeError(
      `cannot destructure ${value.length} element${value.length === 1 ? "" : "s"} ` +
        `into a pattern that needs at least ${min}`,
    );
  }
  return value;
}
