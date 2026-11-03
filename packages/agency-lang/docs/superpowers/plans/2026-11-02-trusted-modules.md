# Trusted modules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The owner prefers one agent working inline, so do not use subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host names, in `agency.json`, the directories of `.agency` modules it vouches for and where their compiled JavaScript is. A workflow may call tools from those modules; the child runs the host's compiled files; `catalog` and `checkWorkflow` read them; a compiled program says which trusted modules it loads; and a child gets its parent's list unchanged. Nothing outside `std::workflow` can compile against the list.

**Architecture:** One new leaf, `lib/compiler/trustedModules.ts`, holds the type, path resolution, containment, and the compiled-path mapping as pure functions. The closure validator learns to stop checking at a trusted module, whether it is an import or the entry, and to mirror every `.agency` file reachable from one so the typechecker sees a complete tree. The compiler rewrites trusted imports to absolute paths and compiles nothing trusted. The list reaches the runtime context the way `maxCallDepth` does (baked by the builder, read from `ctx`) and reaches a child the way `maxDepth` does (on the run and resume instructions, seeded into `SubprocessRunInfo` by the bootstrap). Every sandbox entry point takes the list as an explicit argument, and only `std::workflow`'s own TypeScript passes a non-empty one: the public `compile`, `typecheck`, `describe`, `run`, `runFile`, and `runCode` pass an empty list, so trusted modules are reachable only through a host-supplied tool list, which sandboxed code cannot build. A compiled program records the trusted modules it loads, and the `std::run` interrupt shows them. There is no `run` parameter and no narrowing: the root's list is its config, and a child's is its parent's.

**Tech Stack:** TypeScript in `lib/compiler/`, `lib/runtime/`, `lib/stdlib/`, `lib/cli/workflow/`, `lib/config/`, `lib/backends/typescriptBuilder.ts`; `stdlib/agency.agency`; vitest; `agency test` fixtures under `tests/agency/subprocess/` and `tests/agency-js/`.

**Spec:** `docs/superpowers/specs/2026-11-02-trusted-modules-design.md`. Linear ticket ADI-257. The review that shaped this version: `docs/superpowers/plans/2026-11-02-trusted-modules-review.md`.

**Depends on:** nothing unmerged. One PR, based on main.

## Background

- **Where the sandbox rule lives.** `validateClosure` (`lib/compiler/closureValidator.ts`) walks imports from the entry. A file entry goes through `walkFile`, which reads it as a validated file; an import goes through `walkLocalImport`, which refuses anything not ending in `.agency`, absolute paths, escapes from `dir` (containment, checked first), and symlinks (checked second), then `walkFile`. `walkParsed` refuses `node` and `pkg` kinds. `compileValidatedClosure` writes every module at its `relPath` into a private mirror and compiles each one there with `compileSource`, so the entry's relative imports resolve to mirrored copies. `compileSandboxed` turns a thrown `ClosureValidationError` into a `CompileResult` failure.
- **Who calls the validator.** `compileToProgram` in `lib/stdlib/agency.ts` for `compile`, `run`, `runFile`, and `runCode`; `sandboxImportErrors` in the same file for `typecheck`; and `describedFilePath` for `describe` with a `dir` and `filename`, which treats the described file as the **entry**. `std::workflow`'s `_checked` goes through `typecheck` then `compile`, and its `_signatures` goes through `describe`. The `agency workflow` commands call `_describe` straight from TypeScript (`describeModule`, `lib/cli/workflow/toolImports.ts`), with no run current; they hold the project's config as `io.config` (`lib/cli/workflow/commands.ts`). `compileAgencyOnly` in `lib/compiler/compileSandboxed.ts` is `--agency-only` and must keep refusing everything.
- **The compiler reads the closure from disk twice.** Step 6 of `compileSource` (`lib/compiler/compile.ts`, around line 187) rewrites import specifiers in the in-memory AST through `CompileStrategy.rewriteImport`. Step 6b, `buildCompiledClosure(syntheticPath, config)`, re-reads the entry **from disk** (the comment above `compiledSource` says so), so it sees the specifier as written, walks into every `.agency` file the entry imports, transitively, and throws `CompileClosureError: Input file '…' not found` for one missing from the mirror (`loadModule`, `lib/compiler/compileClosure.ts`). The typechecker in `prepareProgram` reads the same way, and `SymbolTable.build` skips a missing file silently, so a type named in a trusted module's signature from an unmirrored file never resolves. So every `.agency` file reachable from the entry must be in the mirror, whether or not it is compiled.
- **The init plan.** `buildCompiledClosure` puts each imported module into the entry's `awaitModules`, keyed by its mirror path. A host-compiled module registers its static init under the host's source path (`registryModuleId`, `lib/backends/typescriptGenerator.ts`), so `__awaitStaticInit` for a trusted module finds nothing and returns (`lib/runtime/crossModuleInitRegistry.ts`, around line 77). The closure-wide bootstrap in `runNode` still initialises every registered module, so ordinary calls work; an entry whose own `static` initialiser reads a trusted module's global would hit the read-before-init trap.
- **How a config value reaches the runtime.** `typescriptBuilder.ts` (around line 4600) copies `maxCallDepth`, `failurePropagation`, and `client.providerModules` from the config into the `RuntimeContext` constructor arguments it bakes into the generated program. `RuntimeContext` (`lib/runtime/state/context.ts`, around line 320) declares them. `parentConfigOverrides` (`lib/runtime/ipc.ts`, around line 1469) copies an allow-list of fields into a child's `configOverrides`, so a new `sandbox` key never rides there. `providerModules` is the precedent for a path list: relative paths resolve against `process.cwd()` when they are used (`withParentProviderModules`).
- **How a cap reaches a child.** `SubprocessIdentity` (`lib/runtime/ipc.ts`, around line 310) carries `maxDepth` on both instructions; `_runFor` builds the identity on every segment, run and resume alike; `subprocess-bootstrap.ts` (around line 193) seeds `SubprocessRunInfo` from the message before importing the script.
- **Lint scope.** `BROWSER_FILES` in `eslint.config.js` covers `lib/runtime/**`, `lib/stdlib/**`, and `lib/config/config.ts`, where Node modules are banned unless the file is in `NODE_ONLY` (`eslint.node-exceptions.mjs`). `lib/compiler/` is not covered.
- **Compiled output is not stable.** `compileToProgram` passes no `fingerprintModuleIds`, so each compile mints a random module id, the string entry gets a random `relPath`, and init registry keys name a fresh temp directory. Two compiles of one source differ today. The workflow generator's Agency *source* is what is deterministic (workflows spec, decision 12).
- **Test layouts.** `tests/agency/<dir>/<name>.agency` with `<name>.test.json` rows per node, run by `agency test`; `runCode`'s `dir` defaults to `""`, which refuses every local import, so rows that import pass `dir` relative to the working directory. `tests/agency-js/<name>/` holds `agent.agency`, `test.js`, and `fixture.json`: the runner compiles `agent.agency` from the package root and runs `test.js` from the test's folder, which imports `./agent.js` and writes `__result.json`. `.gitignore` ignores `**/*.js`; the hand-written helpers under `tests/agency/` were force-added.

Build and test commands: `pnpm run build`, `pnpm run test:run`, `pnpm run test:agency` (or `node ./dist/scripts/agency.js test tests/agency/subprocess`), `pnpm run test:agency-js`, `pnpm run lint:structure`.

## Global constraints

- Nothing in a trusted directory is validated, compiled, or name-checked by the sandbox. Its `.agency` source, and every `.agency` file reachable from it, is read only to mirror it for the typechecker and the closure builder, and to describe it.
- An import from a validated file that is a `.js` or `.ts` file is still refused, even when the file is under a trusted directory. Trust attaches to `.agency` modules.
- A trusted import must still sit inside `dir` and must not pass through a symlink. Only the "`.agency` files and `std::` only" rule stops at it.
- The root's list is its config. A child's list is its parent's, unchanged. No function takes a list from a model.
- Every sandbox entry point takes the list as an explicit argument. Nothing reads it from ambient state inside the compiler or infers it from a missing run.
- Only `std::workflow` compiles with the list, through TypeScript helpers that sandboxed code cannot import. Every public `std::agency` function passes an empty list. A test pins that `compile` of an entry importing a trusted module is refused even under a config that trusts it.
- A compiled program carries `trustedModules`, the absolute compiled paths it loads; empty for a program that loads none. The `std::run` interrupt shows it, and a checkpointed program whose files are missing fails before the fork, naming the path.
- `--agency-only` passes no list and refuses as it does today.
- The workflow generator's Agency source stays deterministic. Compiled bytes are not, and no test claims they are.
- Every refusal is a `CompileResult` failure or a `Result` failure, never a throw past `compileSandboxed`.

## Task 1: the leaf

**Files:** create `lib/compiler/trustedModules.ts` and `trustedModules.test.ts`.

- [ ] **Step 1: the type and the functions.**

```ts
/** A directory of `.agency` modules the host vouches for, and the directory
 *  their compiled JavaScript is in. As written in config they may be
 *  relative; once resolved they are absolute real paths. */
export type TrustedModules = { source: string; compiled: string };

/** Resolve each entry's paths against `baseDir` to real paths. A directory
 *  that does not exist, or is reached through a symlink, fails with the
 *  entry as written and the path it resolved to. */
export function resolveTrustedModules(
  entries: TrustedModules[],
  baseDir: string,
): { ok: true; value: TrustedModules[] } | { ok: false; error: string }

/** The entry under whose `source` the real path `file` sits, or null. */
export function trustedEntryFor(file: string, entries: TrustedModules[]): TrustedModules | null

/** The compiled file for a trusted `.agency` source: `source` swapped for
 *  `compiled`, `.agency` swapped for `.js`. */
export function compiledPathFor(file: string, entry: TrustedModules): string
```

Containment is `isStrictDescendant` from `lib/utils.ts`, on real paths. No `Map`, no classes, no narrowing function.

- [ ] **Step 2: tests.** A relative entry resolves against `baseDir`; a missing directory fails with both the entry and the resolved path in the message; a symlinked directory fails; `trustedEntryFor` finds a file in a nested subdirectory and not a sibling that shares a prefix (`src/agent` must not match `src/agentx/`); `compiledPathFor` keeps the subdirectory (`src/agent/scheduled/run.agency` to `dist/agent/scheduled/run.js`).

Commit: `trustedModules: the type, resolution, and the compiled path`.

## Task 2: config and the runtime context

**Files:** `lib/config/config.ts`, `lib/config/config.test.ts`, `lib/runtime/state/context.ts`, `lib/backends/typescriptBuilder.ts`, `lib/runtime/configOverrides.ts` (comment only), `docs/misc/config.md`.

- [ ] **Step 1: the config field.** Add a named `SandboxConfig = { trustedModules?: TrustedModules[] }` and `sandbox?: SandboxConfig` on `AgencyConfig`, importing the type with `import type` (`config.ts` is a browser file). The doc comment says what it means and that paths are relative to the working directory, as `client.providerModules` are. Add it to `AgencyConfigSchema`. Test that the schema accepts the BMO example and rejects an entry missing `compiled`.
- [ ] **Step 2: the context.** Add `trustedModules?: TrustedModules[]` (`import type`) to the `RuntimeContext` constructor arguments and a readonly field. In `typescriptBuilder.ts`, beside `maxCallDepth`, bake `cfg.sandbox?.trustedModules` into `runtimeCtxArgs` as written in the config.
- [ ] **Step 3: the effective list.** In `lib/stdlib/agency.ts` (Node-only, and the file every caller already imports), add

```ts
/** The list this process may hand to the sandbox: in a subprocess, what
 *  the bootstrap seeded; at the root, the context's config list resolved
 *  against the working directory. */
export function effectiveTrustedModules(ctx: RuntimeContext): TrustedModules[]
```

reading `getSubprocessRunInfo().trustedModules` when `ctx.subprocessDepth > 0`. A resolution failure at the root throws an `Error` with the leaf's message; the stdlib callers in Task 5 already turn a throw into a `Result` failure. Note in `configOverrides.ts`'s field list that `sandbox` is deliberately not an override: it rides `SubprocessRunInfo`.
- [ ] **Step 4: test** that a generated program with the config bakes the list (a builder test beside the `maxCallDepth` one), and that `effectiveTrustedModules` at the root resolves the config list and in a subprocess returns the seeded list (set `SubprocessRunInfo` in the test, as `ipc.test.ts` does).

Commit: `trustedModules: config field and runtime context`.

## Task 3: the validator stops checking at a trusted module

**Files:** `lib/compiler/closureValidator.ts`, `closureValidator.test.ts`.

- [ ] **Step 1: the argument and the record.** `ValidateClosureArgs` gains `trustedModules?: TrustedModules[]`. `ValidatedModule` gains `trusted: boolean`, meaning the module's source is mirrored and never compiled, and `trustedImports: Record<string, string>`, each import specifier the module writes that resolved to a trusted module, mapped to that module's absolute compiled path. The validator fills `trustedImports` while it walks, since it is the one place the specifier and the resolved file are both in hand; the compiler only reads it.
- [ ] **Step 2: the import branch.** In `walkLocalImport`, keep the `.agency` suffix check, the null-root check, and the absolute-path check as they are. Then, once `canonical` is known, call `trustedEntryFor(canonical, trusted)`. On a match the trust branch runs these, in this order, and returns:
  - containment in `dir`, as the existing check does: a trusted module outside `dir` is refused with the existing message, because the mirror can only place a file at its path relative to `dir`;
  - the symlink rule, `canonical !== resolved`, as the existing check does, with the existing message;
  - `compiledPathFor`; if it is not an existing regular file, a violation: `<label> imports '<path>', a trusted module whose compiled file '<compiled>' does not exist; build it first`;
  - record `{ [importPath]: compiled }` in the importing module's `trustedImports`, and call `walkTrustedFile(canonical)`.

  With no match, the existing rules run unchanged.
- [ ] **Step 3: the file-entry branch.** In `validateClosure`, after a file entry's existing containment and symlink checks and before `walker.walkFile`, call `trustedEntryFor(entryModuleId, trusted)`. On a match, check the compiled file as above and call `walkTrustedFile` instead. This is the `describe` path: the described module is the entry.
- [ ] **Step 4: `walkTrustedFile(canonical)`.** Reads the source through the same `readText` on the `dir` root, parses it, records `{ source, relPath, trusted: true, trustedImports: {} }`, and walks every `.agency` import it has, resolving each relative to the file, through `walkMirroredFile`: no rules at all, the file is read, parsed, recorded as `trusted: true`, and its own `.agency` imports walked the same way, wherever they live under `dir`. Imports that are not `.agency`, and `std::` imports, are ignored: not refused, not followed. A file outside `dir` is a violation naming it, since the mirror cannot place it. Every file is visited once, as `walkFile` already guarantees.
- [ ] **Step 5: tests**, using the fixture pattern already in the file (a temp dir under `process.cwd()`):
  - a trusted module with a `.js` import is recorded as trusted, the entry's `trustedImports` maps the specifier to the compiled path, and the helper is not in `modules`;
  - a trusted module that imports a non-trusted `.agency` file: both are in `modules` as trusted, and the non-trusted file's own `.js` import is not refused;
  - the trusted module as the **entry** (the `describe` case) is accepted and recorded as trusted;
  - a validated entry importing the `.js` directly is refused with the existing message;
  - a trusted module whose compiled file is missing is refused with the new message naming both paths;
  - a trusted module in a subdirectory keeps its subdirectory in the compiled path;
  - a trusted `source` directory reached through a symlink in the import path is refused by the symlink message;
  - a trusted module outside `dir` is refused by the containment message;
  - `trustedModules` undefined behaves as today: every existing test passes unchanged.

Commit: `closureValidator: stop checking at a trusted module`.

## Task 4: the compiler rewrites trusted imports

**Files:** `lib/compiler/compileValidatedClosure.ts`, `lib/compiler/compile.ts`, `lib/compiler/compileClosure.ts`, `lib/compiler/compileSandboxed.ts`, `lib/compiler/compileSandboxed.test.ts`.

- [ ] **Step 1: the mirror.** In `compileValidatedClosure`, write every module into the mirror at its `relPath`, so the typechecker and the closure builder find the trusted ones, but compile only the modules with `trusted: false`, and add only those to `modules` in the result. Pass each compiled module's `trustedImports` to `compileSource` as it is.
- [ ] **Step 2: the rewrite.** `CompileSourceOptions` gains `trustedImports?: Record<string, string>`. In step 6 of `compileSource`, before `CompileStrategy.rewriteImport`, replace a specifier present in `trustedImports` with its value. The replacement is an absolute path; Node ESM resolves it.
- [ ] **Step 3: the init plan.** `buildCompiledClosure` reads the mirror, so it sees the trusted module and would put it in the entry's `awaitModules` under its mirror path, a key no registered init has. Pass the set of trusted module paths into `buildCompiledClosure` and leave them out of `awaitModules` on purpose, with a comment: a trusted module registers its init under the host's own path when its compiled file loads, and the closure-wide bootstrap runs it; an entry's `static` initialiser may not read a trusted module's global, and `trusted-modules.md` says so.
- [ ] **Step 4: the mark.** `CompileResult`, and so `CompiledProgramValue` in `lib/stdlib/agency.ts` and the `CompiledProgram` the runtime materializes, gain `trustedModules: string[]`: the distinct absolute compiled paths across every module's `trustedImports`, sorted, empty when there are none. It is plain data on a value that already travels in checkpoints, so a checkpointed program keeps its mark. The Agency-level `CompiledProgram` type stays as it is; `materializeCompiledScript` reads the field off the value as it reads `modules`.
- [ ] **Step 5: `compileSandboxed`** passes `trustedModules` through to `validateClosure`.
- [ ] **Step 6: tests** in `compileSandboxed.test.ts`: the compiled entry's import of a trusted module is the absolute compiled path, the trusted module is not in `result.modules`, and `result.trustedModules` lists that path once; an entry with no trusted import has an empty `trustedModules`; an entry over a trusted module that imports a non-trusted `.agency` file compiles (this is the case the review found); `compileAgencyOnly` of an entry that imports a trusted module is refused, because it passes no list; with `fingerprintModuleIds: true`, two compiles of the same entry emit the same absolute compiled path, which pins that the rewrite does not depend on the mirror's temp directory.

Commit: `compile: emit a trusted import as its compiled path`.

## Task 5: only `std::workflow` compiles with the list

**Files:** `lib/stdlib/agency.ts`, `lib/stdlib/workflow/index.ts`, `stdlib/workflow.agency`, `lib/cli/workflow/toolImports.ts`, `lib/cli/workflow/commands.ts`, and their tests. `stdlib/agency.agency` does not change.

- [ ] **Step 1: the compiler-facing helpers.** `compileToProgram`, `sandboxImportErrors`, and `describedFilePath` in `lib/stdlib/agency.ts` take `trustedModules: TrustedModules[]` as a parameter and pass it to `compileSandboxed` or `validateClosure`. No default, no ambient read. The Agency-facing `_compile`, `_compileFile`, `_typecheck`, `_typecheckFile`, and `_describe` keep their signatures and pass `[]`: the public `compile`, `typecheck`, `describe`, `run`, `runFile`, and `runCode` never see a trusted module.
- [ ] **Step 2: the workflow helpers.** `lib/stdlib/workflow/index.ts` exports three functions for `workflow.agency` to import through `agency-lang/stdlib-lib/workflow/index.js`, a path sandboxed code cannot import: `_compileTrusted(source, dir, strict)`, `_typecheckTrusted(source, dir, strict)`, and `_describeTrusted(source, dir, filename)`. Each reads `effectiveTrustedModules(currentRun().ctx)` on its first line and calls the compiler-facing helper. They take no list: a caller can only use the config's.
- [ ] **Step 3: `workflow.agency`.** `_checked` calls `_typecheckTrusted` and `_compileTrusted` where it calls `typecheck` and `compile` today (around lines 224 and 231), and `describeGroup` calls `_describeTrusted` where it calls `describe` with a `dir` and `filename` (around line 168). The `std::` branch of `describeGroup` is unchanged. `runWorkflow`'s `run` call is unchanged: `run` takes a compiled program and compiles nothing.
- [ ] **Step 4: the CLI.** `describeModule` in `toolImports.ts` takes the list and passes it to `describedFilePath` through a TypeScript export; `commands.ts` resolves `io.config.sandbox?.trustedModules` once with `resolveTrustedModules` against the working directory and hands it down. A resolution failure is a command error printed like any other.
- [ ] **Step 5: tests.** A unit test that `compileToProgram` passes its argument to `compileSandboxed` (spy, as the file's other tests do), and that `_compile` passes an empty list; a `commands.test.ts` case where a config with a trusted entry reaches `describeModule`; the scope test in Task 7.

Commit: `std::workflow is the only caller that compiles with trusted modules`.

## Task 6: the list rides to the child unchanged

**Files:** `lib/runtime/ipc.ts`, `lib/runtime/subprocessRunInfo.ts`, `lib/runtime/subprocess-bootstrap.ts`, `lib/runtime/ipc.test.ts`, `stdlib/agency.agency`.

- [ ] **Step 1: `SubprocessRunInfo`** gains `trustedModules: TrustedModules[]` (`import type`), defaulting to `[]` in the module's initial value, with a doc comment beside `maxDepth`: the list the parent allowed this child, which is the parent's own.
- [ ] **Step 2: `SubprocessIdentity`** gains `trustedModules: TrustedModules[]`, always present. In `_runFor`, put `effectiveTrustedModules(ctx)` on the identity. One line; `_runFor` is rebuilt on every segment, so a root restarted with a changed config resumes its children with the new list, which is intended.
- [ ] **Step 3: the bootstrap** seeds `trustedModules: msg.trustedModules ?? []` with the other identity fields, before the script is imported.
- [ ] **Step 4: the `std::run` interrupt** gains `trustedModules: string[]` in its data, beside `limits`: the compiled program's own mark, the files this program loads. A policy can match on it, and a person approving "Running agent-generated code in subprocess" sees the paths. `run`'s docstring gains one sentence. The allowed list is not in the data; what the child may import is config, and what this program does import is the question a policy asks.
- [ ] **Step 5: the files must exist.** `materializeCompiledScript` checks each path in the program's `trustedModules` is an existing regular file and throws with the path otherwise, so a checkpoint resumed on a machine without the build, or after the build moved, fails before the fork with a pointed message rather than a Node resolution error.
- [ ] **Step 6: tests** in `ipc.test.ts`: at depth 0 the identity carries the config list; a resume instruction carries the same list as the run instruction; at depth 1 the identity carries the seeded list; the `std::run` data carries the program's mark; materializing a program whose marked file is missing throws with that path.

Commit: `ipc: a child inherits the trusted modules, and a program says which it loads`.

## Task 7: fixtures and end-to-end tests

**Files:** `tests/agency-js/trusted-modules/` (new: `agent.agency`, `test.js`, `fixture.json`, `tools/tools.agency`, `tools/helper.js`), `tests/agency/subprocess/trusted-modules.agency` and `.test.json`, `tests/agency/subprocess/trusted-modules-nested.agency` and `.test.json`, `tests/agency/workflow/catalog.agency` and `.test.json`.

- [ ] **Step 1: the fixture.** `tools/tools.agency` exports `shoutViaJs(text: string): string` whose body calls `shout` from `./helper.js`; `tools/helper.js` is hand-written, exports `shout`, and is force-added (`git add -f`), like its neighbours under `tests/agency/`. No compiled file is committed.
- [ ] **Step 2: the agency-js test.** `test.js` compiles `tools/tools.agency` with the compiler API into a fresh folder under the package root's `.agency-tmp/`, copies `helper.js` beside the output, and calls `main(compiledDir)` from `./agent.js`. `agent.agency`'s `main(compiledDir)` builds a one-step workflow over `shoutViaJs` and runs it with `runWorkflow`, with `__dirname` as `dir`; the trusted list for the run comes from a `agency.json` beside the test naming `source: "tools"` and `compiled` as the folder `test.js` chose. Since the config is static and the compiled folder is not, `test.js` writes a small `agency.local.json` beside the test with the chosen `compiled` path before importing `agent.js`, and deletes both the folder and the file after. `fixture.json` expects `"HI!"`. This exercises separate `source` and `compiled` directories, which the single-directory case never does.
- [ ] **Step 3: `trusted-modules.agency`** in `tests/agency/subprocess`, with `dir: "tests/agency/subprocess"` on every row that imports, and a `tests/agency/subprocess/agency.json` naming `fixtures/trusted` as both `source` and `compiled`; `test.js`-style setup is not available here, so this fixture's `tools.js` is compiled in a `beforeAll`-shaped node: the first row calls `compile` from `std::agency` on `fixtures/trusted/tools.agency` and writes the output beside it with `write`, and the last row removes it. Rows:
  - `runsWithTrust`: `runWorkflow` of a one-step workflow over `shoutViaJs`, with the tool imported by the test file itself (the test file is host code, compiled outside the sandbox, so its import of `tools.agency` is ordinary), returns `"HI!"`.
  - `scopeIsWorkflowsOnly`: `compile` from `std::agency` of an entry source that imports `./fixtures/trusted/tools.agency` fails with `only .agency files may be imported` in the text, under the same config. This is the row that pins the scope.
  - `refusedWithoutTrust`: the same workflow run under a config with no `sandbox` key (a second test file in a folder with its own `agency.json`) fails the same way.
  - `directJsRefused`: `runCode` of an entry importing `./fixtures/trusted/helper.js` fails the same way.
  - `catalogTrusted`: `catalog` over `shoutViaJs` lists its parameter and return type; `describe` from `std::agency` of the same file with `dir` and `filename` is refused.
  - `runShowsTheMark`: a handler records the `std::run` data for the workflow run; the row expects `trustedModules` to hold the fixture's compiled path.
  - `missingCompiled`: a second fixture directory with a `tools.agency` and no `tools.js` fails before `std::run` is raised; the node records the effects it saw and returns them with the error, and the row expects no `std::run`.
- [ ] **Step 4: `trusted-modules-nested.agency`.** A root, with the fixture trusted, runs a workflow whose one tool is a trusted tool that itself calls `runWorkflow` over a second trusted tool in a directory outside the trusted list. The grandchild is refused, and the root returns the refusal text. A second node has the inner tool call `runWorkflow` over a tool in the trusted directory, and it succeeds, proving the list reached depth 2.

Commit: `tests: trusted modules run through workflows only, and reach a grandchild`.

## Task 8: the docs

**Files:** create `docs/dev/runtime/trusted-modules.md`; edit `docs/dev/runtime/subprocess-ipc.md` ("Import restrictions" and "What a child inherits"), `docs/misc/config.md`, `docs/site/guide/workflows.md` (the paragraph beginning "Workflow programs compile in Agency's sandbox"), `docs/dev/security/goal.md` ("What the floor still does not buy", one sentence: trusted modules are the host's code and are outside the sandbox by declaration).

- [ ] `trusted-modules.md` says, for a reader who has not seen the spec: what a trusted module is; the config example; that only `std::workflow` compiles against the list, so a trusted tool is reachable only through a host-supplied tool list, and the public `compile`, `run`, and `describe` refuse it; that a compiled program carries the trusted files it loads and `std::run` shows them; that a trusted module's `.agency` imports, and theirs, are mirrored for type information only and never compiled; what the validator still refuses (a `.js` import from validated code, a trusted module outside `dir`, a symlink); what the compiler emits; that trusted modules are left out of the entry's `awaitModules`, so an entry's `static` initialiser may not read a trusted module's global; how the list reaches a child; that the `std::run` interrupt shows it; that `--agency-only` ignores it; and that the `agency workflow` driver does not yet import trusted modules from their compiled path (ADI-287). Point at the spec for the reasoning and the alternatives.
- [ ] The workflows guide gains two sentences after the sandbox paragraph: a host whose tools call TypeScript names their directories as trusted modules in `agency.json`, and a workflow may then call them; link the config doc.

Commit: `docs: trusted modules`.

## Task 9: BMO, outside this repo

Not part of the PR; the check that the feature does what the ticket is for. The `agency workflow run` command does not work for BMO until ADI-287, so the run goes through BMO's own `runWorkflow` call.

- [ ] In `~/bmo/agency.json`, add `"sandbox": { "trustedModules": [{ "source": "src/agent", "compiled": "dist/agent" }] }`, bump `agency-lang`, and run `pnpm run build`.
- [ ] `agency workflow tools ./src/agent/lists.agency` lists the tools with their parameters and return types. This only describes, so it works before ADI-287.
- [ ] A harness node under `~/bmo/tests/agency/` calls `runWorkflow` on a hand-written `updateMealPlanFromGroceriesNote` workflow with a `session` input and a `beginSession` first step (BMO spec, `docs/superpowers/specs/2026-11-02-workflows-design.md`), with BMO's tools, against the real `dist/agent` and the real database, under a policy that approves the writes. This is BMO's ADI-281.
- [ ] Confirm the trusted module's `agency-lang/runtime` and the child's resolve to one package instance: a tool from `dist/agent` is found by name by the generated program. If it is not, the temp directory under the package root is the place to look; the spec's "Left to the builder" names it.

## As built

Where the implementation departs from the tasks above, and why:

- `effectiveTrustedModules` lives in `lib/compiler/trustedModules.ts`, not `lib/stdlib/agency.ts`. `lib/runtime/ipc.ts` calls it, and the runtime should not import the stdlib.
- Trusted modules are dropped from the init awaits in `compileSource` (`withoutTrustedAwaits`), after `initPlanForModule`, instead of inside `buildCompiledClosure`. The effect is the same and `compileClosure.ts` is unchanged.
- The validator walks a file that a trusted module imports and validated code also imports with the rules, and compiles it. Without this, the order of the walk decided whether such a file was checked.
- `SubprocessRunInfo.trustedModules` is optional and read as `?? []`, so the existing callers that seed run info need no change.
- The end-to-end tests are one agency-js test, `tests/agency-js/trusted-modules/`. The runner bakes `agency.json` when it compiles `agent.agency`, before `test.js` runs, so a config written by `test.js` would never be read. The folder's `agency.json` names `dist/tools` as `compiled`, and `test.js` copies the compiled tools there before it calls the agent. The rows from Task 7 Steps 3 and 4, and the catalog row, are nodes of that one agent.
- `toolRefs` maps a tool's recorded source file from a trusted `compiled` directory back to its `source` directory (`sourcePathFor`). A compiled module records its source beside itself, so a tool loaded from a build that copies its output (BMO's `tsc` into `dist/`) named a source file that does not exist, and a workflow over it could not be described. The nested test found this. BMO's own `runWorkflow` call needs it.
