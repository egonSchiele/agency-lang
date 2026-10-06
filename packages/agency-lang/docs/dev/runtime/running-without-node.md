# Running Agency without Node

This doc records the goals for running Agency outside Node, the rule that follows from them, and the first decision made under that rule: Agency passes the run as an argument and does not use `AsyncLocalStorage`.

Read this before you propose a change that makes Agency behave differently on Node and in a browser.

This doc does not make Agency run in a browser. The runtime still imports `fs`, `path`, and other Node modules. See [What is left](#what-is-left).

## Goals

1. **Agency code runs anywhere JavaScript runs.** The first place is an iPad app, inside a web view. A desktop browser is another. Hosted models stay supported in those places.
2. **There are two targets, Node and the browser.** This cannot be avoided. On Node, Agency reaches the file system, subprocesses, and the rest of what Unix offers. A browser has none of that.
3. **Branching between the two targets is kept to a minimum.** This goal decides most design questions in this area, so the next section explains it.

## Why branching is the cost that matters

A branch is any place where the code does one thing on Node and another in a browser. It can be an `if`, a second implementation of a class, a second build, or a compile flag that changes the generated code.

Each branch is paid for as long as it exists:

- Both sides have to be built.
- Both sides have to be tested, so CI runs the tests twice.
- A change can break one side and pass on the other.
- Every new feature has to be checked against both sides.

Some branching is required by goal 2. A browser build has to refuse Agency code that reads a file. All other branching is a choice, and the default choice is to not add it.

## The rule

Parts of Agency rely on Node today. Sort each one into one of two groups.

**It needs Node.** Reading a file needs a file system. Starting a subprocess needs an operating system. These stay Node-only, and the browser target reports them as unsupported.

**It relies on Node but does not need to.** `AsyncLocalStorage` was the example. For these, remove the reliance on Node for both targets. Do not keep the Node version and add a browser version beside it.

When you are deciding about a Node feature, go through these steps:

1. Ask whether the feature needs Node. If it does not, write one implementation that both targets use.
2. If it does need Node, put the difference in one of the places listed under [Where the targets may differ](#where-the-targets-may-differ). Do not add a new place.
3. Do not keep a Node-only implementation because it is faster, safer, or more familiar, unless you have measured what would be lost without it. A second implementation is a cost by default.
4. Measure what depends on the feature. Agency has one user, the owner of this repo, and most Agency code lives in this repo. So you can count exactly what depends on a feature. A change that breaks a pattern nothing uses is acceptable.

## Where the targets may differ

The plan is for the targets to differ in four places and nowhere else. The first two are built. `docs/superpowers/specs/2026-10-05-host-and-platforms.md` designs the other two.

| What differs | Where it lives |
| --- | --- |
| Hashing, where Node's OpenSSL is about nine times faster than JavaScript | One pair of files, `lib/utils/sha256.node.ts` and `sha256.portable.ts`, chosen by the `#sha256` entry in the `imports` field of `package.json` |
| Platform calls, such as reading a file or an environment variable | The host, `lib/host/`. One pair of files, `default.node.ts` and `default.browser.ts`, chosen by the `#default-host` entry, each of which builds the host of its platform. See [host.md](host.md) |
| Which runtime modules are included | One entry point for the browser beside `lib/runtime/index.ts` |
| Which stdlib modules exist | The `@capabilities` tag on each effect, which makes a browser build of a program that raises a file effect a compile error |

Generated code has one shape for both targets. The runtime is built once.

### How a pair of files is chosen

The `imports` field of `package.json` maps a name that starts with `#` to a file per condition:

```json
"imports": {
  "#sha256": {
    "types": "./dist/lib/utils/sha256.node.d.ts",
    "browser": "./dist/lib/utils/sha256.portable.js",
    "default": "./dist/lib/utils/sha256.node.js"
  }
}
```

Node resolves `#sha256` to the `default` file. esbuild resolves it to the `browser` file when it bundles with `--platform=browser`. The code that imports the name, `lib/utils/hash.ts`, is the same on both platforms.

Two other places have to know about each entry. `lib/utils/packageImports.d.ts` declares the name's type with an ambient `declare module`, so a fresh checkout type-checks before `dist` exists. `vitest.aliases.ts` maps it for the test runner, which does not read `package.json`. When you add an entry, add it to both. Do not add it to `paths` in `tsconfig.json`: the build runs `tsc-alias`, which rewrites every `paths` entry into a relative import and would undo the choice.

Hashing is the only case so far where Node keeps a faster implementation. Rule 3 above asks for a measurement first: the portable SHA-256 takes 0.8 ms on a 240 KB file and 25 ms on 8 MB, against 0.086 ms and 2.6 ms for Node's.

Other languages with several targets work the same way. TypeScript's compiler never calls `fs`. It calls a `System` object, and Node and the browser playground each supply one. Kotlin has `expect` and `actual`. Go picks whole files by name, such as `file_js.go`. Dart has conditional imports.

## Decision: the run is passed as an argument

### Background

The runtime needs to know which run a piece of code belongs to: its context, its branch's state stack, its message threads, its globals. Until this decision it found that through six `AsyncLocalStorage` instances. `AsyncLocalStorage` keeps a value attached to a chain of `async` calls even while other chains run in between. Browsers do not have it.

### The two options

**Option A: keep a hidden variable, and make it work without Node.** PR [#1167](https://github.com/egonSchiele/agency-lang/pull/1167) built this. A build step rewrites every `async` function into promise code, and `Promise.prototype.then` is replaced with a wrapper that carries the context across.

**Option B: pass the run to every function that needs it.** This is the option chosen. [async-context.md](./async-context.md) describes how it works.

| | Option A: hidden variable | Option B: explicit argument |
| --- | --- | --- |
| A build step rewrites `async` functions | yes | no |
| `Promise.prototype.then` | replaced with a wrapper | untouched |
| JavaScript stack traces on Node | lose function names and callers across an `await` | unchanged |
| A file Agency builds may use top-level `await` | no | yes |
| A helper behaves the same under every command | no. It depends on whether a build step rewrote the file | yes |
| A runtime function that was not given its context | found when it runs | a type error |
| A helper that reads the context after an `await` | works | throws, with an error that names the fix |
| A new event listener or a new place that emits code | needs a decision that nothing prompts | the type checker asks for the run |
| Size of the change | smaller | about 24,800 changed lines over three phases, about 10,400 of them generated |

### Why Option B

Option A costs less to build and more to keep. Code behaves differently depending on whether a build step rewrote it, so a helper can work under `agency run` and fail under `agency serve`. A lost context is found when the code runs, and some reads treat a lost context as a normal answer.

Option B moves most of those failures to compile time. What it cannot catch at compile time it reports where the mistake is made, with `RunInUseError` or the `currentRun()` error.

### What Option B costs

**Helpers written in TypeScript have one new rule.** A helper takes the run on its first line and keeps it:

```ts
export async function chargeLater(amount: number) {
  const run = agency.current();
  await wait(50);
  run.addCost(amount);
}
```

`agency.addCost(amount)` after the `await` throws. Before this decision it worked.

**Some reads cannot tell a lost run from no run.** `agency.ctxMaybe()` and a few stdlib helpers return a default when no run is current. After a helper's first `await` they return that same default. [async-context.md](./async-context.md) lists them under "The lenient read". Each one has a harmless answer for a missing run, and the lint check reports any in `lib/` that could run after an `await`.

**Two REPLs in one process share captured console output.** A `console.log` call carries no run, so the capture cannot tell which REPL's code made it. Output goes to the REPL that installed its capture most recently. With one REPL in the process nothing changes.

**The check against `AsyncLocalStorage` is gone.** While the change was being made, every function that took a run compared it with the frame `AsyncLocalStorage` held. All three test suites passed with that comparison on before it was removed. What protects the code now is the type checker, the shadowed `__run` name in generated code, the wrong-run check, and the lint check. A new place that makes a run gets no automatic comparison.

### How it was checked

The change was made in three phases, each with the full test suites passing.

1. The four small context variables became required fields of the frame.
2. The run was threaded through every function, with `AsyncLocalStorage` still in place and every hand-over compared against it. That comparison found three real mistakes, which were fixed.
3. `AsyncLocalStorage` and the comparison were deleted.

`grep -r "async_hooks" lib` finds nothing.

The built context module was bundled for the browser with esbuild:

```bash
npx esbuild dist/lib/runtime/asyncContext.js --bundle --platform=browser \
  --format=esm --external:smoltalk --outfile=bundle.js
```

It bundles, and no Agency file in the bundle imports a Node module. Before this decision the same command failed on `node:async_hooks`.

The `--external:smoltalk` flag matters. The context module imports the thread store, which imports smoltalk, and smoltalk imports `fs`, `path`, and `url`. Without the flag the bundle fails on those. That is the next reliance on Node to sort.

## What is left

- The runtime imports Node modules in many other files. Each needs the sorting described under [The rule](#the-rule).
- smoltalk, the library every model call goes through, imports `fs`, `path`, and `url`. The thread store imports smoltalk, so almost every runtime module reaches them.
- The host exists and the generated header reaches Node only through it, but most of the runtime and the stdlib still read `process`, `fs`, and `path` directly. `eslint.node-exceptions.mjs` lists those files; the list shrinks as each one moves to the host.
- The last two places under [Where the targets may differ](#where-the-targets-may-differ) are not built.
- The callbacks given to `agency.withHandler`, `withCostGuard`, `withTimeGuard`, `withLock`, and `thread.with` are not handed a handle. Such a callback can call `agency.*` on its first line and not after an `await`.
