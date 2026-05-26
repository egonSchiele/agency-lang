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
 * # Frame kinds
 *
 * Frames installed by the runtime fall into two categories:
 *
 *  - **Node frames** — installed by `Runner.runInScope` and the wraps
 *    around `graph.run` inside `runNode`. The `threads` slot is the
 *    real per-run `ThreadStore` (or the per-fork branch's store) that
 *    survives across pushes/pops, gets serialized into checkpoints, and
 *    is what user code sees when it uses `systemMessage`/`userMessage`/
 *    `thread { ... }`.
 *
 *  - **Bootstrap frames** — installed by `runInBootstrapFrame(...)` for
 *    code that runs *outside* any agent node: module-level global init,
 *    top-level callback registration, and the small slice of resume/
 *    rewind logic that runs before `setupNode` reconstitutes the real
 *    ThreadStore. Bootstrap frames have a `BootstrapThreadStore` in the
 *    `threads` slot, which throws on every user-facing operation. The
 *    contract is: thread builtins do not work in bootstrap scope; if a
 *    user reaches for them there, they get a loud error instead of a
 *    silent write into a discarded store.
 *
 * See docs/dev/async-context.md for the full picture.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { BootstrapThreadStore } from "./state/bootstrapThreadStore.js";
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

/**
 * Wrap `fn` in an ALS frame suitable for code that runs *outside* any
 * agent node body — module-level global-init, top-level callback
 * registration, and the resume/rewind prelude. The `threads` slot is a
 * `BootstrapThreadStore` sentinel: any attempt to use a message-thread
 * builtin from inside `fn` throws with an actionable error rather than
 * silently writing into a placeholder that the runtime is about to
 * discard.
 *
 * The `stack` slot is the caller's current `ctx.stateStack`. At the
 * `runNode` / `respondToInterrupts` / `rewindFrom` `*registerTopLevel
 * Callbacks` and `onAgentStart` call sites that's the bare pre-restore
 * stack (no node frames pushed) — which is the contract
 * `__initializeGlobals` always expected. At the resume / rewind
 * `graph.run` call sites it's the restored stack carrying the
 * checkpoint frames; that's also fine because `Runner.runInScope` on
 * the first step re-enters ALS with the per-node ThreadStore.
 *
 * Declared `async` so synchronous throws inside `fn` (including the
 * very common case of the `BootstrapThreadStore` sentinel throwing)
 * surface as rejected promises for `.catch(...)` callers, not as
 * uncaught sync exceptions.
 */
export async function runInBootstrapFrame<T>(
  ctx: RuntimeContext<any>,
  fn: () => T | Promise<T>,
): Promise<T> {
  return agencyStore.run(
    { ctx, stack: ctx.stateStack, threads: new BootstrapThreadStore() },
    fn,
  );
}
