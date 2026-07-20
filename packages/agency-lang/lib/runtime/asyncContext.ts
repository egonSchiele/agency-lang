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
import process from "node:process";
import { BootstrapThreadStore } from "./state/bootstrapThreadStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { GlobalStore } from "./state/globalStore.js";
import type { StateStack } from "./state/stateStack.js";
import type { ThreadStore } from "./state/threadStore.js";
import type { Runner } from "./runner.js";
import type { HandlerFn } from "./types.js";

export type CallsiteLocation = {
  moduleId: string;
  scopeName: string;
  stepPath: string;
};

export type AgencyStore = {
  ctx: RuntimeContext<any>;
  stack: StateStack;
  threads: ThreadStore;
  /**
   * Per-scope GlobalStore. Today pointer-shares the `RuntimeContext`'s
   * canonical store at every frame builder, so behavior matches the
   * pre-ALS code that emitted `__ctx.globals.…` directly. The slot
   * exists separately from `ctx.globals` to allow per-branch
   * snapshotting (Stage 2): when `runInBranchAlsFrame` clones the
   * parent's store, the branch's frame holds the clone and the
   * generated `__globals()!` accessor sees the branch-local view
   * without disturbing the parent's globals.
   */
  globals: GlobalStore;
  /**
   * Per-call-site source location for the currently-executing step.
   * Seeded by `Runner.runInScope` for every step body. Stdlib helpers
   * that need to attribute a checkpoint to its originating step
   * (`checkpoint()`) read this slot instead of receiving the location
   * as a trailing positional arg from generated code.
   *
   * Optional because not every ALS frame has one: the top-level
   * `runNode` frame and `runInBootstrapFrame` deliberately omit it
   * (any checkpoint created in bootstrap scope gets the empty
   * `""::""::""` fallback, matching pre-ALS behaviour).
   */
  callsite?: CallsiteLocation;
  /**
   * The `Runner` driving the currently-executing step, if any.
   * Seeded by `Runner.runInScope` so TS helpers like `agency.interrupt`
   * can call `runner.halt(...)` without having to receive the runner
   * as an argument. Absent in bootstrap frames and in the outer
   * `withResumableScope` body frame (only inside `s.step(...)` does
   * a Runner come into scope).
   */
  runner?: Runner;
};

export const agencyStore = new AsyncLocalStorage<AgencyStore>();

/**
 * Push a new ALS frame copying the current ctx/stack/threads but
 * overriding `callsite`. For TS helpers that want to attach a
 * per-internal-substep checkpoint location to nested `checkpoint()`
 * calls. Throws if called outside any agency frame (no inheritable
 * base).
 */
export function withCallsite<T>(loc: CallsiteLocation, fn: () => T): T {
  const store = agencyStore.getStore();
  if (!store) {
    throw new Error("withCallsite() called outside an Agency execution frame.");
  }
  return agencyStore.run({ ...store, callsite: loc }, fn);
}

/**
 * Run `fn` with `handler` pushed onto `ctx.handlers`; pop in finally.
 * Two call sites consume this: `AgencyFunction.invoke()`'s preapprove
 * branch and (in a future PR) `agency.withHandler`. Co-locating the
 * combinator here means neither call site repeats the push/try/finally
 * dance and there is no circular import between agencyFunction.ts and
 * the agency namespace module.
 */
export async function withPushedHandler<T>(
  ctx: RuntimeContext<any>,
  handler: HandlerFn,
  fn: () => Promise<T>,
  liveGuardIds?: string[],
): Promise<T> {
  // TS-side registration captures the live guard set AT CALL TIME, with
  // no memo: TS callers sit outside the checkpoint replay machinery and
  // own their own re-execution semantics (unlike Agency handle blocks,
  // which memoize in Runner.handle). An explicit `liveGuardIds` wins —
  // preapprove() passes [] because its handler registers conceptually
  // above any guard (and its body never spends).
  const captured =
    liveGuardIds ??
    agencyStore.getStore()?.stack?.guards.map((g) => g.guardId) ??
    [];
  ctx.pushHandler(handler, captured);
  try {
    return await fn();
  } finally {
    ctx.popHandler();
  }
}

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
 * Generated-code accessor for the current per-scope ThreadStore. Replaces
 * the codegen-emitted `__threads` local that the pre-ALS pipeline used to
 * declare in every function/node body's setup block. Every call site that
 * used to reference the `__threads` local now invokes this helper, which
 * reads through `agencyStore` — the same path that stdlib helpers take.
 *
 * Returns the store from the active ALS frame when one is present:
 * Runner step bodies (set up by `Runner.runInScope`), node/function setup
 * code that runs inside `runNode` (top-level frame), and bootstrap scopes
 * (where the store is a `BootstrapThreadStore` sentinel that loudly
 * throws on user-facing operations).
 *
 * Returns `undefined` when no frame is installed. This matches the
 * lenient pre-migration behavior at sites like `blockSetup`, which
 * checked `typeof __threads !== "undefined"` so a block invoked outside
 * any node body (e.g. as a tool by an LLM) still bootstrapped a fresh
 * `ThreadStore` via `setupFunction`'s fallback. Code that needs the
 * stricter throw-on-missing behavior should call `getRuntimeContext()`
 * directly.
 */
export function __threads(): ThreadStore | undefined {
  return agencyStore.getStore()?.threads;
}

/**
 * Generated-code accessor for the current StateStack. Mirrors
 * `__threads()` — reads from the active `agencyStore` frame. Returns
 * `undefined` when no frame is installed; the call sites that may run
 * without one (notably the `finally` block in `classMethod.mustache`
 * that pops the per-scope frame when a function is called as a tool
 * outside any Agency execution frame) defend with `?.pop()` /
 * `?.method(...)`. Code that needs the strict-throw behavior should
 * call `getRuntimeContext().stack` directly.
 */
export function __stateStack(): StateStack | undefined {
  return agencyStore.getStore()?.stack;
}

/**
 * Generated-code accessor for the current RuntimeContext. Mirrors
 * `__threads()` — reads from the active `agencyStore` frame. Returns
 * `undefined` when no frame is installed. Sites where dereferencing
 * `undefined` would produce an opaque `TypeError` should use
 * `getRuntimeContext().ctx` instead so the missing-frame case throws
 * the dedicated error with a pointer to `runInTestContext`.
 */
export function __ctx(): RuntimeContext<any> | undefined {
  return agencyStore.getStore()?.ctx;
}

/**
 * Generated-code accessor for the current per-scope GlobalStore. Mirrors
 * `__threads()` / `__stateStack()` / `__ctx()`. Returns the GlobalStore
 * from the active ALS frame when one is present (every Runner step body,
 * node/function setup code, `runInBranchAlsFrame` body, and
 * `runInBootstrapFrame` body all seed this slot). Returns `undefined`
 * when no frame is installed.
 *
 * Generated code typically dereferences this with `__globals()!.…`
 * because every code-emission site that uses it runs inside an Agency
 * execution frame by construction. The pre-ALS counterpart was
 * `__ctx.globals.…` against the setupEnv-emitted local.
 *
 * The slot is distinct from `ctx.globals` so that Stage 2 can clone the
 * parent's store at fork-time into the branch's ALS frame without
 * mutating the canonical `RuntimeContext.globals` reference.
 */
export function __globals(): GlobalStore | undefined {
  return agencyStore.getStore()?.globals;
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
  return agencyStore.run({ ctx, stack, threads, globals: ctx.globals }, fn);
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
    {
      ctx,
      stack: ctx.stateStack,
      threads: new BootstrapThreadStore(),
      // Seed the canonical store. Bootstrap frames are never inside a
      // fork branch (init / top-level callback registration / lifecycle
      // hooks all run outside any per-branch ALS frame), so pointer-
      // sharing is exactly right: writes done by `__initializeGlobals`
      // land on the RuntimeContext's store and persist across the run.
      globals: ctx.globals,
    },
    fn,
  );
}
