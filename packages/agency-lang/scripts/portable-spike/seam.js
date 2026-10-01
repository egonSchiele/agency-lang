// What the seam resolves to in the browser bundle: the promise-tracking store,
// with no import of node:async_hooks at all.
export { PromiseContextStorage as AsyncLocalStorage } from "../../dist/lib/runtime/platform/promiseContextStorage.js";
export const PORTABLE_CONTEXT = true;
