/**
 * classifyIterable — the single source of truth for "what Agency considers
 * iterable".
 *
 * Consumed by:
 *   - `Runner.loop` (runtime/runner.ts) — the `for (a, b in x)` statement
 *   - `_pairsOf` (stdlib/builtins.ts) — two-binder list comprehensions
 *
 * Both must agree, or `[f(x) for x in src]` behaves differently from
 * `for (x in src)`. Keeping one implementation is why this file exists;
 * PR #595 collapsed the equivalent hand-copied drift in the prelude list.
 *
 * Arrays iterate by element. Non-null objects iterate by key. Everything
 * else — null, undefined, numbers, STRINGS — iterates nothing, matching
 * how a JS `for...of` over a non-iterable simply does nothing rather than
 * crashing mid-flow.
 *
 * This returns a CLASSIFICATION, deliberately, not a built list of pairs.
 * `Runner.loop` holds the caller's array by reference and re-reads its
 * length each step, so a loop body that appends to the array it is
 * iterating keeps going (verified: `xs.push(99)` mid-loop yields
 * `1,2,3,99`). Returning a materialized snapshot would freeze the length
 * at entry and quietly break that, and would allocate a pair per item on
 * every `for` in every program. Sharing only the classification keeps the
 * anti-drift property — which is the actual goal — at zero behavioral or
 * allocation cost.
 */
export type IterationShape =
  | { kind: "array" }
  | { kind: "record"; keys: string[] }
  | { kind: "none" };

export function classifyIterable(src: unknown): IterationShape {
  if (Array.isArray(src)) {
    return { kind: "array" };
  }
  if (src != null && typeof src === "object") {
    return { kind: "record", keys: Object.keys(src) };
  }
  return { kind: "none" };
}
