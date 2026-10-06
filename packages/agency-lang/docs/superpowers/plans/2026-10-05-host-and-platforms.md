# The host and capabilities: implementation plan

**Spec:** `docs/superpowers/specs/2026-10-05-host-and-platforms.md`.
Read it first. Then read:

- `docs/dev/runtime/running-without-node.md`, for the rule about
  branching between platforms
- `docs/dev/runtime/async-context.md`, for how a helper gets its run
- `docs/dev/stdlib/contained-files.md`, before any file task
- `docs/dev/compiler/effect-propagation.md`, before the capability tasks
- the "MUST READ" section on interrupts in `CLAUDE.md`, before the
  capability tasks
- `docs/dev/contributing/coding-standards.md` and
  `docs/dev/contributing/anti-patterns.md`

**Branches:** every PR is based on `main`. Start a PR after the one
before it has merged. All paths are relative to `packages/agency-lang`.

## Status

Stages 1, 16, and 11 are merged, as three PRs: #1175, #1176, and #1177.
PR B and PR C are merged. PR C2 is open.

| PR | What it ships | Stages | State |
|---|---|---|---|
| #1175, #1176, #1177 | Programs stop importing the compiler; `std::capabilities` becomes `std::effectSets`; hashing through `#sha256` | 1, 16, 11 | merged |
| B | `lib/host/`, `ctx.host`, a host per run, the lint rule, the `process` and `os` moves, policy directories resolved once | 2, 3, 4, 6a | merged, #1179 |
| C | `contained.ts` becomes the file part of `nodeHost`, `updateText` and `withLock` and `locate` on the host, `memoryHost` and the shared file battery, the effect sets data file, the trace sinks | 5, 6b, 6c, 7 | merged, #1180 |
| C2 | The 33 importers of `contained.ts` move to `run.ctx.host.files` and go async; `Root` readers move from `rootPath` to `resolvePath`; the runtime's own file use (memory, attachments, builtins, `node.ts`) | 6 (Tasks 16, 17, 18), 20 | open |
| D | Subprocesses, network, portable paths, `Buffer` | 8, 9, 10, 12 | |
| E | The checkpoint checksum, module fingerprints, the browser entry point and CI checks, the `@capabilities` tag, `--platform` | 13, 14, 15, 17, 18 | |

The headings below keep their stage numbers, so a task can still be
named by them. Keep one commit per stage inside a PR, in the order the
stages are listed, so a reviewer can read a PR commit by commit. If a
stage turns out large enough to need its own review, open it as its own
PR; the owner prefers several small PRs to one large one.

Stage 19, the clock and random values, is dropped. The browser goal does
not need it.

The smoltalk change in section 8 of the spec is in another repo. It
depends on nothing here and can start at any time.

### What the first three PRs learned

Read this before stage 2, because `#default-host` copies what `#sha256`
does.

1. **A per-platform file is chosen by the `imports` field of
   `package.json`.** `#sha256` maps to `./dist/lib/utils/sha256.portable.js`
   under the `browser` condition and to `./dist/lib/utils/sha256.node.js`
   by default. Node and esbuild both read it. Three other places have to
   know about each entry, and `#default-host` needs all three:
   - `lib/utils/packageImports.d.ts` declares the name's type for
     TypeScript with an ambient `declare module`, because on a fresh
     checkout `dist/` does not exist and TypeScript cannot resolve the
     field. `hash.test.ts` checks both implementation files against the
     declaration with `typeof import("#sha256")`.
   - `vitest.aliases.ts` maps the name to the source file Node would
     pick. All three vitest configs import it. The perf suite failed on
     CI when only one config had the alias.
   - `tsconfig.json` has `rootDir: "./"`, which TypeScript needs to
     resolve the field at all.
2. **Do not put a `#` name in `paths` in `tsconfig.json`.** The build runs
   `tsc-alias`, which rewrites every `paths` entry into a relative import
   in the built output. That silently undid the per-platform choice, and
   only the bundling test caught it.
3. **Do not use a `types` condition in the `imports` field.** esbuild
   resolved `#sha256` wrongly with one present.
4. **esbuild's `metafile` option hangs inside vitest** with the version in
   the repo. `lib/utils/hash.browser.test.ts` reads the bundle text
   instead. Copy that test for the browser bundle check in stage 15.
5. **`make` prints two diagnostics that look like errors and are not
   from this work:** AG6019 in `lib/agents/policy/agent.agency` and AG3013
   twice in `coordinator/subagents/review.agency`. The build still exits
   0.
6. **The baseline.** Bundling a compiled `print("hello")` for the browser
   with `esbuild --platform=browser --external:smoltalk --log-limit=0`
   fails on 35 imports of `path`, 25 of `fs`, 10 of `process`, 8 of
   `crypto`, 7 of `url`, 4 each of `child_process` and `os`, 3 of
   `readline`, and 2 of `module`, across 48 runtime and stdlib files. It
   also reaches `lib/backends/typescriptBuilder.js` through
   `lib/runtime/template/*` and `lib/runtime/toolBlockDiagnostics.ts`.
7. **The agent's per-model profiles still use the word "capabilities"**
   (`lib/agents/agency-agent/lib/capabilities.agency`, persisted under a
   `"capabilities"` key in `settings.json`). The owner has not asked for
   them to be renamed.

### What PR B learned

1. **`terminal.print` takes the values, and `settings.log` takes the
   level.** `print(obj)` prints what `console.log` prints, and the logger
   sends `info` to standard output and `warn` to standard error; a
   string-only `writeOut` or a level-less `log` would have changed both on
   Node. The spec's types are updated.
2. **`Host` has a `name`, and `HostSystem` has `isMainModule`.** The error
   message names the host, and the header's `process.argv[1] ===
   fileURLToPath(import.meta.url)` check needed a home.
3. **A helper with no run calls `currentHost()`** from
   `lib/runtime/currentHost.ts` on its first line. With no run current it
   is the default host, so a unit test that calls the helper directly sees
   `process.env` as before.
4. **The lint rule's reach check runs the esbuild command**, because the
   JavaScript API cannot parse its own metafile with the version in the
   repo. Listed files are passed as `--external:<absolute path>`, which
   esbuild accepts, so the walk stops at them.
5. **The exceptions file is `.mjs`**, because the root `.gitignore`
   ignores `**/*.js`.
6. **The old stdlib `fs` block stays beside the new one.** ESLint keeps
   only the later block for a file both match, so a waiting stdlib file
   would lose the `fs` ban if the old block were folded away.
7. **Agency code uses `path` and `os` as free names** (`path.join(dir,
   name)`, `os.homedir()`), which the old header supplied by importing
   Node's modules; CI failed with "path is not defined" the first time the
   header lost them. They now come from `agency-lang/runtime`, which
   re-exports Node's modules from `lib/runtime/agencyGlobals.node.ts`.
   Stage 15's `browser.ts` must export a portable `path` (Task 27) and a
   host-backed `os` under the same names, and the reach lint lets
   `lib/runtime/index.ts` alone import a Node-only file for this.
8. **Files still waiting after PR B** use `fs`, `path`, `Buffer`,
   `child_process`, or `crypto`, which later PRs cover; `process.cwd` and
   `process.platform` reads in file-handling code move with `contained.ts`
   in PR C. `exitProcess.ts` and `subprocessRunInfo.ts` wait for PR D.
   `termcolors.ts`, `args.ts`, and `layout/render.ts` read the terminal's
   size and colour support and need a decision in PR E.

### What PR C learned

1. **Task 16's count.** With the re-export in `lib/stdlib/contained.ts`
   emptied, `tsc` names 33 files. They hold about 200 calls of the
   contained functions. Nine of the files are Node-only (`localModels.ts`
   33 calls, `agency.ts` 12, `hubDownload.ts` 10, `cli.ts` 6,
   `mlxModelRecord.ts` 6, `modelVerify.ts` 5, `localModelManifest.ts` 5,
   `modelBackend.ts` 4, `localImageInputs.ts` 2) and keep calling
   `lib/host/nodeFiles.ts` synchronously, with the comment Task 17 asks
   for. The other 24 hold about 120 calls. The files with the most calls
   inside synchronous functions are `agentSessions.ts` (10 calls, 11 sync
   functions), `builtins.ts` (8, 19), `template.ts` (2, 8),
   `approvedPath.ts` (4, 3), and `assertContained.ts` (3, 1); `fs.ts`
   (19), `speech.ts` (15), and `shell.ts` (13) are already mostly async.
   That is PR C2 on its own.
2. **`Root` stays `{ real: string }`, fenced by a lint rule.** A branded
   type would have meant rewriting the 39 `.real` reads in the two test
   files. Instead `lib/host/roots.ts` owns the type and `rootPath`, and
   `no-restricted-syntax` in `eslint.config.js` refuses `.real` in the
   runtime and the stdlib. The 21 readers outside `lib/host` call
   `rootPath` for now; Task 17 step 6 moves them to `host.files.resolvePath`.
3. **A refusal from `makeHost` throws when called**, before any promise
   exists, for the file functions too. Every caller awaits inside an async
   function, where that becomes a rejection. A test of a refused async
   function uses `expect(() => ...).toThrow`.
4. **`locate` is `locateSync` in `nodeFiles.ts`**, and
   `prepareContainedPath` calls it. The async wrapper's `await` was always
   a microtask; the comment there was about real I/O waits.
5. **`stat` returns a plain `FileStat`** (`kind`, `size`, `modifiedMs`),
   because Node's `Stats` is not a type a browser host can make. The
   synchronous module still returns `Stats`; the part converts.
6. **The effect sets data file is generated after the build**, because the
   generator needs the parser in `dist/`. `make effect-sets` builds again
   when the file changed, and a test fails when it is stale. The parse
   moved to `effectSetsParse.ts` so `effectSets.ts` no longer pulls the
   parser into every program.
7. **`traceWriter.ts` still imports `fileSink.ts`.** `TraceWriter.create`
   builds the `FileSink`; Task 20 moves that behind `host.files`, and until
   then `traceWriter.ts` stays on the waiting list for that import and for
   `path`.

### What PR C2 learned

1. **The host needed two more helpers.** `fixedRoot` (the approved
   spelling of a directory, after the interrupt) and `realDir` (the real
   spelling of a directory, for a payload or a comparison) had no twin
   on the host; `builtins.ts`, `template.ts`, `fs.ts`, `shell.ts`, and
   `assertContained.ts` all needed them. `openForAppend` came later, for
   the trace writer, which adds a line at a time to a file it keeps open.
2. **How a helper gets the host.** A helper handed the run reads
   `run.ctx.host`; a helper Agency calls as a plain function reads
   `currentHost()` on its first line; a helper below those takes the
   host as an argument. `assertContained`, `resolveDir`, `gitRunImpl`,
   `outputPath`, `transcode`, `approvedFilePath`, and the OAuth token
   helpers all take it. `assertPathsContained` is called from Agency
   code directly, so it reads `currentHost()` instead.
   `scripts/lint-run-reads.mjs` already follows `currentHost()`, because
   it calls `currentRunOrNone()` on entry.
3. **`path.join(rootPath(root), rel)` became `resolvePath(root, rel)`**,
   which also walks the path for links. In a walk that touches every
   entry (`grep`, `glob`) that would double the lstat work, so
   `walkDir` asks once for the root's path and joins the entries itself.
4. **`updateText` reads first and treats only ENOENT as missing.** With
   a `stat` first, a link at the final name read as a missing file and
   `applyPatch` wrote through it; `readText` refuses the link the way
   every read does. `edit` on a file that does not exist now says "no
   such file" in its own words rather than with Node's ENOENT message.
5. **Two readability checks went two ways.** The one before a paid
   transcribe reads the first piece of the file through `readChunks`,
   because a test pins that an unreadable file fails before dispatch.
   The one before a file is handed to another program is a `stat`, which
   still refuses a link at the final name and anything that is not a
   regular file.
6. **Three callers cannot move yet.** `memory/frame.ts` makes and
   realpaths the memory directory inside `createExecutionContext`, which
   has no `await`. `replyAttachments.ts` reads an attachment's file in
   two synchronous callbacks of the prompt runner, where tool-loop
   decisions are made inside a step. `policyDirs.ts` resolves while the
   context is built. Each calls `lib/host/nodeFiles.ts` directly with a
   comment at the import. The spec's table has the rows.
7. **`FileMemoryStore` is cached per directory across runs**, as before,
   so a second run that enables memory on the same directory with a
   different host gets the first run's store. On Node every host's
   files behave the same.
8. **`_loadModelData` and `_registerProviderModule` take a `Locate`**,
   `(files, p) => Promise<Located>`: `fixed` after an interrupt, `whole`
   from the CLI, both exported from `llm.ts`.
9. **Node-only files still use the synchronous module.** The nine
   Node-only stdlib files, the compiler's `closureValidator.ts`, and
   `lib/cli/hostedModels.ts`'s callee keep calling `nodeFiles.ts`, each
   with a comment. `localImageInputs.ts` reads image bytes through
   `host.files` anyway, because `encodedImageInput` could go async
   cheaply and its callers in `lib/local` already were.
10. **Files that left the waiting list:** `builtins.ts` (stdlib),
    `agentSessions.ts`, `lib/runtime/builtins.ts`, `node.ts`, and
    `trace/fileSink.ts` (which left Node-only). `statelog.ts` stays:
    it pulls in `lib/eval/statelogParser.ts`, which reads with `fs`.

Every PR ends with the steps under "Finishing a PR".

**Every PR leaves behaviour on Node unchanged.** If a task seems to need
a change in what a Node program does, stop and ask.

**Use the platform's implementation wherever it makes sense.** When a
task replaces something Node did, reach for the platform's own API
first (WebCrypto, `btoa`, `fetch`), then for a copy of Node's
implementation (`path-browserify` is Node's `path.js`), and write our
own only when neither exists, which in practice means a synchronous
primitive the platform offers only async. The platform's code has had
more eyes and more years than ours, and it is usually faster: Node's
SHA-256 is about nine times faster than the one in
`sha256.portable.ts`. Code we do write is tested against Node's output
on the same inputs. Section 5 of the spec has the same rule; Tasks 27,
28, and 29 apply it.

**Goal:** this program compiles for the browser, bundles with no Node
import, and runs in a web view.

```
node main() {
  const name = env("USER_NAME") with approve
  print("Hello, ${name}")
}
```

This one fails to compile for the browser, and the error names the call
path:

```
node main() {
  const notes = read("notes.txt") with approve
  print(notes)
}
```

## What the code looks like today

These facts shape the tasks. Check each one still holds before starting.

1. **The generated header is one template.** It is
   `lib/templates/backends/typescriptGenerator/imports.mustache`. Edit
   the `.mustache` file and run `pnpm run templates`. Do not edit
   `imports.ts`. Since #1175 it imports `goToNode`, `color`, `nanoid`,
   and `smoltalk` from `"agency-lang/runtime"`, and
   `lib/backends/typescriptGenerator/header.test.ts` fails if it ever
   imports from `"agency-lang"` again. It still imports `fs`, `path`,
   `os`, `url`, and `process`, which stage 4 removes.
2. **The prelude's backing files no longer reach the compiler or
   `child_process`.** `_callback` is in `lib/stdlib/callback.ts` and
   `_notify` in `lib/stdlib/notify.ts`, since #1175.
3. **Hashing goes through `lib/utils/hash.ts`**, since #1177. See "What
   the first three PRs learned" for the `#sha256` mechanism.
4. **`std::effectSets` is the module of effect sets**, since #1176.
   `lib/runtime/effectSets.ts` still reads `stdlib/effectSets.agency` at
   run time, which stage 6b changes.
5. **`RuntimeContext` already takes a `clock`.** The constructor is in
   `lib/runtime/state/context.ts`. `defaultClock()` in that file reads
   the `AGENCY_FAKE_CLOCK` environment variable.
6. **`lib/stdlib/utils.ts` exports `type Platform`** for the operating
   system, and `detectPlatform()`.
7. **The structural linter is ESLint plus one script.** `lint:structure`
   runs `eslint lib/ && node scripts/lint-run-reads.mjs`. The rules are
   in `eslint.config.js`, which already uses `no-restricted-imports` and
   `no-restricted-syntax` per directory.
8. **`lib/stdlib/contained.ts` is synchronous and has 33 importers.**
   Its tests are `contained.test.ts` and `contained.symlinks.test.ts`.
9. **Effect declarations already carry tags.** The type is in
   `lib/types/effectDeclaration.ts`. `lib/typeChecker/effectPayloadCheck.ts`
   validates `@alwaysUnder`. `lib/runtime/alwaysScope.ts` is how that
   tag's data reaches the runtime, through `__registerAlwaysScope` in the
   header.
10. **`package.json` has an `imports` field with one entry, `#sha256`.**
    `vitest.aliases.ts` holds the aliases every vitest config uses, and
    `lib/utils/packageImports.d.ts` declares the `#` names for TypeScript.
    See "What the first three PRs learned".
11. **A helper that looks up the current run must do it before its first
    `await`.** After an `await`, `currentRun()` throws. `lib/stdlib` has
    73 calls to it. This matters in PR 6, which adds an `await` to many
    helpers. A helper that was handed `run` as a parameter is not
    affected, and can read `run.ctx.host` at any point. See
    `async-context.md`.
12. **`lib/utils/hash.ts` exports `sha256Text`**, which calls Node's
    `createHash`. Three runtime files call `createHash` themselves. Six
    stdlib files import `crypto` too: `oauthEncryption.ts`,
    `aws/sigv4.ts`, `modelVerify.ts`, `oauth.ts`, `spill.ts`, and
    `ffmpeg.ts`.
13. **`Root` is `{ real: string }`.** About twenty places in eleven
    files outside `contained.ts` read `.real`. `shell.ts`, `fs.ts`, and
    `prepareContainedPath.ts` have the most. Rerun the search before
    Task 15.
14. **The generated header builds the context with fixed arguments.**
    `runtimeCtxArgs` in `lib/backends/typescriptBuilder.ts` passes
    `statelogConfig`, `smoltalkDefaults`, and `dirname`. Each run then
    gets its context from `createExecutionContext`, which copies fields
    by hand. `InvocationOptions` in `lib/runtime/invocationOptions.ts`
    carries `config`, `traceId`, and `policy`.
15. **`eslint.config.js` already bans `fs` in `lib/stdlib`**, with its
    own exceptions in `FS_IMPORTERS`. ESLint's flat config does not merge
    two settings of one rule for one file. The later block wins.
16. **`prepareContainedPath.ts` must not await.** Its comment says it
    runs between a wrapper's call and its interrupt, and an `await`
    there would hand the event loop to another branch. It makes three
    file calls.
17. **The Agency test runner starts each test in a subprocess.** It
    passes mocks through the `AGENCY_LLM_MOCKS` environment variable for
    that reason.
18. **The CLI has `compile`, `typecheck`, `run`, `bundle`, and `pack`.**
    There is no `agency build`.

## PR 1: programs stop importing the compiler

### Task 1: export the header's names from the runtime

1. In `lib/runtime/index.ts`, export `goToNode` from
   `../simplemachine/graph.js`, `nanoid` from `nanoid`, and `smoltalk`
   as a namespace from `smoltalk`.
2. Search `stdlib/`, `tests/`, and `packages/` for Agency code that uses
   `color`. If nothing uses it, drop it from the header. If something
   does, export it from the runtime too.
3. In `imports.mustache`, replace the two imports from `"agency-lang"`
   with names in the existing import from `"agency-lang/runtime"`.
4. Run `pnpm run templates`.

### Task 2: move `_callback` to its own file

1. Create `lib/stdlib/callback.ts`. Move `_callbackImpl`, `_callback`,
   and `VALID_CALLBACK_NAME_SET` into it, with their doc comment.
2. The new file may import from `lib/runtime` and `lib/types`. It must
   not import the parser, the type checker, or `lib/compiler`.
3. Point `stdlib/index.agency` at `agency-lang/stdlib-lib/callback.js`.
4. Update the unit test that calls `_callbackImpl` to import from the new
   file.

### Task 3: move `_notify` to its own file

1. Create `lib/stdlib/notify.ts`. Move `_notify`, `NOTIFY_SCRIPT`, and
   the `execFileAsync` constant into it.
2. Remove the `child_process` and `util` imports from `builtins.ts` if
   nothing else there uses them.
3. Point `stdlib/system.agency` at `agency-lang/stdlib-lib/notify.js`.

### Task 4: rebuild and check

1. Run `make`, then `make fixtures`. The fixture diff should change only
   the import lines at the top of each file.
2. Add a unit test that reads `imports.mustache` and fails if it contains
   `from "agency-lang"`.
3. Bundle a compiled hello-world program by hand and record which Node
   modules the bundle still reaches. Put the list in the PR description.
   Later PRs shorten it.

   ```bash
   npx esbuild <compiled hello.js> --bundle --platform=browser --format=esm \
     --external:smoltalk --log-limit=0 --outfile=/tmp/bundle.js
   ```

   This command is expected to fail in PR 1. Its error output is the
   list.

## PR 2: the host

### Task 5: `lib/host/host.ts`

1. Write the `Host` type with the parts this PR implements: `env`,
   `terminal`, `system`, `settings`, `clock`, and `random`. Use `type`, not
   `interface`. The `files`, `subprocess`, and `network` parts are added
   to the type in PRs 5, 8, and 9. Do not declare a part that nothing
   implements.
2. Export the capability list as a constant array, and derive the type
   from it:

   ```ts
   export const CAPABILITIES = [
     "fileRead", "fileWrite", "network", "subprocess", "env", "terminal", "llm",
   ] as const;
   export type Capability = (typeof CAPABILITIES)[number];
   ```

3. Write `NEEDS`, the table from the spec. In this PR it has entries for
   `env` and `terminal`. Each later PR adds the entries for its part.
4. Write `PLATFORM_CAPABILITIES`, with the `node` and `browser` rows.
5. Write `UnsupportedOnHostError`. It takes the function name, the
   capability, and the host's name. Its message matches the spec.
6. Write `makeHost({ name, capabilities, parts, onUse })`. For each entry
   in `NEEDS`:
   - when the capability is granted, take the function from `parts`, and
     throw at once if it is missing
   - when it is not granted, supply a function that throws
     `UnsupportedOnHostError`
   - when `onUse` is given, call it with the function's name and its
     capability before the function runs

   Parts with no entry in `NEEDS` are copied from `parts` unchanged.
7. Write `requireCapabilities(host, needed)`. It throws
   `UnsupportedOnHostError` for the first capability the host lacks.
8. This file imports no Node module and uses no Node global.
9. Tests, driven by the table and not written per function:
   - for every entry in `NEEDS`, a host built without that capability
     throws from that function
   - `NEEDS` has an entry for every function in every capability part.
     A type is gone when a test runs, so walk the parts of a real
     `nodeHost` and compare the function names with the keys of `NEEDS`
   - `makeHost` throws when a granted function is missing from `parts`

### Task 6: `lib/host/nodeHost.ts`

1. Write `nodeHost`, a function that returns a `Host`. It builds the
   `system`, `env`, `terminal`, `settings`, `clock`, and `random` parts
   and passes them to `makeHost`. It contains no refusal code.
2. `system.operatingSystem` wraps today's `detectPlatform`. Rename
   `type Platform` in `lib/stdlib/utils.ts` to `OperatingSystem` and
   update its users. This rename has no other effect.
3. `nodeHost` takes `{ capabilities?, clock? }`. The default for
   `capabilities` is `PLATFORM_CAPABILITIES.node`. The default for
   `clock` is `realClock`.
4. `settings.read` reads `process.env`, and `settings.log` writes to
   standard error. `env.get` and `env.set` read and write `process.env`
   too. The two differ in who may call them, which Task 10 covers.
5. The logger in `lib/logger.ts` writes through `settings.log` of the
   current run's host, and falls back to `console.error` when there is
   no run.

### Task 7: the default host

1. Write `lib/host/default.node.ts`. It exports one function,
   `defaultHost()`, which returns a `nodeHost`. This file is the one
   place that reads the test switches for parts of the host. Move the
   `AGENCY_FAKE_CLOCK` decision here from `defaultClock()` in
   `context.ts`. `AGENCY_FETCH_MOCKS_FILE` moves here in PR 9.
   `AGENCY_LLM_MOCKS` is about the `LLMClient` and does not move.
2. Add `#default-host` to the `imports` field of `package.json`, beside
   `#sha256`. Point only the `default` condition at a file for now. The
   `browser` condition arrives in stage 15.
3. Declare `#default-host` in `lib/utils/packageImports.d.ts`, the way
   `#sha256` is declared. Do not add it to `paths` in `tsconfig.json`;
   see "What the first three PRs learned".
4. Add `#default-host` to `vitest.aliases.ts`, pointing at
   `lib/host/default.node.ts`.
5. Copy `lib/utils/hash.browser.test.ts` into a test that bundles
   `default.node.ts` for Node and checks it took `nodeHost`. The browser
   half of that test arrives in stage 15.

### Task 8: `ctx.host`

1. Add an optional `host` to the `RuntimeContext` constructor. Keep it as
   `this.host`, defaulting to `defaultHost()`. Nine callers pass `clock`
   today. When `clock` is given, the context uses a copy of the host with
   that clock in place of the host's own.
2. Find every place that makes a context from another one. The comment
   near line 483 of `context.ts` describes how `clock` was once dropped
   in such a copy. Carry `host` across in the same places.
3. Keep `ctx.clock` working for now, as a getter that returns
   `this.host.clock`. Stage 19 would remove it; it stays until then.
4. Tests: a context with no `host` gets a `nodeHost`. A context given a
   host keeps it. A child context has its parent's host.

### Task 8b: a host for one run

The header builds the global context with fixed arguments, so an app or
a test cannot pass a host to that constructor. The way in is
`InvocationOptions`.

1. Add an optional `host` to `InvocationOptions`.
2. `createExecutionContext` already takes the resolved options. Put the
   host on the run's context there, and use the global context's host
   when the options carry none.
3. Check every entry that takes `InvocationOptions` passes it through:
   `__invokeFunction`, the three serve invokers, `respondToInterrupts`,
   `resumeFromCheckpoint`, and `rewindFrom` in the header, and the
   runtime functions behind them. A resume must keep using the host the
   caller gave it.
4. Tests: a run given a host through `InvocationOptions` uses it, and a
   second run in the same process with no host uses the default. A
   resumed run keeps the host passed at resume.

## PR 3: the lint rule

### Task 9: ban Node in files the browser can reach

1. Compute which files the browser can reach. Run esbuild with
   `--metafile` from `lib/runtime/index.ts` and from each compiled
   stdlib module, and take the union of the files in the output. Keep
   the script, because a test in step 6 reruns it.
2. In `eslint.config.js`, add a block for those files. The existing
   block that bans `fs` in `lib/stdlib` sets the same rule, and ESLint
   keeps only the later block for a file both match. Fold `FS_IMPORTERS`
   and its reasons into the new exceptions file, and delete the old
   block.
3. In the new block, use `no-restricted-imports` to ban Node's built-in
   modules, with and without the `node:` prefix. Use
   `no-restricted-globals` to ban `process`, `Buffer`, `__dirname`,
   `require`, and `setImmediate`.
4. Add a second block that turns both rules off for an explicit list of
   files. Generate the first version of the list by running the rule and
   collecting every file that fails. Sort it and keep it in its own file,
   `eslint.node-exceptions.js`, so a diff shows it getting shorter.
5. Add a comment at the top of that file. It says the list only ever
   shrinks, and names the spec.
6. Split the list into two named arrays. One holds files that are
   Node-only for good, from the table under "Runtime files that use the
   disk" in the spec. The other holds files waiting for a later PR.
7. Add the Node-only array to `no-restricted-imports` as banned paths
   for every file that is not on it. A file the browser can reach then
   cannot import a Node-only file.
8. Add a test that reruns the script from step 1 and fails if a file in
   its output is not covered by the block from step 2.

## PR 4: `process` and `os` move to the host

This PR may be split by task if it grows past what one review can hold.
Each task removes files from the exceptions list.

### Task 10: environment variables

1. Replace each `process.env` read in `lib/runtime` and `lib/stdlib` with
   `host.settings.read`. These are the runtime's own reads: test
   switches, the log level, and the API key a connector sends. A helper
   that was handed `run` reads `run.ctx.host` where it needs it. A
   helper that calls `currentRun()` must make that call before its first
   `await`, as it must today.
2. The one exception is the helper behind `env` and `setEnv` in
   `std::system`. It uses `host.env.get` and `host.env.set`, because it
   exposes any variable to the program. `lib/stdlib/mcpResolver.ts` also
   writes to `process.env`. Read what it sets and decide whether that is
   the program's write or the runtime's.
3. A function with no run needs a decision. If its caller has a run, pass
   the host down as an argument. Do not add a global.
4. Leave Node-only files alone.

### Task 11: working directory, home directory, arguments, exit

Replace `process.cwd`, `os.homedir`, `os.tmpdir`, `process.argv`,
`process.pid`, `process.exit`, and `process.platform` with the matching
`host.system` function.

### Task 12: terminal output and input

1. `_print` and `_input` in `lib/stdlib/builtins.ts` go through
   `host.terminal`.
2. Other plain writes to `process.stdout` and `process.stderr` by stdlib
   functions go through `writeOut` and `writeErr`. Messages from the
   runtime itself go through the logger, which Task 6 routed through
   `settings.log`.
3. `lib/stdlib/cli.ts`, `lib/stdlib/ui-region.ts`, and the code behind
   `std::ui` stay on the Node-only list. Do not grow `HostTerminal` for
   them.
4. `lib/runtime/interruptPrompts.ts` stays Node-only.

### Task 13: the header loses its Node imports

1. Add a runtime function that takes `import.meta.url` and a host and
   returns the module directory and the working directory. The header
   calls it in place of `fileURLToPath`, `path.dirname`, and
   `__process.cwd()`.
2. Move the two test-mock blocks out of the header. The
   `AGENCY_LLM_MOCKS` block moves into the `RuntimeContext` constructor,
   which reads the variable through `host.settings.read` and sets the
   mock client. The `AGENCY_FETCH_MOCKS_FILE` block moves into
   `lib/host/default.node.ts`, which is a Node file and can read the
   mocks file synchronously, so nothing needs to be awaited. In this PR
   it still installs the mock by patching the global `fetch`, as the
   header does today. Task 26 changes what it replaces.
3. Remove the `fs`, `path`, `os`, `url`, and `process` imports from
   `imports.mustache`. Search the builder and the other templates for any
   use of those names in generated code before removing each one.
4. Run `pnpm run templates`, `make`, and `make fixtures`.
5. Extend the test from Task 4 to fail if the header imports any Node
   module.

### Task 14: docs

1. Write `docs/dev/runtime/host.md`. It covers the type, the three hosts,
   how code reaches the host, the lint rule, and how to add a function to
   the host.
2. Update the "Where the targets may differ" table in
   `running-without-node.md`, and its "What is left" list.
3. Add the new doc to the index in `CLAUDE.md` and to the
   `agency-runtime-docs` skill.

## PR 5: `contained.ts` moves into `nodeHost`

### Task 15: a move with no change in behaviour

1. Move `lib/stdlib/contained.ts` to `lib/host/nodeFiles.ts`, with its
   two test files.
2. Leave `lib/stdlib/contained.ts` as a file that re-exports from the new
   location, so the 33 importers do not change in this PR.
3. Add `HostFiles` to the `Host` type, and its entries to `NEEDS`. Give
   `nodeHost` a `files` part. Each function calls the matching
   synchronous function and returns the result in a resolved promise.
4. Move `fixedRoot` to `lib/host/roots.ts`. Leave `isContained` where
   it is. It uses `path` and `process.platform`, and it moves to the
   portable path module in PR 10.
5. `seams` becomes an option of `nodeHost`. The symlink tests build their
   own host with it.
6. Make `Root` opaque. `lib/host/roots.ts` owns its inside: it exports
   `fixedRoot`, which makes one, and `rootPath`, which reads it. Only
   files under `lib/host/` may import `rootPath`, and the lint rule
   says so. Rerun the search for `.real` and move every reader outside
   `contained.ts` to `resolvePath`. They may stay synchronous in this
   PR by calling the function in `nodeFiles.ts`, and they move to the
   host in PR 6.
7. Add `locate` to `HostFiles` and implement it on `nodeHost` by
   moving the body of `prepareContainedPath.ts` there. It runs its three
   steps synchronously inside one call, for the reason in that file's
   comment.
8. Update `docs/dev/stdlib/contained-files.md` for the new location.

## PR 6: the file functions become async

### Task 16: count first

`running-without-node.md` says to measure before changing.

1. On a scratch branch, delete the re-exports from
   `lib/stdlib/contained.ts` and run `tsc`. Each error is a call site.
2. For each call site, record whether the enclosing function is already
   async. Record the chain of synchronous callers above each one that is
   not.
3. List every helper that reads a file and later writes the same file.
   List every helper that makes several file calls that must not be
   interleaved.
4. Put the counts and both lists in the PR description. If the number of
   functions that must become async is far above what the spec expects,
   stop and report before continuing.

### Task 17: move the callers

1. Replace each call with the matching `host.files` function and an
   `await`.
2. A helper that was handed `run` reads `run.ctx.host` where it needs it.
   A helper that calls `currentRun()` keeps that call before its first
   `await`. `scripts/lint-run-reads.mjs` reports a call that could run
   after one.
3. A function with no run gets the host as an argument from its caller.
4. `readBytes` now returns a `Uint8Array`. Replace `.toString("base64")`
   and the other `Buffer` methods with `lib/stdlib/base64.ts` and
   `TextDecoder`.
5. Replace `readStream` in `modelVerify.ts` with `readChunks`. Replace
   the open-and-close checks in `speech.ts` and `approvedPath.ts` with
   `stat`.
6. Replace `resolveUnder` with `resolvePath`, and `_realTarget` with
   `realPath`. The callers of `prepareContainedPath` call `locate`.
7. Delete `lib/stdlib/contained.ts`.

`lib/compiler/closureValidator.ts` and `lib/cli/hostedModels.ts` also
import `contained.ts`. They are outside the lint rule. They import
`lib/host/nodeFiles.ts` directly and stay synchronous. Add a comment at
each import that says the file has no run to take a host from.

### Task 18: `updateText`

1. Implement `updateText` on `nodeHost`. It reads, calls `change`, and
   writes, with synchronous `fs` calls and no `await` between them.
2. Move every helper from the first list in Task 16 to `updateText`.
3. Add `withLock` to `HostFiles`, a lock the host keeps, keyed by path.
   `updateText` takes it too. Wrap every helper from the second list in
   `withLock`. Do not use the per-run lock from
   `docs/dev/runtime/lock.md`: it does not cover two runs in one process
   under `agency serve`, it is not reentrant, and a branch of a `fork`
   can deadlock on it. Today those helpers are synchronous, so nothing
   runs in the middle of one, and the host's lock keeps that true.
4. Add an Agency execution test under `tests/agency/`. Two branches of a
   `fork` edit different lines of one file through a stdlib function that
   uses `updateText`. Both edits are present afterwards. Copy the `fork`
   syntax from an existing test in that directory.

### Task 19: policy matching stays synchronous

This task is the last commit of PR B, because it runs while an interrupt is
being answered and the spec asks for it to be reviewed alone. It depends
only on PR 2. Read the "MUST READ" section on interrupts in `CLAUDE.md`
before this task.

1. `resolveDotDirPattern` in `lib/runtime/policy.ts` calls `realpathSync`
   on the working directory. Find every directory the matcher resolves.
2. Resolve those directories once, when the context is built, and store
   the results on the context.
3. Change the matcher to take the resolved strings. It stays synchronous
   and no longer imports `fs` or `contained.ts`.
4. Keep the behaviour of the existing `catch`: a directory that cannot be
   resolved is used as written.
5. `createExecutionContext` copies fields by hand. Copy the resolved
   directories there too, as Task 8 does for the host.
6. The existing policy tests must pass without edits to their
   expectations. Add one test where the working directory is a path that
   does not exist, and one where the agent home directory is created
   after the context is built.

### Task 20a: the effect sets data file

This task is its own commit in PR C. It is a build step and touches no
host code.

1. Add a `make` step that writes the effect sets into a TypeScript data
   file, and make `lib/runtime/effectSets.ts` read that file instead of
   the `.agency` source at run time.
2. Six files import `effectSets.ts`: four in the type checker,
   `lib/cli/effects.ts`, and `lib/runtime/policyFlags.ts`. Check each
   still gets the same values.

### Task 20b: the trace sinks

This task is its own commit in PR C. It moves code between files.

1. `trace/sinks.ts`: move `FileSink` to `trace/fileSink.ts`, which goes
   on the Node-only list. `CallbackSink` stays.
2. `trace/traceWriter.ts`: write through the sink and remove the `fs`
   import.

### Task 20: the runtime's own file use

Work through the remaining rows of the table under "Runtime files that
use the disk" in the spec.

1. `memory/store.ts` and `memory/frame.ts`: move to `host.files`.
   Enabling memory checks `requireCapabilities` for `fileRead` and
   `fileWrite`.
2. `replyAttachments.ts` and `lib/runtime/builtins.ts`: move to
   `host.files`.
3. `node.ts`: read what it uses `fs` for, and give it a row in the spec's
   table in this PR.

## PR 7: `memoryHost` and the shared tests

### Task 21: `lib/host/memoryHost.ts`

1. Files live in a plain object keyed by path. Use an object, not a
   `Map`.
2. `subprocess.run` and `network.fetch` return results the test supplied,
   and throw a clear error for a command or a request the test did not
   script.
3. `clock` is a `FakeClock`. `random` returns a counter-based sequence.
4. `terminal` records what was written in an array the test can read, and
   answers `readLine` from a list the test supplied. `settings.read`
   answers from an object the test supplied, and `settings.log` records
   in an array.
5. `memoryHost` takes the capability list and passes its parts to
   `makeHost`, which supplies the refusals. `memoryHost` contains no
   refusal code.

### Task 22: one test file for every host with files

1. Write `lib/host/files.shared.test.ts`. It exports a function that
   takes a way to build a host and registers the tests.
2. Run it against `nodeHost` in a temporary directory, and against
   `memoryHost`.
3. Cover every function in `HostFiles`, each `WriteMode`, a missing file,
   a path that escapes the root, and the `updateText` rule.
4. For the `updateText` rule, start two updates on one file without
   awaiting the first, and check both changes are present.

## PR 8: subprocesses

### Task 23: read every call site

There are 29. For each one, record which of `run` and `start` it
needs, and anything it needs that `RunOptions` and
`RunningProcess` in the spec do not have. Update the spec if the type
changes.

### Task 24: `nodeHost.subprocess`

1. Add `HostSubprocess` to the `Host` type, and its entries to `NEEDS`.
   Implement `run` and `start`. `lib/stdlib/abortable.ts` already has the
   shared `spawn` code that `bash` and `exec` use. Build on it.
2. Leave the `fork` call in `lib/runtime/ipc.ts`. Add one line at the
   top of `_runFor` that calls `requireCapabilities` for `subprocess`.
   Read `docs/dev/runtime/subprocess-ipc.md` first, and change nothing
   else in that file.
3. `ffmpeg.ts` calls `spawnSync` to probe for `ffmpeg`, and
   `localProvider.ts` calls `execFileSync`. The first becomes an async
   `run`. The second is in a Node-only file and stays.

### Task 25: move the callers

Replace each call site with the host function. `lib/stdlib/shell.ts`,
`keyring.ts`, `clipboard.ts`, `ocr.ts`, `imessage.ts`, `appleNotes.ts`,
`notify.ts`, `oauth.ts`, `speech.ts`, `ffmpeg.ts`, `imageTools.ts`, and
`github/credential.ts` all change.

## PR 9: network

### Task 26: `host.network.fetch`

1. Add `HostNetwork` to the `Host` type, and its entry to `NEEDS`.
   Implement it on `nodeHost` as a call to the global `fetch`.
2. Replace each `fetch` call in `lib/stdlib` with `host.network.fetch`.
3. `lib/host/default.node.ts` reads `AGENCY_FETCH_MOCKS_FILE` since
   Task 13 and patches the global `fetch`. Change it to return a host
   whose `network.fetch` answers from the mocks file instead. Check
   which tests rely on the global being patched for requests that do not
   go through the stdlib, and report them before removing
   `installFetchMock`.
4. The model client's own requests do not change.

## PRs 10 to 14: portable replacements

One PR each, in this order.

### Task 27: paths

1. Count the code that depends on Windows path rules: uses of
   `path.win32`, `path.sep`, and checks of the operating system near a
   path call. Report the count before writing code.
2. Do not write a path module. Add `path-browserify`, which is Node's
   own `path.js`, pinned the way `docs/dev/contributing/supply-chain.md`
   says, and choose it through a `#path` entry in the `imports` field
   (`default` is Node's `path`), the same mechanism as `#sha256`. The
   containment checks are built on `path.relative` and `path.resolve`,
   and a difference between our module and Node's is how a containment
   bug happens. Test that both files give the same answers on the
   inputs `contained.ts`'s tests use.
3. `path.resolve` and `path.relative` read the working directory. The
   two directories call them 36 and 8 times. The portable versions take
   the working directory as an argument, from `host.system.cwd()`.
4. Replace `path` imports in files the lint rule covers, and move
   `isContained` into the new module.

### Task 28: hashing

Done in #1177, with one change still to make: `sha256.portable.ts` is
hand-written SHA-256, and the browser has WebCrypto. Add async
`sha256BytesAsync` and `hmacSha256Async` to `lib/utils/hash.ts`, over
`crypto.subtle` on both platforms, and move the S3 request signer and the
OAuth PKCE challenge to them; both callers are async already. The
hand-written version then serves only the synchronous checkpoint
checksum (Task 30), and it stays tested against Node's output. Done in
#1177: Node keeps its own crypto through a `#sha256` entry in the
`imports` field of `package.json`, with an ambient declaration in
`lib/utils/packageImports.d.ts` and an alias in `vitest.aliases.ts`. PR B
reuses all three for `#default-host`.

1. Replace the body of `sha256Text` with a portable SHA-256. Add a
   function for bytes and an HMAC beside it. Test all three against
   Node's `createHash` and `createHmac` on empty input, short input, and
   a megabyte of random bytes.
2. Replace the direct `createHash` calls in the tool-loop guards, the
   decision collector, the trace store, `lib/stdlib/oauth.ts`, and
   `lib/stdlib/aws/sigv4.ts` with calls to `lib/utils/hash.ts`.
3. `lib/stdlib/oauthEncryption.ts` and `lib/stdlib/modelVerify.ts` stay
   Node-only, with the reasons in section 5 of the spec. Move them to the
   Node-only array with those reasons.
4. Time `sha256Text` before and after on the generated code of a large
   module, because the compiler calls it for every file. Put both
   numbers in the PR description. If the portable version is more than
   twice as slow, stop and report before merging.

### Task 29: `Buffer`

Replace the remaining `Buffer` uses in files the lint rule covers with
`Uint8Array`, `TextEncoder`, `TextDecoder`, and `lib/stdlib/base64.ts`,
whose encoder goes through `btoa`. Move `decodeBase64Strict` to `atob`
too, keeping its validation.

### Task 30: the checkpoint checksum

Read `docs/dev/runtime/checkpoint-integrity.md` first. This PR gets its
own review.

1. Use the HMAC from `lib/utils/hash.ts`, added in Task 28.
2. Write a constant-time comparison to replace `timingSafeEqual`.
3. Test that checksums made before this PR still verify. Use fixed bytes
   and a fixed key with the expected checksum written in the test.
4. Time verification on a checkpoint of several megabytes, before and
   after. Put both numbers in the PR description. If verification is
   more than twice as slow, stop and report before merging.

### Task 31: module fingerprints

Read `docs/dev/runtime/checkpoint-code-fingerprints.md` first. This PR
gets its own review.

1. Have the compiler compute each module's fingerprint and pass it to
   `__registerModuleFingerprint` in the generated code.
2. Remove the `statSync` call from `moduleFingerprintRegistry.ts`.
3. The fingerprint is a hash of the generated code. Today it is the
   modification time of the compiled file, which changes on every
   rebuild. A hash of the source alone would stay the same after a
   compiler upgrade that changes the generated steps, and a checkpoint
   from the old build would resume into code with different steps. Add a
   test for that case: the same source, compiled by a generator that
   emits different code, gets a different fingerprint.
4. The existing tests that refuse a resume after a code change must pass.

## PR 15: the browser entry point

### Task 32: `browserHost`

1. Write `lib/host/browserHost.ts`. `browserHost` takes the terminal
   functions, an object of environment values, and the working directory
   to report. Every argument is optional. The default terminal writes to
   `console.log` and `console.error`, and its `readLine` throws
   `UnsupportedOnHostError`.
2. It passes its parts and `PLATFORM_CAPABILITIES.browser` to
   `makeHost`. It has no `files` or `subprocess` code. `makeHost`
   supplies those refusals.
3. `system.exit` throws `UnsupportedOnHostError`. `system` is not a
   capability part, so this is the one refusal the file contains.
4. Write `lib/host/default.browser.ts`, and add the `browser` condition
   to `#default-host` in `package.json`.

### Task 33: `lib/runtime/browser.ts`

1. Export everything the header imports. For `runCliEntry`, `_runFor`,
   and any other name from a Node-only file, export a stand-in that
   throws `UnsupportedOnHostError`.
2. Add the `browser` condition to the `./runtime` entry in
   `package.json`.
3. Add a test that parses the names `imports.mustache` imports from
   `agency-lang/runtime` and checks `browser.ts` exports each one.
4. Add a test that derives the stand-ins from the Node-only array in
   `eslint.node-exceptions.js`. A header name needs a stand-in exactly
   when the file that defines it is on that array. The test fails when
   `browser.ts` has a stand-in too many or too few.

### Task 34: the CI checks

1. Add a small Agency program under `tests/browser/`. It prints, reads an
   environment variable, sleeps, raises an interrupt that a handler
   approves, and calls `read` inside a handler that approves it.
2. Add a script that compiles it and bundles it with
   `esbuild --platform=browser`. The script fails if the bundle output
   mentions a Node module. An `--external:smoltalk` import stays in the
   bundle as a bare name, which a browser cannot resolve, so until the
   smoltalk change lands, point `smoltalk` at a small stand-in file with
   esbuild's `--alias`. The stand-in exports the names the runtime
   imports and throws if one is called. Say so in a comment.
3. Add a test that loads the bundle in a headless browser. It builds a
   `browserHost` whose terminal records output and passes it through
   `InvocationOptions`, from Task 8b. It checks the printed text and
   checks that the `read` call returned a failure naming `fileRead`.
4. The headless browser is `playwright-core` with the Chromium it
   downloads. Read `docs/dev/contributing/supply-chain.md` before adding
   the dependency, and pin it the way that doc says.
5. Add both to a CI workflow.
6. Record the bundle size in the PR description.

### Task 35: empty the exceptions list

The "waiting for a later PR" array in `eslint.node-exceptions.js` should
now be empty. Delete it. Anything left is either moved in this PR or
added to the Node-only array with a reason.

## PR 16: the rename

### Task 36: `std::capabilities` becomes `std::effectSets`

1. Rename `stdlib/capabilities.agency` to `stdlib/effectSets.agency`, and
   update every import of it.
2. Change "capability sets" to "effect sets" in `agency effects` and in
   `docs/dev/cli/effects-command.md`.
3. Read each of the roughly 18 files in `lib/` that use the word. Change
   the ones that mean effect sets.
4. Update the guide pages and regenerate the stdlib docs with `make`.

## PR 17: the tag

### Task 37: parse and check `@capabilities`

1. The parser already attaches tags to effect declarations, and it
   accepts `@capabilities()` with no arguments and two tags on one
   declaration. No parser change is needed. Add a formatter test that
   both tags survive `agency fmt`.
2. In `lib/typeChecker/effectPayloadCheck.ts` or a file beside it, check
   the tag. Each argument must be a bare identifier in `CAPABILITIES`. An
   unknown name is an error that suggests the closest name, using
   `lib/levenshtein.ts`.
3. Register the new diagnostic in `lib/typeChecker/diagnostics.ts` with
   the next free code, and add its explanation.
4. The names are checked only inside the tag. Add a test that a variable
   named `network` and a function named `terminal` still compile.
5. Store each effect's capabilities on its symbol, beside its payload
   type.

### Task 38: tag every `std::` effect

1. Add the tag to every `effect std::` declaration in `stdlib/`. There
   are about 300. Decide each one by reading what its function's helper
   calls on the host.
2. An effect whose function calls no capability gets `@capabilities()`.
3. Add a test that parses every stdlib file and fails on an `effect
   std::` declaration with no `@capabilities` tag.
4. Run `make` to rebuild the stdlib and its docs.

### Task 38b: check the tags against the code

The tags from Task 38 are written by hand. This task adds the check from
"Checking a tag against the code" in the spec.

1. The runner starts each test in a subprocess, so a callback cannot
   cross to it. Add a switch that `lib/host/default.node.ts` reads
   through `settings`. It names a file, and the host's `onUse` appends
   the host function's name and its capability to that file. The runner
   sets the switch and reads the file when the child exits.
2. Record the effects each test raises, and look up the capabilities on
   their tags.
3. Fail a test when the host was asked for `fileRead`, `fileWrite`,
   `network`, or `subprocess` and no raised effect is tagged with it.
   The message names the host function and the effects. `terminal` is
   left out, because `print` and `input` raise no effect and nearly
   every test prints.
4. Run the stdlib's Agency tests in CI with the check on. Each report is
   one of two things: a tag that is missing a capability, which this
   task fixes, or a function that uses the host and raises nothing,
   which Task 43 decides. If the check reports more than a few dozen,
   stop and report the list before fixing them one by one.

### Task 39: docs

1. Add a section on `@capabilities` to `docs/site/guide/effects.md`.
   State the difference from handlers and policies, using the table in
   section 2 of the spec.
2. Write `docs/dev/language/capabilities.md`, and add it to the index in
   `CLAUDE.md` and to the `agency-language-docs` skill.

## PR 18: the platform check

### Task 40: the flag and the config field

1. Add `platform` to the config schema in `lib/config/config.ts`, with
   values `"node"` and `"browser"` and a default of `"node"`.
2. Add `--platform` to `compile`, `typecheck`, `bundle`, and `pack`.
   `run` always runs on Node and does not take it. Read
   `docs/dev/cli/cli-arguments.md` first.
3. The compiler reads `PLATFORM_CAPABILITIES` from `lib/host/host.ts`,
   which PR 2 added. Do not write a second table.

### Task 41: the check

1. After type checking, for each node and each exported function in the
   files being compiled, look up the capabilities of every effect it can
   raise. Read `interruptEffectsByFunction` from the type checker's
   result, the list `lib/cli/policy.ts` reads, and not the symbol
   table's `interruptEffects`, which cannot see a function stored in a
   variable or received as a parameter. Use the full list, not the
   unanswered one, so a handled call is still reported.
2. Report a new diagnostic for each capability the platform lacks.
3. When there is at least one violation, run the call graph from
   `lib/analysis/interrupts.ts` and add the call path to the message. Do
   not run it otherwise.
4. Tests: a direct call, a call through an imported function, a tool
   handed to `llm`, a function stored in a variable, a function made with
   `.partial` and passed to `map`, a call inside `with approve`, a
   program that never calls `read`, and the default platform.

### Task 42: Node-only stdlib modules

1. Add a constant array of module names to the compiler: `std::ui`,
   `std::agency`, `std::agency/local`, and any others Task 43 finds.
2. Importing one when the platform is `browser` is an error with its own
   diagnostic.
3. Add a test that derives the array from the Node-only array in
   `eslint.node-exceptions.js`. A stdlib module belongs on the list when
   its compiled file imports a `stdlib-lib` file that is on that array.
   The test fails when the compiler's array differs.

### Task 43: functions that use the host and raise nothing

This task is in PR 17, before Task 38b is finished, because that check
reports these functions.

1. Rerun the scan from the spec, and remove the false matches by hand.
   Add what Task 38b reports.
2. Give each remaining function one of the three answers in the spec.
   Write the list and the answers into the PR description.
3. A function that gets a new effect changes what a user is asked to
   approve. List those separately, and get them confirmed before merging.

### Task 44: refuse before the prompt

Read the "MUST READ" section on interrupts in `CLAUDE.md` before this
task.

1. Make each effect's capabilities available at run time. Follow how
   `@alwaysUnder` data reaches `lib/runtime/alwaysScope.ts`.
2. Where an interrupt is raised, before any handler is consulted, call
   `requireCapabilities` with the effect's capabilities and the run's
   host. When a capability is missing, return the same result the code
   returns for an interrupt a handler rejected, with a reason that names
   the capability. Do not add a second kind of failure.
3. Do not implement this as a handler the runtime installs. Handlers are
   not part of a checkpoint, so a restore path that forgot to install it
   again would let the effect through. The spec records this decision.
4. This adds a refusal. It must not skip or reorder a handler for any
   effect the host does support. Add a test that a handler still runs,
   and still can reject, for a supported effect.
5. Add Agency execution tests: a program raises a tagged effect on a
   host without the capability, and no handler body runs. Test both
   forms, `interrupt` and `raise`.
6. Add a test that resumes a checkpoint on a host without the capability
   and checks the effect is still rejected.

## Stage 19: clock and random values (dropped)

Kept for the record. Not part of the five PRs.

### Task 45: move the direct calls

1. Count first, as Task 16 does. There are 87 call sites, and many are
   in functions with no run. Report the count and the chains of
   synchronous callers before changing code.
2. Replace `performance.now()` and `Date.now()` in files the lint rule
   covers with `host.clock`. `std::date` is the largest user of wall
   time. Issue 609 tracks it.
3. Replace `nanoid()`, `randomUUID()`, and `randomBytes()` with
   `host.random`.
4. Remove the `ctx.clock` getter from Task 8.
5. Add the direct calls to the lint rule's banned list.

## Finishing a PR

1. Run the unit tests for the files touched, and save the output:

   ```
   pnpm test:run lib/host lib/runtime lib/stdlib > /tmp/host-tests.log 2>&1
   ```

2. Run the specific Agency tests that cover the change, one file at a
   time, and save the output. Do not run the full Agency test suite
   locally. CI runs it.
3. `pnpm run lint:structure`
4. `pnpm run fmt:ts`
5. `make`, when a stdlib file or a template changed. `make fixtures`,
   when generated code changed.
6. Update the dev doc for the area the PR changed. `docs/dev/runtime/host.md`
   from Task 14 describes one host when it is written, and grows with
   PRs 7 and 15. PR 18 also updates the CLI page for `--platform`, the
   `platform` field in `docs/misc/config.md`, and the generated
   diagnostics docs.
7. Check the new docs and comments against
   `docs/dev/contributing/general-writing-tips.md` and
   `docs/dev/contributing/verbal-tics.md`.
8. Write the commit message and the PR description to a file, and pass
   the file to `git` and `gh`.

## When to stop and ask

- A task seems to need a change in what a Node program does.
- A handler could be skipped, reordered, or left unregistered.
- Policy matching would need an `await`.
- Task 16's count is far larger than expected.
- A stdlib function would start asking for approval where it did not
  before.
- A change would put an `await` between the steps of `locate`.

## Out of scope

Everything under "Not in this spec" in the spec, and the smoltalk change.
