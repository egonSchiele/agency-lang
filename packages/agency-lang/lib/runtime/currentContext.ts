import type { RuntimeContext } from "./state/context.js";

/**
 * Module-level reference to the currently executing RuntimeContext.
 *
 * stdlib functions don't receive `__ctx` as a parameter; they reach
 * runtime state through this singleton. `runNode` sets this before
 * starting an agent run and clears it in the `finally` block — see
 * the resolved decisions in docs/superpowers/plans/2026-05-12-memory-layer.md.
 *
 * v1 caveat: this is a single global, so two agent runs sharing the
 * same Node.js process cannot run concurrently and observe consistent
 * `getCurrentContext()` results across `await` boundaries. That matches
 * the documented single-writer-per-memoryId constraint.
 */
let _current: RuntimeContext<any> | null = null;

export function setCurrentContext(ctx: RuntimeContext<any> | null): void {
  _current = ctx;
}

export function getCurrentContext(): RuntimeContext<any> | null {
  return _current;
}
