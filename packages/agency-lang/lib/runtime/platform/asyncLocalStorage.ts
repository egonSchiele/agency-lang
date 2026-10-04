/**
 * Platform seam for the runtime's ambient context store.
 *
 * The runtime keeps its per-run frame in an `AsyncLocalStorage` (see
 * `lib/runtime/asyncContext.ts` and five smaller stores). That class comes
 * from `node:async_hooks`, which does not exist in a browser.
 *
 * Every store imports the class from this one file, so the ~205 places that
 * read the frame do not change. On Node this file hands back the real
 * `node:async_hooks` class, and behaviour is identical. A browser build swaps
 * this module for `asyncLocalStorage.browser.ts` via the `"browser"` field in
 * `package.json`.
 *
 * The runtime uses a small slice of the `AsyncLocalStorage` API: `new`,
 * `run`, `getStore`, and `exit`. `ContextStorage<T>` below names that slice,
 * so every implementation has an exact contract to satisfy.
 *
 * See docs/dev/runtime/browser-async-context-seam.md.
 */
import { AsyncLocalStorage as NodeAsyncLocalStorage } from "node:async_hooks";
import process from "node:process";
import { PromiseContextStorage } from "./promiseContextStorage.js";

/**
 * The subset of `AsyncLocalStorage` the runtime actually depends on. Any
 * platform implementation of this seam must satisfy this shape. Node's
 * `AsyncLocalStorage` is a structural superset, so it satisfies this for
 * free.
 */
export type ContextStorage<T> = {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
  exit<R>(fn: () => R): R;
};

/**
 * Test switch. With `AGENCY_PORTABLE_CONTEXT=1` every store on Node is the
 * promise-tracking one from `promiseContextStorage.ts`, the store a browser
 * gets. This lets the existing tests run against it. It only gives right
 * answers when `async` functions were rewritten into promise code, which
 * `scripts/portable-loader.mjs` does as each module loads.
 */
export const PORTABLE_CONTEXT: boolean = process.env["AGENCY_PORTABLE_CONTEXT"] === "1";

export type ContextStorageClass = new <T>() => ContextStorage<T>;

export const AsyncLocalStorage: ContextStorageClass = PORTABLE_CONTEXT
  ? PromiseContextStorage
  : NodeAsyncLocalStorage;
