/**
 * AsyncLocalStorage-based runtime context for stdlib functions.
 *
 * Replaces the "context-injected builtin" pattern (`__internal_foo` names
 * that get the codegen-rewrite treatment to prepend `__ctx, __stateStack,
 * __threads` as the first three args). Stdlib functions that need access
 * to `ctx`/`stack`/`threads` call `getRuntimeContext()` to read them from
 * an ALS store seeded at three well-defined points:
 *
 *  1. `runNode` (lib/runtime/node.ts) — wraps every fresh agent run in
 *     the top-level `agencyStore.run(...)` frame.
 *  2. `Runner.runInScope` (lib/runtime/runner.ts) — every callback-taking
 *     method (step, hook, pipe, fork) re-enters `agencyStore.run(...)`
 *     so the scope-local `stack` (and per-fork branch stack) is visible
 *     to stdlib helpers running inside that step.
 *  3. `runBatch`'s `runInBranchAlsFrame` (lib/runtime/runBatch.ts) —
 *     each branch body sees its own branch stack (and thus its own
 *     abort signal) before invoking the child body.
 *
 * Note: subprocess bootstrap deliberately does NOT install its own ALS
 * frame. Each child process re-enters runNode (which installs the
 * frame) on its own, so threading a frame across the IPC boundary
 * would be redundant.
 *
 * See docs/superpowers/plans/2026-05-25-als-migration.md.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeContext } from "./state/context.js";
import type { StateStack } from "./state/stateStack.js";
import type { ThreadStore } from "./state/threadStore.js";

export type AgencyStore = {
  ctx: RuntimeContext<any>;
  stack: StateStack;
  threads: ThreadStore;
};

export const agencyStore = new AsyncLocalStorage<AgencyStore>();

/**
 * Read the current Agency runtime context from ALS. Throws if called
 * outside an `agencyStore.run(...)` frame — which in practice means a
 * stdlib helper was called from non-Agency code. Tests that exercise
 * stdlib functions directly should wrap their bodies in
 * `runInTestContext(ctx, stack, threads, fn)`.
 */
export function getRuntimeContext(): AgencyStore {
  const s = agencyStore.getStore();
  if (!s) {
    throw new Error(
      "getRuntimeContext() called outside an Agency execution frame. " +
        "This usually means a stdlib helper was called from non-Agency code. " +
        "Wrap your invocation in agencyStore.run({ctx, stack, threads}, fn) " +
        "or use runInTestContext().",
    );
  }
  return s;
}

/**
 * Convenience wrapper for tests that construct a RuntimeContext manually
 * and need to invoke stdlib helpers that read from ALS. Mirrors
 * `agencyStore.run(...)` but with explicit named parameters so test
 * bodies don't have to import `agencyStore` directly.
 */
export function runInTestContext<T>(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  threads: ThreadStore,
  fn: () => T,
): T {
  return agencyStore.run({ ctx, stack, threads }, fn);
}
