# Browser async-context seam

**Status:** this file describes code that is due to be deleted. The decision in
`running-without-node.md` is that Agency does not use `AsyncLocalStorage` on
either target, so nothing will need to pick between two classes. Until the
removal lands, this is how the code works.

## The problem

The runtime reads its per-run frame from an `AsyncLocalStorage` (the `agencyStore`
in `asyncContext.ts` plus five smaller stores in `interrupts.ts`,
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

A browser build selects `lib/runtime/platform/asyncLocalStorage.browser.ts` via
the `"browser"` field in `package.json`:

```json
"browser": {
  "./dist/lib/runtime/platform/asyncLocalStorage.js": "./dist/lib/runtime/platform/asyncLocalStorage.browser.js"
}
```

Bundlers such as esbuild, vite, and webpack follow that mapping. Node, tsc, and
the tests ignore it and use the real class.

The browser file picks one of two stores when it loads:

| The engine has | Store | Does the build need the `async` rewrite? |
| --- | --- | --- |
| native TC39 `AsyncContext` | a thin adapter over `AsyncContext.Variable` | No |
| no `AsyncContext` | `PromiseContextStorage` | Yes |

No engine ships `AsyncContext` today, so every browser gets the second store.
The first row is there so a build picks up the native API on the day an engine
has it, with no change here.

The file also exports `PORTABLE_CONTEXT`. It is true when the second store is in
use. `AgencyFunction.create` reads it and refuses a function that is still a
real `async` function.

## Why the second store needs a rewrite

`await` is syntax. A library cannot attach to it, so a library alone cannot
carry a value across it. `.then` is a function, and a library can replace it.

`PromiseContextStorage` therefore depends on a build step that rewrites every
`async` function into promise code, so each `await` becomes a `.then` call. The
store wraps `.then` and puts the context back when the callback runs.
`portable-context-spike.md` explains the mechanism, shows the test results, and
lists what a full browser build still needs.

## Why not pass the context as a parameter

| | This seam | Context passed as a parameter |
| --- | --- | --- |
| Files changed | 6 store files, 0 read sites | about 205 read sites, plus code generation and templates |
| Needs a build step | the `async` rewrite, until engines ship `AsyncContext` | no |
| Changes the `agency.*` helper API | no | yes |
| Node behaviour | unchanged | unchanged, but a large change to review |

Passing the context as a parameter stays the fallback if the rewrite fails in a
way the tests did not find.

## Tests

`lib/runtime/platform/asyncLocalStorage.test.ts` covers:

- the Node re-export: context across an `await`, and `exit`;
- the adapter over an injected `AsyncContext.Variable`;
- that the browser file picks `PromiseContextStorage` when the engine has no
  `AsyncContext`.

`lib/runtime/platform/promiseContextStorage.test.ts` covers the second store.
