/**
 * Platform seam for the runtime's ambient context store.
 *
 * The runtime keeps its per-run frame in an `AsyncLocalStorage` (see
 * `lib/runtime/asyncContext.ts` and four satellite stores). That class comes
 * from `node:async_hooks`, which does not exist in the browser or other
 * embedded targets — it is the single biggest thing keeping the runtime
 * Node-only.
 *
 * Rather than change the ~205 call sites that read the frame, we route the ONE
 * import through this seam. On Node (and any build that does not remap it) this
 * file re-exports the real `node:async_hooks` class verbatim, so behaviour is
 * identical and nothing else changes. A browser build swaps this module for
 * `asyncLocalStorage.browser.ts` via the `"browser"` field in `package.json`.
 *
 * The runtime uses a deliberately small slice of the `AsyncLocalStorage` API —
 * `new`, `run`, `getStore`, and `exit` — captured in `ContextStorage<T>` below
 * so the browser adapter has an exact contract to satisfy.
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
 * SPIKE switch. With `AGENCY_PORTABLE_CONTEXT=1` every store is the
 * promise-tracking one from `promiseContextStorage.ts`, so the whole test
 * suite can run under Node without `async_hooks` carrying the context. It
 * only gives right answers on a build whose `async` functions were rewritten
 * (see `scripts/lower-async.mjs`).
 */
export const PORTABLE_CONTEXT: boolean = process.env["AGENCY_PORTABLE_CONTEXT"] === "1";

type ContextStorageClass = new <T>() => ContextStorage<T>;

export const AsyncLocalStorage: ContextStorageClass = PORTABLE_CONTEXT
  ? PromiseContextStorage
  : NodeAsyncLocalStorage;
