/**
 * Per-guard scope state. Held on `StateStack.guards` as an array;
 * `pushGuard` appends, `popGuard` removes the last entry. Serialized
 * with the rest of the stack via `toJSON`/`fromJSON` so guards
 * survive interrupt + resume cycles.
 *
 * V1 only supports cost guards. The shape leaves room for additional
 * limit types (e.g. `timeoutMs`) without forcing a breaking change to
 * GuardFailureData consumers.
 */
export type GuardEntry = {
  /** The limit, in dollars. */
  costLimit: number;
  /** Stack cost at the moment this guard scope opened. The guard trips
   *  when `(currentLocalCost - costAtPush) > costLimit`. Storing the
   *  baseline keeps the check independent of any siblings' cost that
   *  was already on the stack before the guard scope began. */
  costAtPush: number;
};

/**
 * Thrown by `prompt.ts` immediately after an LLM call's cost is
 * accumulated into `targetStack.localCost`, when any active guard's
 * spend has exceeded its limit. Propagates as a normal JS error
 * through the call stack; the `guard` stdlib function's `try` catches
 * it and returns a Failure.
 *
 * Deliberately not an interrupt — see
 * `docs/superpowers/specs/2026-05-20-cost-and-guard-tracking-design.md`
 * sections "Mechanism" and "Layer 2: stdlib function".
 */
export class GuardExceededError extends Error {
  constructor(
    public readonly type: "cost",
    public readonly limit: number,
    public readonly spent: number,
  ) {
    super(`guard exceeded: ${type} limit ${limit}, spent ${spent}`);
    this.name = "GuardExceededError";
  }
}

export function isGuardExceededError(e: unknown): e is GuardExceededError {
  return e instanceof GuardExceededError;
}
