# Browser async-context seam

**Status:** prototype. Node behaviour is unchanged; this adds the swap point that
a browser / embedded build needs.

## The problem

The runtime reads its per-run frame from an `AsyncLocalStorage` (the `agencyStore`
in `asyncContext.ts` plus four satellite stores in `interrupts.ts`,
`callDepth.ts`, `executingHandlers.ts`, `hooks.ts`, and `statelogClient.ts`).
That class comes from `node:async_hooks`, which does not exist off Node. It is the
single biggest blocker for a browser / embedded build.

The ~205 sites that *read* the frame (`getRuntimeContext()`, `getStore()`, the
generated `__ctx()` / `__threads()` / `__stateStack()` / `__globals()` accessors)
never construct the store — they only read it. So the store's construction is the
only thing that has to change per platform.

## The seam

`lib/runtime/platform/asyncLocalStorage.ts` is the one import every store now goes
through. On Node it re-exports `node:async_hooks`'s `AsyncLocalStorage` verbatim,
so behaviour is byte-for-byte identical and the ~205 read sites don't change.

The six store files now import from the seam instead of `async_hooks`:

- `lib/runtime/asyncContext.ts`
- `lib/runtime/interrupts.ts`
- `lib/runtime/callDepth.ts`
- `lib/runtime/executingHandlers.ts`
- `lib/runtime/hooks.ts`
- `lib/statelogClient.ts`

That is the entire blast radius: **6 files, 0 call sites.** (Compare the
compiler-threaded-context route, which touches ~205 read sites; see
`docs/dev/compiler/compiler-threaded-context-spike.md`.)

The runtime uses only `new`, `run`, `getStore`, and `exit`, captured as
`ContextStorage<T>` in the seam so any platform implementation has an exact
contract.

## The browser implementation

`lib/runtime/platform/asyncLocalStorage.browser.ts` adapts the same surface onto
TC39 **AsyncContext** (`AsyncContext.Variable`), the standard web replacement for
`async_hooks`. A browser build selects it via the `"browser"` field in
`package.json`:

```json
"browser": {
  "./dist/lib/runtime/platform/asyncLocalStorage.js": "./dist/lib/runtime/platform/asyncLocalStorage.browser.js"
}
```

Bundlers (esbuild, vite, webpack) honour that mapping; Node, tsc, and the tests
ignore it and use the real class, so this is a pure no-op on the Node build.

## The catch: userland cannot cross `await`

This is the finding that decides the trade-off. Context propagation across
`async`/`await` is a language behaviour — `await` is syntax, not a call a library
can wrap. A userland polyfill can monkey-patch `setTimeout` and promise callbacks,
but it can **never** carry context across an `await`, and the runtime is full of
`await`s that must see the frame.

So this adapter relies on **native** `AsyncContext` (Stage 2; WebIDL integration
for web APIs was in progress as of Feb 2026). It throws a clear error when
`globalThis.AsyncContext` is absent rather than silently losing context. Until a
target engine ships it, a browser build needs either native `AsyncContext` or an
`await`-transpiling toolchain.

## What this means vs. compiler-threaded context

| | Seam + native AsyncContext | Compiler-threaded context |
| --- | --- | --- |
| Blast radius | 6 files, 0 call sites | ~205 read sites + codegen + templates |
| Works in browser today | only once native `AsyncContext` ships (or with await-transpile) | yes, no engine/polyfill dependency |
| Reverts prior work | no | yes (the ALS migration, #198–#201) |
| Node behaviour | unchanged | unchanged, but large churn |

The seam is the cheap, low-risk step and the right abstraction regardless: it lets
a browser build drop in native `AsyncContext` the moment it is available, and it
leaves the door open to plugging a threaded implementation behind the same seam
later if we ever want zero ambient context. The one thing it does **not** do is
make the browser work *today* on engines without native `AsyncContext` — that is
the specific gap compiler-threaded context closes.

## Tests

`lib/runtime/platform/asyncLocalStorage.test.ts` covers the Node re-export
(context across awaits, `exit`) and the browser adapter's mapping onto an injected
`AsyncContext.Variable` plus its loud failure when the API is missing.
