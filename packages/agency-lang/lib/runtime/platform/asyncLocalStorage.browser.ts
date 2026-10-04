/**
 * Browser implementation of the async-context seam (see
 * `asyncLocalStorage.ts`). A browser build selects this file via the
 * `"browser"` field in `package.json`; Node builds, tsc, and the tests use the
 * Node re-export instead.
 *
 * It picks one of two stores when the module loads:
 *
 *   - If the engine has native TC39 `AsyncContext`, the store is a thin
 *     adapter over `AsyncContext.Variable`. The engine carries the context
 *     across a real `await`, so the build needs no rewrite.
 *   - Otherwise the store is the promise-tracking one from
 *     `promiseContextStorage.ts`. That store only gives right answers on a
 *     build whose `async` functions were rewritten into promise code, so
 *     `PORTABLE_CONTEXT` is true and `AgencyFunction.create` refuses any
 *     function that was not rewritten.
 *
 * No engine ships `AsyncContext` today, so every browser gets the second
 * store. See docs/dev/runtime/portable-context-spike.md.
 */
import type { ContextStorage, ContextStorageClass } from "./asyncLocalStorage.js";
import { PromiseContextStorage } from "./promiseContextStorage.js";

// Minimal shape of the parts of TC39 AsyncContext we use. Declared locally so
// this file typechecks under the Node build without DOM/experimental lib types.
type AsyncContextVariable<T> = {
  get(): T | undefined;
  run<R>(value: T, fn: () => R): R;
};

export type AsyncContextNamespace = {
  Variable: new <T>(options?: { name?: string; defaultValue?: T }) => AsyncContextVariable<T>;
};

/** Build a store class on top of the engine's `AsyncContext.Variable`. */
function nativeContextStorage(asyncContext: AsyncContextNamespace): ContextStorageClass {
  return class NativeContextStorage<T> implements ContextStorage<T> {
    private readonly variable = new asyncContext.Variable<T | undefined>();

    getStore(): T | undefined {
      return this.variable.get();
    }

    run<R>(store: T, fn: () => R): R {
      return this.variable.run(store, fn);
    }

    /**
     * `AsyncLocalStorage.exit(fn)` runs `fn` with no active store.
     * AsyncContext has no `exit`, so we run the variable with `undefined`,
     * which makes `getStore()` return `undefined` inside `fn`.
     */
    exit<R>(fn: () => R): R {
      return this.variable.run(undefined, fn);
    }
  };
}

export type BrowserContextStorage = {
  AsyncLocalStorage: ContextStorageClass;
  /** True when the store needs a build with rewritten `async` functions. */
  PORTABLE_CONTEXT: boolean;
};

/**
 * Pick the store for an engine. `asyncContext` is the engine's `AsyncContext`
 * global, or `undefined` when it has none.
 */
export function pickContextStorage(
  asyncContext: AsyncContextNamespace | undefined,
): BrowserContextStorage {
  if (asyncContext === undefined) {
    return { AsyncLocalStorage: PromiseContextStorage, PORTABLE_CONTEXT: true };
  }
  return { AsyncLocalStorage: nativeContextStorage(asyncContext), PORTABLE_CONTEXT: false };
}

const picked = pickContextStorage(
  (globalThis as { AsyncContext?: AsyncContextNamespace }).AsyncContext,
);

export const AsyncLocalStorage: ContextStorageClass = picked.AsyncLocalStorage;
export const PORTABLE_CONTEXT: boolean = picked.PORTABLE_CONTEXT;
