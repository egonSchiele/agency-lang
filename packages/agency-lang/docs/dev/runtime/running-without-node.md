# Running Agency without Node

This doc records the goals for running Agency outside Node, the rule that
follows from them, and the first decision made under that rule: Agency does
not use `AsyncLocalStorage`.

Read this before you propose any change that makes Agency behave differently
on Node and in a browser.

## Goals

1. **Agency code runs anywhere JavaScript runs.** The first place is an iPad
   app, inside a web view. A desktop browser is another. Hosted models stay
   supported in those places.
2. **There are two targets, Node and the browser.** This cannot be avoided.
   On Node, Agency reaches the file system, subprocesses, and the rest of
   what Unix offers. A browser has none of that.
3. **Branching between the two targets is kept to a minimum.** This goal
   decides most design questions in this area, so the next section explains
   it.

## Why branching is the cost that matters

A branch is any place where the code does one thing on Node and another in a
browser. It can be an `if`, a second implementation of a class, a second
build, or a compile flag that changes the generated code.

Each branch is paid for as long as it exists:

- Both sides have to be built.
- Both sides have to be tested, so CI runs the tests twice.
- A change can break one side and pass on the other.
- Every new feature has to be checked against both sides.

Some branching is required by goal 2. A browser build has to refuse Agency
code that reads a file. All other branching is a choice, and the default
choice is to not add it.

## The rule

Parts of Agency rely on Node today. Sort each one into one of two groups.

**It needs Node.** Reading a file needs a file system. Starting a subprocess
needs an operating system. These stay Node-only, and the browser target
reports them as unsupported.

**It relies on Node but does not need to.** `AsyncLocalStorage` is the
example. For these, remove the reliance on Node for both targets. Do not keep
the Node version and add a browser version beside it.

When you are deciding about a Node feature, go through these steps:

1. Ask whether the feature needs Node. If it does not, write one
   implementation that both targets use.
2. If it does need Node, put the difference in one of the places listed under
   [Where the targets may differ](#where-the-targets-may-differ). Do not add
   a new place.
3. Do not keep a Node-only implementation because it is faster, safer, or
   more familiar, unless you have measured what would be lost without it. A
   second implementation is a cost by default.
4. Measure what depends on the feature. Agency has one user, the owner of this repo, and
   most Agency code lives in this repo. So you can count exactly what depends
   on a feature. A change that breaks a pattern nothing uses is acceptable.

## Where the targets may differ

The plan is for the targets to differ in three places and nowhere else. None
of these is built yet.

| What differs | Where it lives |
| --- | --- |
| Platform calls, such as reading a file or an environment variable | One pair of files, `host.node.ts` and `host.browser.ts`, with the same exports |
| Which runtime modules are included | One entry point for the browser beside `lib/runtime/index.ts` |
| Which stdlib modules exist | One mark at the top of each Node-only module, which makes a browser build that imports it a compile error |

Generated code has one shape for both targets. The runtime is built once.

Other languages with several targets work the same way. TypeScript's compiler
never calls `fs`. It calls a `System` object, and Node and the browser
playground each supply one. Kotlin has `expect` and `actual`. Go picks whole
files by name, such as `file_js.go`. Dart has conditional imports.

## Decision: Agency does not use `AsyncLocalStorage`

Decided on 2026-10-03.

The code does not match this decision yet. PR
[#1167](https://github.com/egonSchiele/agency-lang/pull/1167) still builds
the context variables from `AsyncLocalStorage` on Node. See
[What the removal involves](#what-the-removal-involves).

### Background

The runtime keeps six context variables. Each holds one piece of information
about the current run.

| Context variable | File | What it holds |
| --- | --- | --- |
| `agencyStore` | `lib/runtime/asyncContext.ts` | the main run context |
| `callDepthContext` | `lib/runtime/callDepth.ts` | how deep the call stack is |
| `handlerChainDepthContext` | `lib/runtime/interrupts.ts` | how deep the handler chain is |
| `executingHandlersContext` | `lib/runtime/executingHandlers.ts` | which handlers are running |
| `_activeCallbacksContext` | `lib/runtime/hooks.ts` | which callbacks are running |
| `spanStorage` | `lib/statelogClient.ts` | the current logging span |

Each one is built from a context class. Today that class is Node's
`AsyncLocalStorage`, which keeps a value attached to a chain of `async` calls
even while other chains run in between. Browsers do not have it.

The replacement is `PromiseContextStorage`, in
`lib/runtime/platform/promiseContextStorage.ts`. It needs no Node. It works
only in rewritten code. "Rewritten" means that a build step turned each
`await` in a file into a `.then` call. `portable-context-spike.md` explains
why, and how the class works.

### The two options

**Option A: two context classes.** Node uses `AsyncLocalStorage`. The browser
uses `PromiseContextStorage`.

**Option B: one context class.** Both targets use `PromiseContextStorage`.
All of Agency's code is rewritten on both targets. This is the option chosen.

| | Option A: two classes | Option B: one class |
| --- | --- | --- |
| Context classes to maintain | 2 | 1 |
| Builds of the runtime | 2, one plain and one rewritten | 1, rewritten |
| Runs of the Agency test suites in CI | 2 | 1 |
| A failure can appear on one target only | yes | no, for context handling |
| Code that picks a class | about 130 lines in 2 files | none |
| Speed of an `await` on Node | unchanged | about 7.6 times slower |
| JavaScript stack traces on Node | unchanged | lose function names and callers |
| `Promise.prototype.then` on Node | untouched | replaced with a wrapper |
| TypeScript helpers | work unchanged | one pattern needs the rewrite |

### Why Option B

Option A is a branch that goal 3 says to avoid. The browser needs
`PromiseContextStorage` and the rewrite under either option, so Option A
keeps all of that work and adds a second class, a second build, and a second
CI run.

What Option A buys is small. It was measured, and the numbers are in the next
section. One test in the repo depends on `AsyncLocalStorage` in a way the
rewrite does not already cover.

### What Option B costs, measured

These were measured on 2026-10-03 on the branch for PR #1167.

**Speed.** The same code ran both ways, with 900,000 `await`s that each read
a context variable.

| | Time per `await` |
| --- | --- |
| Real `await` with `AsyncLocalStorage` | 47 nanoseconds |
| Rewritten, with `PromiseContextStorage` | 357 nanoseconds |

`tests/agency/handlers` has 65 tests and makes no model calls. It took 3.8
seconds before and 5.2 seconds after. A run that calls a model spends its
time waiting for the model.

**Stack traces.** Three functions call each other, and the innermost throws
after an `await`. With a real `await`:

```
Error: boom
    at failLeaf (body.js:19:11)
    at async failMiddle (body.js:23:12)
    at async failTop (body.js:26:12)
```

Rewritten:

```
Error: boom
    at body.rewritten.js:45:13
    at Generator.next (<anonymous>)
    at fulfilled (body.rewritten.js:5:24)
    at bound (promiseContextStorage.js:38:29)
```

The function names, the two callers, and the original line numbers are gone.
Source maps would restore the line numbers. The callers do not come back,
because Node tracks them only across a real `await`.

**The `.then` wrapper.** `PromiseContextStorage` replaces
`Promise.prototype.then` for the whole process. A user's own `.then` and
`await` behave as before.

| User code | Before | After |
| --- | --- | --- |
| `.then(...)` | 96 nanoseconds | 166 nanoseconds |
| `await` | 16 nanoseconds | 16 nanoseconds |

Another library that also replaces `Promise.prototype.then` could clash with
it. Some monitoring tools do this. None has been tested.

**TypeScript helpers.** A helper is a TypeScript function that Agency code
imports and calls. A helper that is not rewritten loses the context at its
first real `await`. That matters only when the helper then calls back into
Agency:

```js
// Agency calls fakeRepl and hands it an Agency function, onSubmit.
export async function fakeRepl(onSubmit) {
  for (const line of lines) {
    await __call(onSubmit, { type: "positional", args: [line] });
  }
}
```

The first call to `onSubmit` works. The second call comes after an `await`,
so it has no context and fails. Rewriting the helper fixes it.

TypeScript that calls an exported node is unaffected. Each call to a node
sets up its own context.

How much code has this pattern was measured two ways.

1. By reading the code. Outside `lib/runtime` and `lib/stdlib`, 15
   hand-written files read a context variable: 2 in other packages and 13
   test helpers. None reads it after an `await`.
2. By running the tests. Both suites ran on `PromiseContextStorage` with
   every hand-written file under `tests/` left as written, about 1,200 files.

| Suite | Passed |
| --- | --- |
| `tests/agency` | 1762 of 1763 |
| `tests/agency-js` | 188 of 189 |

The `agency-js` failure is `agent-session-resume`, which has the `fakeRepl`
helper above. It passes when the helper is rewritten. The `tests/agency`
failure has a different cause and is listed under
[Open problems](#open-problems).

The compiler already processes each `.ts` file that Agency code imports, in
`lib/importStrategy.ts`. It can rewrite them in the same step, so a `.ts`
helper would need nothing from its author. A `.js` helper is loaded as
written. Neither case has been tested.

### Other options that were set aside

- **Pass the context as a parameter.** This needs no rewrite and no wrapper.
  It changes about 205 places that read the context, 41 places in code
  generation, and 12 templates, and it changes the `agency.*` helper API.
  It is the fallback if `PromiseContextStorage` fails in a way the tests have
  not found.
- **Wait for native `AsyncContext`.** This is the standard that would replace
  `AsyncLocalStorage` in browsers. No engine ships it. When one does, look at
  this decision again. A native class would need no rewrite.
- **Embed Node in the iPad app.** The newest build of Node for mobile is
  Node 18, from a community fork. It also does nothing for a desktop browser.
- **Compile Agency to Swift.** This needs a second code generator and a
  second runtime.

### What the removal involves

1. Build every context variable from `PromiseContextStorage`. Delete
   `lib/runtime/platform/asyncLocalStorage.ts`,
   `asyncLocalStorage.browser.ts`, and the `AGENCY_PORTABLE_CONTEXT`
   variable.
2. Rewrite generated code as the compiler emits it. Generated files end with
   a block that uses a top-level `await`, and esbuild refuses to rewrite a
   file that has one. That block has to change first.
3. Rewrite the runtime and the stdlib helpers as part of `make`.
4. Rewrite `.ts` files that Agency code imports.
5. Turn the load-time check on for every run. `AgencyFunction.create` then
   refuses any Agency function that was not rewritten.
6. Delete what existed only to test a second class:
   `scripts/portable-loader.mjs`, `vitest.portable.config.ts`, and the
   `agency-tests-portable` job in `.github/workflows/test.yml`.

### Open problems

- **`tests/agency/always-scope-over-ipc` fails on `PromiseContextStorage`.**
  A child process raises an interrupt, and the parent should learn the
  child's `@always` scope from it. The parent's handler is called, so no
  handler is skipped. The scope arrives empty. The cause is not known.
- **9 unit test files fail to load on rewritten code.** vitest moves
  `vi.mock` above the helper that the rewrite adds. The files are listed in
  `portable-context-spike.md`.
- **Callbacks that are not promises or timers.** `PromiseContextStorage`
  wraps `.then`, `setTimeout`, `setInterval`, `setImmediate`,
  `queueMicrotask`, and `process.nextTick`. A runtime callback registered as
  an event listener runs with an empty context.
- **Agency's own error locations.** These come from the runtime and not from
  JavaScript stack traces. Whether the rewrite changes them has not been
  checked.
