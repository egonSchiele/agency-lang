/**
 * The two helpers behind the join of an `async` block.
 *
 * `async f()` lowers to a fork with two arms: arm 0 runs the call, arm 1
 * runs the statements after it. When arm 1 runs to its end, it returns
 * `__asyncDone({ ...its bindings })`. When it returns early, from a user
 * `return`, from the `return` the compiler writes for a `?`, or from an
 * interrupt rejected in the arm, it returns that value instead. The join
 * asks `__asyncFinished` which of the two it got, and returns the early
 * value from the enclosing function.
 *
 * The marker is a plain key, not a Symbol, because a branch that finished
 * while its sibling waits on an interrupt has its result saved in the
 * checkpoint as JSON, and a Symbol would not survive that. The key starts
 * with `__`, which no Agency program can write, so a user value is never
 * mistaken for a completion. See docs/dev/runtime/async.md.
 */

const DONE_KEY = "__agencyAsyncDone";

/** Mark `bindings` as the normal completion of an `async` block's main
 *  arm. */
export function __asyncDone(bindings: Record<string, unknown>): Record<string, unknown> {
  return { ...bindings, [DONE_KEY]: true };
}

/** True when `armValue` is the marked object `__asyncDone` built. Takes any
 *  value: an early `return` can hand back `undefined`, a failure, or
 *  anything else the user returned. */
export function __asyncFinished(armValue: unknown): boolean {
  return (
    typeof armValue === "object" &&
    armValue !== null &&
    (armValue as Record<string, unknown>)[DONE_KEY] === true
  );
}
