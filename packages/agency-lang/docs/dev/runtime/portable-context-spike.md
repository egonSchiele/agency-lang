# Portable context: running Agency without `AsyncLocalStorage`

**Decision.** Agency does not use `AsyncLocalStorage` on Node or in a browser.
Every context variable is built from `PromiseContextStorage`, the class this
doc describes. `running-without-node.md` records that decision, the goals
behind it, and the measurements. Read it first.

**Status of the code.** The code does not match the decision yet. On Node the
context variables are still built from `AsyncLocalStorage`, unless
`AGENCY_PORTABLE_CONTEXT=1` is set. The removal is listed under
[Next steps](#next-steps).

This doc explains how `PromiseContextStorage` works and what was tested.

## Why

The goal is an Agency runtime that runs wherever JavaScript runs, with no Node:
a web view, a desktop browser. The first user is an iPad app whose agent is
written in Agency.

`AsyncLocalStorage` was the one Node feature with no replacement. It comes from
`node:async_hooks`, browsers do not have it, and the standard that would
replace it (TC39 `AsyncContext`) is a Stage 2 draft that WebKit has not started
on. Everything else the runtime takes from Node is an ordinary library call
that can be swapped.

This spike shows that the runtime keeps its context correctly on an engine
with neither `AsyncLocalStorage` nor `AsyncContext`.

## The result

A compiled Agency program ran inside a `WKWebView` and gave the same output as
it does on Node. The program covers:

1. A handler that approves an interrupt.
2. An inner handler that approves and an outer handler that rejects. The
   rejection wins.
3. Two runs that pause at an interrupt with no handler, and are resumed at the
   same time. Each keeps its own global variable.

The page reported no Node `process` and no `AsyncContext`.

On Node, with the new store switched on:

| Check | Result |
| --- | --- |
| All of `tests/agency` | 1762 of 1763 tests pass |
| All of `tests/agency-js` | 189 of 189 pass |
| `tests/agency/handlers` with the rewrite switched off | 0 of 65 pass |
| Unit tests in `lib/runtime` and `lib/stdlib` | 267 files pass, 13 do not |

The one `tests/agency` failure is `always-scope-over-ipc`. A child process
raises an interrupt, and the parent should learn the child's `@always` scope
from it. The parent's handler is called, so no handler is skipped. The scope
arrives empty. The cause is not known.

One `agency-js` test, `agent-session-resume`, passes only when its
hand-written helper is rewritten too. `running-without-node.md` explains the
pattern under "TypeScript helpers".

The row with the rewrite switched off is the control. It shows that these
tests do run on the new store, and that a missing rewrite fails with an error
and does not pass by accident. Every failure in that run is
`getRuntimeContext() called outside an Agency execution frame`.

The 13 unit test files are covered under [Unit test failures](#unit-test-failures).
None of them is a defect in the store.

## How it works

The current context is one variable. Here is why a plain variable is not
enough on its own:

```js
let current = null;

async function runTool(name) {
  current = name;
  await callModel();
  console.log(current);
}

runTool("timers");
runTool("lists");
```

This prints `lists` twice. The second call overwrites the variable while the
first call is paused at `await`.

The fix has two parts.

**Part 1: the build rewrites `await` into `.then`.**

```js
function runTool(name) {
  current = name;
  return callModel().then(() => {
    console.log(current);
  });
}
```

`await` is syntax, and a library cannot attach to it. `.then` is a function,
and a library can replace it.

**Part 2: `.then` is replaced with a version that remembers.**

```js
const realThen = Promise.prototype.then;

Promise.prototype.then = function (callback) {
  const saved = current;
  return realThen.call(this, (value) => {
    const before = current;
    current = saved;
    try {
      return callback(value);
    } finally {
      current = before;
    }
  });
};
```

The wrapper saves `current` when `.then` is called. It puts that value back
while the callback runs. Each paused function wakes up with its own context,
and the example prints `timers` then `lists`.

`lib/runtime/platform/promiseContextStorage.ts` is this idea with the details
filled in:

- One frame holds a value for every store. The runtime has six stores, and one
  pause must restore all of them.
- A frame is never changed after it is made. `run` builds a new one. A paused
  function can therefore hold its frame by reference.
- `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`, and
  `process.nextTick` are wrapped the same way as `.then`.
- `Promise.prototype.catch` and `finally` call `.then` themselves, so they
  need no wrapper.

The class has the three methods the runtime uses: `run`, `getStore`, and
`exit`. The runtime calls `run` at 43 places and `getStore` at 54. It never
calls `exit`.

## Which code must be rewritten

| Code | Rewritten? |
| --- | --- |
| JavaScript generated from Agency | Yes |
| The runtime and the stdlib helpers, `lib/runtime` and `lib/stdlib` | Yes |
| Imported TypeScript, smoltalk, provider SDKs, every other dependency | No |

Code that is left alone works as a callee. Its caller is rewritten, so the
caller's own `.then` saves the caller's context:

```js
current = "timers";
startTimerForAgent(args).then(() => {
  console.log(current); // still "timers"
});
```

What `startTimerForAgent` does inside does not affect the caller.

Inside code that is left alone:

- Before its first `await`, it runs in the caller's context. `agency.*` calls
  work.
- After its first `await`, the context is empty. It is not another run's
  context. `agency.ctx()`, `agency.llm()`, and `agency.checkpoint()` throw the
  "outside an Agency frame" error that `docs/site/guide/ts-helpers.md`
  describes.

`promiseContextStorage.test.ts` checks both statements with a real `async`
function.

A TypeScript helper that needs context after a pause can be put through the
same rewrite. A browser build is bundled anyway, so that is one bundler
setting for that file.

## The load-time check

An empty context is not always an error. The main store throws when it is
empty, but the five small stores treat empty as a normal answer:

```ts
const parent = callDepthALS.getStore();
const depth = (parent?.depth ?? 0) + 1;
```

With no context, every call counts as the first call. Generated code that was
not rewritten therefore never trips the call-depth limit, and runaway
recursion runs forever. `lib/runtime/nodeAbortBoundary.test.ts` compiles such
a program and imports the output without the rewrite, and without the check
below it hangs.

`AgencyFunction.create` now refuses a function that is still a real `async`
function when the new store is on:

```
__runtime:checkpoint is a real async function, but this build keeps context
by rewriting async functions into promise code. Build it with that rewrite
switched on.
```

Generated code calls `AgencyFunction.create` for every function as its module
loads. A build that skipped the rewrite therefore fails on load and names the
function.

The check reads the function's tag with `Object.prototype.toString`. It does
not name the `AsyncFunction` constructor, because the rewrite would turn an
`async function` written in the runtime into a plain one.

Handlers are not at risk from an empty context. They live on `ctx.handlers`,
and `ctx` is read through `getRuntimeContext()`, which throws when the context
is empty.

## Unit test failures

`vitest.portable.config.ts` runs the unit tests on the new store. These are
the results for `lib/runtime`, `lib/stdlib`, and `lib/statelogClient.test.ts`:

| Files | What happens | Cause |
| --- | --- | --- |
| 267 | pass | |
| 9 | fail to load with `__async is not a function` | vitest moves `vi.mock` above the helper that the rewrite adds |
| 4 | fail with the "outside an Agency frame" error or the load-time check | the test compiles Agency and imports the output directly, so the output is never rewritten |
| 3 | skipped | they are skipped on the normal store too |

The 9 files are `memory/manager`, `llmClient.textAbort`, `llmClient.audio`,
`llmClient.decide`, and `resumeFromCheckpoint` under `lib/runtime`, and
`speech`, `aws/s3`, `embedding`, and `__tests__/notify` under `lib/stdlib`.

The 4 files are `topsortCycleErrors`, `initPlanWorkedExamples`,
`staticInit.crossModule`, and `nodeAbortBoundary` under `lib/runtime`.

Both groups are problems with how the tests are run. A build that rewrites
generated code as it compiles fixes the second group.

## What is in the change

| File | What it is |
| --- | --- |
| `lib/runtime/platform/asyncLocalStorage.ts` | The one file every store imports. On Node it hands back the real class. `AGENCY_PORTABLE_CONTEXT=1` selects the new store, for tests. |
| `lib/runtime/platform/asyncLocalStorage.browser.ts` | What a browser bundle gets in place of the file above. It uses native `AsyncContext` when the engine has it, and the new store when it does not. |
| `lib/runtime/platform/promiseContextStorage.ts` | The new store, and `assertAsyncRewritten`. |
| `lib/runtime/platform/promiseContextStorage.test.ts` | Tests that pass with and without the rewrite. |
| `lib/runtime/agencyFunction.ts` | The load-time check in `AgencyFunction.create`. |
| `scripts/portable-loader.mjs` | Rewrites `async` functions as each module loads, so existing tests run unchanged. |
| `vitest.portable.config.ts` | The unit tests on the new store. |
| `scripts/portable-spike/` | The web view demo. |

The first two files started in
[#1153](https://github.com/egonSchiele/agency-lang/pull/1153), which this
change replaces. `browser-async-context-seam.md` describes them.

The `"browser"` field in `package.json` maps the first file to the second, so
a bundler that reads the field needs no setting of its own. The demo's
`build.mjs` resolves imports by hand, so it applies the same mapping itself.

## How to run it

All commands run from `packages/agency-lang` after `make`.

Agency tests on the new store:

```bash
AGENCY_PORTABLE_CONTEXT=1 \
NODE_OPTIONS="--import $PWD/scripts/portable-loader.mjs" \
  node ./dist/scripts/agency.js test tests/agency/handlers -p 12
```

`NODE_OPTIONS` is inherited, so subprocesses are rewritten too. Set
`AGENCY_PORTABLE_SCOPE=none` to switch the rewrite off and see the control
fail. Set it to `all` to rewrite `node_modules` as well.

Unit tests on the new store:

```bash
./node_modules/.bin/vitest run -c vitest.portable.config.ts lib/runtime/platform
```

The web view demo, on a Mac with Xcode's Swift:

```bash
cd scripts/portable-spike
node ../../dist/scripts/agency.js compile agent.agency
node build.mjs
swift run-webkit.swift bundle.js
```

`build.mjs` bundles the compiled program for a browser. `run-webkit.swift`
loads the bundle in a `WKWebView` and prints what the page reports. Set
`SPIKE_NO_LOWER=1` when running `build.mjs` to bundle without the rewrite and
see it fail.

## What the demo stands in for

The demo loads because `build.mjs` replaces or removes several things. Each
one is work a real portable build has to do.

1. **The prelude pulls in the compiler.** Every compiled program imports
   `stdlib/index.js`. That file imports `lib/stdlib/agency.ts` for
   `_callback`, which imports the compiler, which imports esbuild. Of 423
   Agency modules in the bundle, 155 are compiler modules. The demo replaces
   esbuild with an object that throws when called.
2. **The package root exports the compiler.** Generated code imports
   `goToNode`, `color`, `nanoid`, and `smoltalk` from `agency-lang`. The demo
   points that import at a four-line file.
3. **Generated files end with a command-line block.** It runs the program
   when Node was started with that file, and it uses a top-level `await`. A
   single-file bundle cannot hold one, and esbuild refuses to rewrite `async`
   functions in a file that has one. The demo cuts the block out.
4. **22 modules read the `process` global without importing it.** Most are in
   `lib/runtime`. The demo defines a global `process` with an empty `env`.
5. **Node modules.** The demo gives `path` and `url` small real versions. It
   replaces the rest with objects that throw when called:

   | Module | Agency files that import it |
   | --- | --- |
   | `path` | 56 |
   | `fs` | 40 |
   | `crypto` | 10 |
   | `url` | 8 |
   | `process` | 8 |
   | `os` | 6 |
   | `child_process` | 5 |
   | `readline` | 3 |
   | `module` | 2 |
   | `fs/promises`, `util` | 1 each |

   Of the 144 runtime modules in the bundle, 14 import `fs`, 14 import `path`,
   and 5 import `crypto`.
6. **Four uses of Node at load time.** These run when the module is imported,
   before any program code:
   - `lib/stdlib/contained.ts` reads `fs.constants.O_NOFOLLOW` and four other
     constants.
   - Four stdlib helpers call `promisify(execFile)` at the top of the file.
   - `lib/statelogClient.ts` calls `fs.mkdirSync` for the log file's folder
     when a generated module creates its runtime context.
   - `lib/runtime/moduleFingerprintRegistry.ts` calls `fs.statSync` for the
     compiled file's time. It already falls back to `"unknown"` when the call
     throws.
7. **The log file.** With `log.logFile` set in `agency.json`, the statelog
   client calls `fs.appendFileSync` on every event. The call throws in the
   demo and the client catches it.

The demo program made no call into `crypto` while running.

The bundle is 6.2 MB. The largest parts are `highlight.js` at 1.6 MB, the
Google, OpenAI, and Anthropic SDKs at 1.7 MB together, and `zod` at 0.6 MB.

## Limits and open questions

- **Scope of the tests.** Nothing has run on an iPad. The `WKWebView` was on
  macOS 27.
- **Model calls from a web view.** The demo makes none.
- **The whole page shares the wrapper.** Replacing `Promise.prototype.then`
  affects every script in the page, including a UI framework. The cost per
  `.then` is one closure. Nobody has measured it or tested it beside React. A
  web worker or a second hidden web view would isolate the agent if this turns
  out to matter.
- **Other ways a callback is scheduled.** The store wraps promises and timers.
  It does not wrap `requestAnimationFrame`, `MessageChannel`, or event
  listeners. A runtime callback registered through one of those runs with an
  empty context.
- **Callbacks given to code that is left alone.** If the runtime hands
  smoltalk a function and smoltalk calls it after a real `await`, the function
  runs with an empty context. Streaming does not do this. The runtime pulls
  each chunk itself, with `for await` loops in `lib/runtime/llmClient.ts` and
  `lib/runtime/streaming.ts`. Those loops are rewritten, so the runtime's own
  `.then` saves the context for every chunk. If a path that hands over a
  function does turn up, wrap that one function so it remembers its context.
  `bindToCurrentFrame` in the store does this and would need exporting.
  [#1152](https://github.com/egonSchiele/agency-lang/pull/1152) lists the
  places to audit under "escaping async boundaries".
- **Provider SDKs in a browser.** Hosted models stay supported, so smoltalk
  and the provider SDKs stay in the bundle. Whether each SDK's streaming works
  in a browser has not been tested. This is a question about the SDKs, not
  about context.
- **Speed.** Rewritten `async` functions are slower than real ones. A run
  spends its time waiting on a model, so this is unlikely to matter. It has
  not been measured.
- **Native `AsyncContext` is untested on a real engine.** The browser file
  uses it when the engine has it, but no engine does. The adapter is tested
  against a stand-in only.

## Alternatives that were set aside

- **Pass the context as a parameter**, as #1152 sizes. It needs no rewrite. It
  changes about 205 read sites, 41 code generation points, and 12 templates,
  and it changes the `agency.*` helper API. It also brings back the registry
  of context-taking functions that commit `d39103cc` removed. It is the
  fallback if the rewrite fails in a way these tests did not find.
- **Wait for native `AsyncContext`**, as #1153's browser file does. No engine
  ships it.
- **Embed Node in the app** with nodejs-mobile. Everything works, but the
  newest release is Node 18 from a community fork.
- **Compile Agency to Swift.** It needs a second code generator and a second
  runtime.
- **Keep `AsyncLocalStorage` on Node and use `PromiseContextStorage` only in
  a browser.** This is what the code does today. It means two context
  classes, two builds of the runtime, and two runs of the test suites in CI.
  `running-without-node.md` compares the two options.

## Next steps

`running-without-node.md` sets the rule these steps follow: the two targets
differ in as few places as possible. Read it before starting any of them.

**First, remove `AsyncLocalStorage`.**

1. **Find why `tests/agency/always-scope-over-ipc` fails on
   `PromiseContextStorage`.** It is the one Agency test that fails with all
   code rewritten.
2. **Remove the top-level `await` from generated files.** Each generated file
   ends with a block that runs the program from the command line. Replace it
   with one runtime call. esbuild refuses to rewrite a file that has a
   top-level `await`, so this comes before step 3.
3. **Rewrite generated code as the compiler emits it.** Put the three
   `transformSync` calls in `lib/compiler/compile.ts`,
   `lib/compiler/buildSession.ts`, and `lib/importStrategy.ts` behind one
   helper. The helper passes `supported: { "async-await": false,
   "async-generator": false, "for-await": false }`. The call in
   `lib/importStrategy.ts` handles the `.ts` files that Agency code imports,
   so those are rewritten too.
4. **Rewrite the runtime and the stdlib helpers as part of `make`.** esbuild
   already rewrites all 164 built runtime files and all 118 built stdlib
   helper files without error. Add a build check that no `async` or `await`
   remains in the output.
5. **Fix the 9 unit test files** that fail to load on rewritten code. See
   [Unit test failures](#unit-test-failures).
6. **Build every context variable from `PromiseContextStorage`.** Delete
   `asyncLocalStorage.ts`, `asyncLocalStorage.browser.ts`, and the
   `AGENCY_PORTABLE_CONTEXT` variable. Turn the load-time check on for every
   run.
7. **Delete what existed only to test a second class:**
   `scripts/portable-loader.mjs`, `vitest.portable.config.ts`, and the
   `agency-tests-portable` job in `.github/workflows/test.yml`.
8. **Make the call-depth read strict.** `withCallDepth` in
   `lib/runtime/callDepth.ts` treats an empty context as the first call, and
   it never requires the main context variable. It should throw when the
   whole frame is empty and a run is expected.

**Then, remove the rest of Node from the runtime.**

9. **Make one real streaming call from the demo,** through smoltalk to a
   hosted model. This shows whether the SDKs work in a web view.
10. **Add the host file pair.** `host.node.ts` and `host.browser.ts` export
    the same functions: read a file, read an environment variable, get the
    working directory, and hash. `package.json` picks one.
    - Move the runtime's `process.env`, `process.cwd()`, and `fs` calls
      behind it, starting with the statelog log file and the module
      fingerprint.
    - Keep Node's `crypto` on Node. `createHash` and `createHmac` back the
      checkpoint integrity check. Only the browser host uses a JavaScript
      implementation. Web Crypto is async, and these call sites are not.
11. **Add a lint rule.** Only `host.node.ts`, the command line, and the
    compiler may import a `node:` module. Without this rule, new runtime code
    breaks the browser build and nothing reports it.
12. **Stop generated files importing Node modules.** Generated files import
    only from the runtime, never `fs`, `path`, `os`, `url`, or `process`.
    They import the four names they need from a small entry point, not the
    package root.
13. **Split the prelude from the compiler.** Move `_callback` out of
    `lib/stdlib/agency.ts`, or move the compile functions out of it, so
    `stdlib/index.js` no longer imports the compiler. This removes 155
    modules and esbuild from every bundle.
14. **Add a browser entry point for the runtime.** A second index beside
    `lib/runtime/index.ts` that leaves out subprocess IPC, the command-line
    entry, trace file sinks, terminal prompts, and local model serving. These
    features are left out. The code does not branch on them.
15. **Mark the stdlib modules that need Node.** A browser build that imports
    one gets a compile error.
16. **Bundle a real agent.** Compile a real multi-file agent, bundle it with
    no stand-ins, and run one chat turn in a `WKWebView` with one interrupt
    that pauses and resumes.
17. **Decide where the agent runs in a page.** Replacing
    `Promise.prototype.then` affects every script in the page. A web worker
    has its own `Promise`, so running the agent there touches nothing else,
    and it still has `fetch` and timers. Interrupts and checkpoints are plain
    data and can cross to the page by `postMessage`. Wrap any remaining
    schedulers the chosen place uses.
