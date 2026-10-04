# How the runtime keeps its context: `PromiseContextStorage`

The runtime keeps six context variables. Each holds one piece of information
about the current run, such as the run context or the call depth. Every one
is built from the same class, `PromiseContextStorage`, in
`lib/runtime/promiseContextStorage.ts`. This doc explains how that class
works and what it requires of the build.

Agency does not use Node's `AsyncLocalStorage`. `running-without-node.md`
records that decision, the goals behind it, and the measurements. Read it
first.

## The problem the class solves

Here is why one plain variable is not enough:

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

## How it works

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

`PromiseContextStorage` is this idea with the details filled in:

- One frame holds a value for every context variable. One pause must restore
  all six.
- A frame is never changed after it is made. `run` builds a new one. A paused
  function can therefore hold its frame by reference.
- `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`, and
  `process.nextTick` are wrapped the same way as `.then`.
- `Promise.prototype.catch` and `finally` call `.then` themselves, so they
  need no wrapper.

The class has three methods: `run`, `getStore`, and `exit`.

## Where the rewrite is applied

"Rewritten" means that a build step turned each `await` in a file into a
`.then` call. esbuild does it, with these options:

```js
supported: { "async-await": false, "async-generator": false, "for-await": false }
```

| Code | Rewritten by |
| --- | --- |
| JavaScript generated from Agency | The compiler, in `lib/compiler/transpile.ts` |
| A `.ts` file that Agency code imports, under `agency run` | The compiler, through the same function |
| The runtime, the stdlib helpers, and the rest of `dist` | `scripts/rewrite-async.mjs`, the last step of `make build` |
| Code under unit test | vitest, through the `esbuild` setting in `vitest.config.ts` |
| Dependencies, such as smoltalk and the provider SDKs | Not rewritten |
| A hand-written `.js` file that Agency code imports | Not rewritten |
| TypeScript built by a user's own build, as with `agency compile` | Not rewritten |

`lib/compiler/transpile.ts` is the one function the compiler uses to turn
TypeScript into JavaScript. Use it for any new place that emits code.

## No top-level `await`

esbuild refuses to rewrite a file that has a top-level `await`. So no file
Agency builds may have one.

- **Generated files.** A generated file ends with a block that runs the
  program when Node was started with that file. The block makes one call,
  `runCliMain`, and does not await it. `runCliMain` is in
  `lib/runtime/cliEntry.ts`. It reports a crash and rethrows. Nothing awaits
  its promise, so Node ends the process with a non-zero exit code.
- **`scripts/agency.ts`.** It calls `runCli()` without awaiting it, for the
  same reason.
- **Test files.** A test file cannot use `const { x } = await import(...)` at
  the top level. Use a plain `import`. vitest moves `vi.mock` above imports,
  so the mocks still apply.
- **A user's `.ts` helper** with a top-level `await` fails to build under
  `agency run`.

`scripts/rewrite-async.mjs` fails the build and names the file if a file in
`dist` has a top-level `await`.

## Code that is not rewritten

Code that is not rewritten works as a callee. Its caller is rewritten, so the
caller's own `.then` saves the caller's context:

```js
current = "timers";
startTimerForAgent(args).then(() => {
  console.log(current); // still "timers"
});
```

What `startTimerForAgent` does inside does not affect the caller.

Inside code that is not rewritten:

- Before its first `await`, it runs in the caller's context. `agency.*` calls
  work.
- After its first `await`, the context is empty. It is not another run's
  context. `agency.ctx()`, `agency.llm()`, and `agency.checkpoint()` throw the
  "outside an Agency frame" error that `docs/site/guide/ts-helpers.md`
  describes.

`promiseContextStorage.test.ts` checks both statements with a real `async`
function.

Streaming from a model is safe. The runtime pulls each chunk itself, with
`for await` loops in `lib/runtime/llmClient.ts` and `lib/runtime/streaming.ts`.
Those loops are rewritten, so the runtime's own `.then` saves the context for
every chunk. smoltalk never calls back into the runtime.

`docs/site/guide/ts-helpers.md` tells a helper's author what to do when a
helper is not rewritten.

A helper that uses `agency.*` after an `await` works under some commands and
fails under others, depending on who built its file.
`docs/superpowers/specs/2026-10-03-ts-helpers-after-await.md` has the full
table and proposes a fix, `agency.current()`. The fix is not built.

## The load-time check

An empty context is not always an error. The main context variable throws
when it is empty, but the five small ones treat empty as a normal answer:

```ts
const parent = callDepthContext.getStore();
const depth = (parent?.depth ?? 0) + 1;
```

With no context, every call counts as the first call. Generated code that was
not rewritten would therefore never trip the call-depth limit, and runaway
recursion would run forever.

`AgencyFunction.create` refuses a function that is still a real `async`
function:

```
__runtime:checkpoint is a real async function. Agency keeps its context by
rewriting async functions into promise code, and this one was not rewritten.
Compile it with the Agency compiler.
```

Generated code calls `AgencyFunction.create` for every function as its module
loads. Code that skipped the rewrite therefore fails on load and names the
function.

The check reads the function's tag with `Object.prototype.toString`. It does
not name the `AsyncFunction` constructor, because the rewrite would turn an
`async function` written in the runtime into a plain one.

Handlers are not at risk from an empty context. They live on `ctx.handlers`,
and `ctx` is read through `getRuntimeContext()`, which throws when the context
is empty.

## Callbacks that are not promises or timers

A callback that something else calls later runs with an empty context, unless
that something is a promise or one of the wrapped timers. An event listener is
the common case.

```ts
s.child.on(
  "message",
  bindToCurrentFrame((msg: any) => {
    void handleChildMessage(s, msg);
  }),
);
```

This is the listener for messages from a child process, in
`lib/runtime/ipc.ts`. A message can carry an interrupt, and the parent's
handlers answer it, so the listener has to run in the context of the run that
started the child. `bindToCurrentFrame` wraps a function so it runs in the
frame that was current when it was wrapped.

A listener that only resolves or rejects a promise needs no wrapper. The code
waiting on that promise gets its context back through `.then`.

When you register a listener that runs runtime code directly, wrap it.
`tests/agency/always-scope-over-ipc` fails without the wrapper above.

## Unit tests

vitest rewrites the code under test, through the `esbuild` setting in
`vitest.config.ts`.

esbuild declares the helper that rewritten functions call with
`var __async = ...`. A `vi.mock` factory runs while the test file's imports
load, before that assignment has run, so an `async` factory would fail with
"__async is not a function". A small plugin in `vitest.config.ts` turns the
helper into a function declaration, which exists from the start of the file.

## Test results

These are from 2026-10-03, on Node, with every context variable built from
`PromiseContextStorage`.

| Check | Result |
| --- | --- |
| Unit tests | 962 files pass, 4 skipped |
| `tests/agency` | 1763 of 1763 tests pass |
| `tests/agency-js` | 189 of 189 pass |
| The web view demo | same output as on Node |

## The web view demo

`scripts/portable-spike/` holds a compiled Agency program that runs inside a
`WKWebView`. The program covers:

1. A handler that approves an interrupt.
2. An inner handler that approves and an outer handler that rejects. The
   rejection wins.
3. Two runs that pause at an interrupt with no handler, and are resumed at the
   same time. Each keeps its own global variable.

The page reports no Node `process` and no `AsyncContext`.

To run it, on a Mac with Xcode's Swift, from `packages/agency-lang` after
`make`:

```bash
cd scripts/portable-spike
node ../../dist/scripts/agency.js compile agent.agency
node build.mjs
swift run-webkit.swift bundle.js
```

`build.mjs` bundles the compiled program for a browser. `run-webkit.swift`
loads the bundle in a `WKWebView` and prints what the page reports.

### What the demo stands in for

The demo loads because `build.mjs` replaces several things. Each one is work
a real browser build has to do.

1. **The prelude pulls in the compiler.** Every compiled program imports
   `stdlib/index.js`. That file imports `lib/stdlib/agency.ts` for
   `_callback`, which imports the compiler, which imports esbuild. Of 423
   Agency modules in the bundle, 155 are compiler modules. The demo replaces
   esbuild with an object that throws when called.
2. **The package root exports the compiler.** Generated code imports
   `goToNode`, `color`, `nanoid`, and `smoltalk` from `agency-lang`. The demo
   points that import at a four-line file.
3. **22 modules read the `process` global without importing it.** Most are in
   `lib/runtime`. The demo defines a global `process` with an empty `env`.
4. **Node modules.** The demo gives `path` and `url` small real versions. It
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
5. **Four uses of Node at load time.** These run when the module is imported,
   before any program code:
   - `lib/stdlib/contained.ts` reads `fs.constants.O_NOFOLLOW` and four other
     constants.
   - Four stdlib helpers call `promisify(execFile)` at the top of the file.
   - `lib/statelogClient.ts` calls `fs.mkdirSync` for the log file's folder
     when a generated module creates its runtime context.
   - `lib/runtime/moduleFingerprintRegistry.ts` calls `fs.statSync` for the
     compiled file's time. It already falls back to `"unknown"` when the call
     throws.
6. **The log file.** With `log.logFile` set in `agency.json`, the statelog
   client calls `fs.appendFileSync` on every event. The call throws in the
   demo and the client catches it.

The demo program made no call into `crypto` while running.

The bundle is 6.2 MB. The largest parts are `highlight.js` at 1.6 MB, the
Google, OpenAI, and Anthropic SDKs at 1.7 MB together, and `zod` at 0.6 MB.

## Limits and open questions

- **Scope of the tests.** Nothing has run on an iPad. The `WKWebView` was on
  macOS 27.
- **Model calls from a web view.** The demo makes none. Whether each provider
  SDK's streaming works in a browser has not been tested.
- **The whole page shares the wrapper.** Replacing `Promise.prototype.then`
  affects every script in the page, including a UI framework. Nobody has
  tested it beside React. A web worker has its own `Promise`, so running the
  agent in one would touch nothing else.
- **Another library that replaces `Promise.prototype.then`.** Some monitoring
  tools do this. None has been tested with Agency.
- **Schedulers that are not wrapped.** The class does not wrap
  `requestAnimationFrame` or `MessageChannel`.
- **Listeners that were not audited one by one.** The runtime and the stdlib
  helpers register about 70 event listeners. Most only settle a promise. The
  full test suites pass, and one listener needed a wrapper. A listener on a
  path the tests do not cover could still need one.
  [#1152](https://github.com/egonSchiele/agency-lang/pull/1152) lists places
  to audit under "escaping async boundaries".
- **`agency compile --ts`.** This writes TypeScript and leaves the build to
  the user. That build does not rewrite `async` functions, so the load-time
  check refuses the output.
- **The call-depth read.** `withCallDepth` in `lib/runtime/callDepth.ts`
  treats an empty context as the first call, and it never requires the main
  context variable. It should throw when the whole frame is empty and a run
  is expected.
- **Agency's own error locations.** These come from the runtime and not from
  JavaScript stack traces. Whether the rewrite changes them has not been
  checked.

## Next steps

`running-without-node.md` sets the rule these steps follow: the two targets
differ in as few places as possible. Read it before starting any of them.

1. **Make one real streaming call from the demo,** through smoltalk to a
   hosted model. This shows whether the SDKs work in a web view.
2. **Add the host file pair.** `host.node.ts` and `host.browser.ts` export
   the same functions: read a file, read an environment variable, get the
   working directory, and hash. `package.json` picks one.
   - Move the runtime's `process.env`, `process.cwd()`, and `fs` calls
     behind it, starting with the statelog log file and the module
     fingerprint.
   - Keep Node's `crypto` on Node. `createHash` and `createHmac` back the
     checkpoint integrity check. Only the browser host uses a JavaScript
     implementation. Web Crypto is async, and these call sites are not.
3. **Add a lint rule.** Only `host.node.ts`, the command line, and the
   compiler may import a `node:` module. Without this rule, new runtime code
   breaks the browser build and nothing reports it.
4. **Stop generated files importing Node modules.** Generated files import
   only from the runtime, never `fs`, `path`, `os`, `url`, or `process`.
   They import the four names they need from a small entry point, not the
   package root.
5. **Split the prelude from the compiler.** Move `_callback` out of
   `lib/stdlib/agency.ts`, or move the compile functions out of it, so
   `stdlib/index.js` no longer imports the compiler. This removes 155
   modules and esbuild from every bundle.
6. **Add a browser entry point for the runtime.** A second index beside
   `lib/runtime/index.ts` that leaves out subprocess IPC, the command-line
   entry, trace file sinks, terminal prompts, and local model serving. These
   features are left out. The code does not branch on them.
7. **Mark the stdlib modules that need Node.** A browser build that imports
   one gets a compile error.
8. **Bundle a real agent.** Compile a real multi-file agent, bundle it with
   no stand-ins, and run one chat turn in a `WKWebView` with one interrupt
   that pauses and resumes.
9. **Decide where the agent runs in a page.** See "The whole page shares the
   wrapper" above. Interrupts and checkpoints are plain data and can cross
   from a web worker to the page by `postMessage`.
