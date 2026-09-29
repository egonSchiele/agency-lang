/**
 * Browser implementation of the async-context seam (see
 * `asyncLocalStorage.ts`). A browser build selects this file via the
 * `"browser"` field in `package.json`; Node builds, tsc, and the tests use the
 * Node re-export instead.
 *
 * It adapts the runtime's `AsyncLocalStorage` surface onto the TC39
 * **AsyncContext** API (`AsyncContext.Variable`), the standard replacement for
 * `node:async_hooks` on the web platform.
 *
 * ## Important limitation
 *
 * A userland polyfill CANNOT fully replace `AsyncLocalStorage` in the browser,
 * because context propagation across `async`/`await` is a language-level
 * behaviour — `await` is syntax, not a call a library can wrap. Monkey-patching
 * `setTimeout`/promise callbacks covers event-loop hops but never `await`, and
 * the runtime is full of `await`s that must see the frame. So this adapter
 * relies on **native** `AsyncContext` (Stage 2; WebIDL integration for web APIs
 * was in progress as of Feb 2026). Until a target engine ships it, a browser
 * build needs either native `AsyncContext` or an `await`-transpiling toolchain —
 * at which point the compiler-threaded-context route (which needs neither)
 * becomes the comparison. This file makes the seam ready for native
 * `AsyncContext` and fails loudly when it is absent.
 */

// Minimal shape of the parts of TC39 AsyncContext we use. Declared locally so
// this file typechecks under the Node build without DOM/experimental lib types.
type AsyncContextVariable<T> = {
  get(): T | undefined;
  run<R>(value: T, fn: () => R): R;
};

type AsyncContextNamespace = {
  Variable: new <T>(options?: { name?: string; defaultValue?: T }) => AsyncContextVariable<T>;
};

function getNativeAsyncContext(): AsyncContextNamespace | undefined {
  return (globalThis as { AsyncContext?: AsyncContextNamespace }).AsyncContext;
}

export class AsyncLocalStorage<T> {
  private readonly variable: AsyncContextVariable<T | undefined>;

  constructor() {
    const asyncContext = getNativeAsyncContext();
    if (asyncContext === undefined) {
      throw new Error(
        "The browser async-context seam requires native AsyncContext " +
          "(globalThis.AsyncContext), which this engine does not provide. " +
          "Userland cannot propagate context across await. See " +
          "docs/dev/runtime/browser-async-context-seam.md.",
      );
    }
    this.variable = new asyncContext.Variable<T | undefined>();
  }

  getStore(): T | undefined {
    return this.variable.get();
  }

  run<R>(store: T, fn: () => R): R {
    return this.variable.run(store, fn);
  }

  /**
   * `AsyncLocalStorage.exit(fn)` runs `fn` with no active store. AsyncContext
   * has no dedicated `exit`, so we run the variable with `undefined`, which
   * makes `getStore()` return `undefined` inside `fn` — the same observable
   * behaviour.
   */
  exit<R>(fn: () => R): R {
    return this.variable.run(undefined, fn);
  }
}
