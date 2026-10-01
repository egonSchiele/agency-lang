/**
 * SPIKE: compiler-threaded runtime context (no `node:async_hooks`).
 *
 * Today every stdlib helper and every generated accessor reads the current
 * frame from a `node:async_hooks` `AsyncLocalStorage` (`agencyStore` in
 * `lib/runtime/asyncContext.ts`). That import is the main thing keeping the
 * runtime off the browser / embedded targets.
 *
 * "Compiler-threaded context" removes the ambient store: the compiler passes
 * the frame in as an explicit parameter, generated call sites forward it, and
 * the accessors read it from that parameter instead of from ALS. No ambient
 * mechanism means no `async_hooks` and no polyfill.
 *
 * This file is a self-contained proof of the mechanism. It uses a small stand-in
 * for the real `AgencyStore` type so the behaviour can be exercised in a unit
 * test without constructing a full `RuntimeContext`. The real migration threads
 * the actual `AgencyStore` (see `lib/runtime/asyncContext.ts`); the shapes and
 * the accessor names line up so this reads as the same mechanism at small scale.
 *
 * Generated-code shape, before and after:
 *
 *   // today (ambient, needs async_hooks)
 *   const __ctx = getRuntimeContext().ctx;
 *   messages: __threads().getOrCreateActive()
 *
 *   // threaded (explicit, no async_hooks)
 *   const __ctx = ctxOf(__store);
 *   messages: threadsOf(__store).getOrCreateActive()
 *   // ...and the enclosing function is `async function main(__store, ...)`,
 *   // forwarding `__store` to every call it makes.
 *
 * See docs/dev/compiler/compiler-threaded-context-spike.md for the full sizing
 * and design.
 */

/**
 * Stand-in for the real `AgencyStore` (lib/runtime/asyncContext.ts). The real
 * migration threads that exact type; the slots below mirror its shape. Values
 * are typed `unknown` here only so the PoC needs no real runtime objects.
 */
export type ThreadedStore = {
  ctx: unknown;
  stack: unknown;
  threads: unknown;
  globals: unknown;
  callsite?: { moduleId: string; scopeName: string; stepPath: string };
};

/**
 * Threaded analogues of the generated `__ctx()` / `__threads()` /
 * `__stateStack()` / `__globals()` accessors. Each takes the threaded store
 * instead of reading `agencyStore.getStore()`.
 */
export function ctxOf(store: ThreadedStore): unknown {
  return store.ctx;
}

export function threadsOf(store: ThreadedStore): unknown {
  return store.threads;
}

export function stackOf(store: ThreadedStore): unknown {
  return store.stack;
}

export function globalsOf(store: ThreadedStore): unknown {
  return store.globals;
}

/**
 * Derive a child frame overriding some slots — the threaded analogue of the
 * seeding points that today call `agencyStore.run({ ...store, callsite }, fn)`
 * (`Runner.runInScope`, `runBatch`'s branch wrapper, `withCallsite`). The child
 * is a fresh object, so a fork branch overriding `stack` never disturbs the
 * parent frame.
 */
export function deriveStore(
  store: ThreadedStore,
  overrides: Partial<ThreadedStore>,
): ThreadedStore {
  return { ...store, ...overrides };
}

/**
 * The hard case, and the reason ALS was adopted in the first place.
 *
 * When control leaves the generated call graph and re-enters through an
 * event-loop callback — a `setTimeout`, a `.then` on a promise that escaped the
 * graph, an emitter handler, the IPC telemetry message handler — there is no
 * caller to thread `store` from. ALS carries the frame across that boundary for
 * free. Explicit threading has to capture the frame and re-bind it at every such
 * boundary; miss one and the callback silently runs with the wrong (or no)
 * context. `bindStore` is the capture primitive the compiler / runtime would
 * emit at those boundaries.
 */
export function bindStore<Args extends unknown[], R>(
  store: ThreadedStore,
  fn: (store: ThreadedStore, ...args: Args) => R,
): (...args: Args) => R {
  return (...args: Args) => fn(store, ...args);
}
