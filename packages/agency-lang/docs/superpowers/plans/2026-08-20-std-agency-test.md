# std::agency `test()` + eval AgencyTestGrader Implementation Plan (v3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (this project does NOT use subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

v3 incorporates the v2 re-review, the anti-pattern audit, and the test-quality
audit. Internal interfaces are declarative: the validator returns an opaque
validated closure rather than making consumers own mirror mechanics; test-file
TS helpers are pure text-to-data transformations; argument binding shares a
declarative binding plan rather than one function pretending to return both
runtime arrays and named records; and the wrapper uses an explicit read-phase
state machine rather than scratch-wide approval. Every safety test has a
positive control, a restricted run, an independent observable, and a specific
diagnostic. Preflight tests assert the agent runner was never called.

Historical note: v2 introduced edge-aware mirroring, gated reads, scalar
scores, a shipped wrapper, mandatory transport tests, normalized sibling
graders, persisted revisions, and shared binding semantics. Its scratch-wide
read approval and concrete snapshot protocol are explicitly superseded by the
v3 phased wrapper and opaque compiler-owned closure below.

**Goal:** Add `test()`/`testFile()` to `std::agency` (run agency tests in the `run()` sandbox with parent-handler vetoes), promote the fib grading pattern into a framework-owned AgencyTestGrader with `holdout/` support, and replace the std::-only import rule with a pure-Agency closure validator.

**Architecture:** A new sandboxed compile entry validates the raw import closure (no TS/JS, no node builtins, no splices; local files realpath-confined to `dir`) and compiles from a private mirror of the validated bytes with import edges rewritten to mirror-relative paths, closing the TOCTOU boundary for every import shape. A shared test-file parser and verdict helper serve both the CLI runner and the new stdlib functions. `test()` is written in Agency on top of `run()`, so parent-handler semantics come free. The eval framework discovers `files/*.test.json` + `holdout/*.test.json`, synthesizes a grading module, and grades through a reject-all Agency wrapper that reports via a strict file envelope.

**Tech Stack:** TypeScript (vitest), Agency (tests/agency execution tests), zod, esbuild (existing grader bundling).

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/docs/superpowers/specs/2026-08-20-std-agency-test-design.md` (v4). Read it first; every task cites its sections.

## Global Constraints

- All paths below are relative to `packages/agency-lang/` unless absolute.
- After ANY change to `stdlib/*.agency` or `lib/agents/**/*.agency`, run `make` (not `pnpm run build` — it skips stdlib/agents). Run `make` once per batch of edits.
- Run ONLY the tests covering your changed files; save output to a file (e.g. `npx vitest run lib/testFormat > /tmp/out.txt 2>&1`); do not re-run to re-read failures.
- Agency execution tests run one at a time: `pnpm run agency test tests/agency/<name>.test.json`. Do NOT run the whole agency suite locally; CI does that.
- No dynamic imports. Objects not Maps. Arrays not Sets. Types not interfaces. One concept per file. No narrating comments.
- Never commit on main. Work on branch `adit/std-agency-test`.
- Commit messages: write to a file, `git commit -F <file>` (apostrophes break `-m`).
- The safety invariant (spec, "The safety invariant and the import policy"): the compile closure may contain only Agency source + `std::`; refuse TS/JS, node builtins, `pkg::` reaching those, and splices — with splice refusal BEFORE any expansion.
- Safety-test rule: every refusal test includes (1) a positive control proving the fixture can perform the behavior, (2) the restricted run, (3) an independent observable such as a missing file or zero launch count, and (4) the expected boundary-specific diagnostic.
- Temporary-file rule: create scratch directories under a known parent and remove them in `finally` with `safeDeleteDirectoryWithin`/`safeDeleteFile`; tests assert cleanup on success and failure. Never use raw `rmSync`/`unlinkSync` for new cleanup code.
- Name production constants (`WRAPPER_TIMEOUT_MS`, `MAX_DIAGNOSTIC_CHARS`); test-local durations may remain literal only when the test name and assertion make their purpose obvious.

---

### Task 1: Closure validator + opaque validated closure

**Files:**
- Create: `lib/compiler/closureValidator.ts`
- Modify: `lib/types/importStatement.ts`, `lib/types/exportFromStatement.ts` (module-path locations)
- Modify: `lib/parsers/parsers.ts` (capture module-path locations)
- Modify: `lib/analysis/imports.ts` (`getAllImports` includes re-exports and path locations)
- Test: `lib/parsers/importStatement.test.ts`, `lib/parsers/exportFromStatement.test.ts`
- Test: `lib/compiler/closureValidator.test.ts`

**Interfaces:**
- Consumes: `parseAgency` (`lib/parser.ts`), `getAllImports` (`lib/analysis/imports.ts`), `importKind`/`isStdlibImport`/`isPkgImport` (`lib/importPaths.ts`), `splicesIn` (exported from `lib/preprocessors/expandSplices.ts` — export it if module-private today), `resolveAgencyImportPath` (`lib/importPaths.ts`) for pkg resolution.
- Produces the compiler-subsystem opaque capability below. It is exported between compiler files, not from the package API. The private sketch explains ownership; consumers do not see or construct it.

```ts
declare const validatedClosureBrand: unique symbol;
export type ValidatedClosure = {
  readonly [validatedClosureBrand]: true;
};

// Compiler-private data—not re-exported from the package.
type ModulePathLocation = SourceLocation;
type LocalImportEdge = {
  fromModuleId: string;    // key into modules; caller-root modules only
  importPath: string;      // the path exactly as written in the source
  toModuleId: string;      // key into modules of the resolved target
  modulePathLoc: ModulePathLocation; // excludes surrounding quotes
};
type ValidatedModule = {
  source: string;
  relPath: string;
};
type ValidatedClosureData = {
  /** realpath of dir, or null = no local root: dir was "" and ANY local
   *  import anywhere in the closure is a validation error. Never resolve
   *  "" to cwd. */
  root: string | null;
  /** Module id → validated content. File ids are realpaths. A string entry
   * uses a private generated id and a collision-free relPath chosen after
   * validation; neither is a magic filename callers may depend on. */
  modules: Record<string, ValidatedModule>;
  /** Caller-root local edges only. Package-local edges are validated under
   * the package root, then deliberately omitted because pkg files are the
   * documented trusted re-read boundary. */
  localEdges: LocalImportEdge[];
  entryModuleId: string;
  /** pkg:: module paths that were validated (read from node_modules). */
  pkgModules: string[];
};

export type SourceClosureEntry = { source: string };
export type FileClosureEntry = { file: string };
export type ClosureEntry = SourceClosureEntry | FileClosureEntry;
export type ValidateClosureArgs = {
  entry: ClosureEntry;
  dir: string;
};
export function validateClosure(args: ValidateClosureArgs): ValidatedClosure;
// dir "" means root: null. Throws ClosureValidationError listing all violations.
```

**Rules the validator enforces** (spec: "The safety invariant and the import policy"):
- Walk the raw import graph breadth-first from the entry: parse each file with `parseAgency`, collect `getAllImports`, recurse into `local` and `pkg` imports. A file that fails to parse is a validation error naming the file.
- Per import, by `importKind`: `stdlib` → allowed, not walked (trusted). `node` → violation ("imports 'fs', which is not Agency source"). `local` → must end in `.agency` (a `./x.ts` classifies as local—refuse non-`.agency` explicitly); resolve/canonicalize root and target, then call the existing pure lower-layer `isStrictDescendant(root, target)` from `lib/utils.ts`. Do not copy `resolveInSandbox` containment logic. A symlink whose realpath lands inside `root` is VALID—privately record the written alias edge and canonical target. `root === null` → any local import is a violation. `pkg` → resolve via `resolveAgencyImportPath`, walk the package's `.agency` files under the same no-TS/no-node/no-splice rules with the PACKAGE ROOT as their own confinement boundary; record in `pkgModules`.
- Per file: `splicesIn(ast).length > 0` → violation ("contains a compile-time splice, which sandboxed compilation refuses").
- `getAllImports` becomes the one complete owner: ordinary imports, deprecated `import node`/`import tool`, and re-export statements. It returns each path with its parser-owned module-path location. Add an optional path-location field to each import-like AST type (generated nodes need not have source locations) while preserving whole-node `loc`; raw parsed imports must populate it and the validator treats its absence as an internal diagnostic. It covers the unquoted path contents. Parser tests assert the source slice for both quote styles and with comments/repeated path text elsewhere in the statement.
- Collect ALL violations before throwing (the list-every-violation style of `checkImportPolicy`, `lib/compiler/compile.ts:80`).

- [ ] **Step 1: Write failing tests** in `lib/compiler/closureValidator.test.ts` with `fs.mkdtempSync` fixtures:
  - (a) entry + relative local import → test projection reports both relative paths and one local edge; parser tests separately own exact module-path location assertions;
  - (b) **absolute import inside dir** (`import { x } from "${dir}/helper.agency"`) → valid, edge recorded;
  - (c) **symlink alias inside dir** (`alias.agency` → `real.agency`, import names the alias) → valid, one edge and one canonical target module in the test projection;
  - (d) `../outside.agency` → violation; (e) symlink inside dir pointing OUTSIDE → violation;
  - (f) `./helper.ts` → violation; (g) `import fs from "fs"` / `child_process` → violation;
  - (h) splice in an imported file → violation, and both a splice and an import violation are listed when both exist;
  - (i) **re-export edge**: `export { x } from "./y.agency"` where y imports `fs` → violation reached through the re-export; deprecated `import node` and `import tool` each reach an unsafe imported file too;
  - (j) **pkg:: safe closure**: a fake package fixture under a temp `node_modules` (pure-agency files) validates and lands in `pkgModules`; (k) **pkg:: unsafe closure**: the package's agency file imports `child_process` → violation naming the package file;
  - (l) `dir: ""` with any local import → violation; `dir: ""` with only std:: imports → `root: null` and one virtual entry module;
  - (m) missing local file, broken symlink, local parse failure, and package parse failure each become collected diagnostics naming the importing/failed file rather than raw exceptions;
  - (n) an import cycle terminates, records each module once, and preserves every edge; two aliases to one canonical target record two edges;
  - (o) file entry `../outside/main.agency` is refused before reading it; a symlinked `dir` root is canonicalized consistently;
  - (p) a string entry importing a real file named `__entry__.agency` gets a distinct generated mirror relPath—no overwrite or duplicate relPath.

```ts
test("absolute import inside dir stays valid and is recorded as an edge", () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".cv-abs-"));
  try {
    fs.writeFileSync(
      path.join(dir, "helper.agency"),
      "export def helperValue(): number { return 7 }",
    );
    fs.writeFileSync(
      path.join(dir, "main.agency"),
      `import { helperValue } from "${path.join(dir, "helper.agency")}"\n` +
        "export node main(): number { return helperValue() }",
    );
    const closure = validateClosure({ entry: { file: "main.agency" }, dir });
    expect(snapshotValidatedClosureForTest(closure)).toMatchObject({
      moduleRelativePaths: expect.arrayContaining(["main.agency", "helper.agency"]),
      localEdgeCount: 1,
    });
  } finally {
    expect(safeDeleteDirectoryWithin(process.cwd(), dir)).toEqual({ success: true });
  }
});
```

`snapshotValidatedClosureForTest` is a test-only projection returning only names/counts needed by validator tests—not mutable source, canonical ids, byte locations, or mirror layout. `compileValidatedClosure` uses a compiler-internal accessor that is not a package export.

- [ ] **Step 2: Run tests, verify they fail** (`npx vitest run lib/compiler/closureValidator.test.ts > /tmp/t1.txt 2>&1`).
- [ ] **Step 3: Add parser-owned module-path locations and complete `getAllImports`.** Reuse the already-tested `isStrictDescendant` helper after realpath canonicalization. Use `withLoc` around the path-content parser, map its `{ value, loc }` into the path location, and keep whole-node `loc` unchanged. Run parser tests first.
- [ ] **Step 4: Implement `validateClosure`** per the rules. Validation only—no compilation or mirror I/O. Use a queue plus a visited object keyed by canonical path; catch per-edge read/realpath/parse errors into the aggregate instead of aborting the walk. Freeze/seal the underlying data before wrapping it in the opaque capability.
- [ ] **Step 5: Run tests, verify pass.**
- [ ] **Step 6: Commit** ("closure validator: pure-Agency import closure with dir confinement and edges").

---

### Task 2: Sandboxed compile from the validated mirror

**Files:**
- Create: `lib/compiler/compileValidatedClosure.ts`
- Create: `lib/compiler/compileSandboxed.ts`
- Test: `lib/compiler/compileSandboxed.test.ts`

**Interfaces:**
- Consumes: opaque `validateClosure`/`ValidatedClosure` (Task 1), `compileSource` (`lib/compiler/compile.ts`). The closure's module ids, paths, edges, and rewrite locations stay private to `lib/compiler/`.
- Produces (Task 3 depends on this):

```ts
export type CompileSandboxedArgs = {
  entry: ClosureEntry;
  dir: string; // "" = no local imports possible
};
export function compileSandboxed(args: CompileSandboxedArgs): CompileResult;

/** Compiler-subsystem seam used after validation and by TOCTOU tests. */
export function compileValidatedClosure(closure: ValidatedClosure): CompileResult;
```

**Mirror materialization** (spec: "Splice refusal must precede splice execution"; review finding 1):
1. `validateClosure` → opaque validated closure. At the package-internal `compileSandboxed` boundary, `ClosureValidationError` and unexpected validation exceptions become `{ success: false, errors }`; the stdlib caller does not receive a throw.
2. Mirror root: `const root = fs.mkdtempSync(path.join(os.tmpdir(), "agency-sandbox-")); fs.chmodSync(root, PRIVATE_DIRECTORY_MODE);` with named `PRIVATE_DIRECTORY_MODE = 0o700` (`mkdtempSync` creates the directory—chmod after, never a second mkdir).
3. For each privately held module, compute the mirrored source: start from its validated `source` and replace each parser-owned module-path location with the POSIX relative path to the validated target module. Read the original quote delimiter immediately before the path location and escape backslashes plus that delimiter using Agency string-literal rules before splicing. Apply replacements back-to-front so offsets stay valid. This is the whole fix for absolute and symlink-alias imports: EVERY local import in the mirror names a mirror file, so `compileSource` can never follow a path back into the caller's directory. Only module-path bytes change; everything else is the validated bytes. These locations and the mirror layout are private compiler mechanisms, not public contracts.
4. Write each mirrored source at its collision-free private mirror path (mkdir -p parents).
5. `compileSource(mirrorEntrySource, { typechecker: { enabled: true }, sourcePath: <mirror entry path>, imports: { allowKinds: ["stdlib", "local", "pkg"] } })` — the policy stays on as a belt.
6. `finally`: remove the mirror with `safeDeleteDirectoryWithin(os.tmpdir(), root)`. Do not use direct recursive `rmSync`.

**Boundary comment to include** (spec finding-1 resolution): local files come only from the validated mirror. `pkg::` files are re-read from `node_modules`; acceptable because `node_modules` is already-trusted executable content (whoever can write it can write this process's own JS), unlike caller-owned directories.

- [ ] **Step 1: Write failing tests:**
  - (a) two-file relative-import compile → `success: true`;
  - (b) **absolute-inside-dir import compiles from the mirror**: after `validateClosure`, overwrite/remove the caller's `helper.agency`, then `compileValidatedClosure(closure)` → still succeeds (proves no re-read through the absolute path);
  - (c) **symlink-alias import**: validate through an alias, then remove/repoint the alias and overwrite/remove its original canonical target; `compileValidatedClosure` still succeeds from saved bytes;
  - (d) **swap-seam splice test**: validate a clean closure, overwrite the real `helper.agency` with a splice whose generator writes a sentinel (copy a working generator form from the existing splice fixtures under `tests/`), `compileValidatedClosure` → succeeds on clean bytes AND the sentinel does not exist;
  - (e) **splice sentinel positive control**: ordinary trusted `compileSource` of the exact fixture creates the sentinel; remove it, then `compileSandboxed` returns `success: false` with the splice-specific diagnostic AND no sentinel exists;
  - (f) `dir: ""` + relative import → failure from validation;
  - (g) source containing the path text in a comment/string and repeated imports rewrites only parser-owned path locations; single- and double-quoted imports targeting filenames containing a quote/backslash compile after delimiter-aware escaping;
  - (h) missing import, broken symlink, and local/package parse errors return diagnostics rather than throws;
  - (i) validation exceptions and compiler exceptions become `CompileResult` failures;
  - (j) identify the actual mirror through a `mkdtempSync` spy and assert cleanup after success, compile failure, and thrown compiler failure.
- [ ] **Step 2: Run, verify failures.**
- [ ] **Step 3: Implement** (`compileSandboxed = compileValidatedClosure(validateClosure(...))` plus error mapping at both boundaries). Keep mirror construction and rewriting in the compiler subsystem.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** ("sandboxed compile: mirror with rewritten import edges closes the TOCTOU boundary").

---

### Task 3: Wire the stdlib — `compile(source, dir)`, `runCode(..., dir)`, `runFile` local imports

**Files:**
- Modify: `lib/stdlib/agency.ts` (`compileToProgram`, `_compile`, `_compileFile`)
- Modify: `stdlib/agency.agency` (`compile`, `runCode`, `runFile` signatures + docstrings)
- Test: `tests/agency/agency-sandbox-imports.agency` + `tests/agency/agency-sandbox-imports.test.json`

**Interfaces:**
- Consumes: `compileSandboxed` (Task 2).
- Produces: `compile(source: string, dir: string = "")`, `runCode(..., cwd, dir: string = "")` (trailing optional — existing call sites unaffected), `runFile(dir, filename, ...)` compiles with `dir` as the confinement boundary.

- [ ] **Step 1:** Refactor `resolveInSandbox` to reuse existing pure lower-layer `isStrictDescendant` after canonicalization; add a stdlib regression only if current utility coverage does not exercise that caller. Do not copy containment logic across layers.
- [ ] **Step 2:** `lib/stdlib/agency.ts`: `compileToProgram(entry, dir)` → `compileSandboxed`; `_compile(source, dir = "")`; `_compileFile(dir, filename)` → `compileSandboxed({ entry: { file: filename }, dir })` (keep `resolveInSandbox` for the entry-file existence check).
- [ ] **Step 3:** `stdlib/agency.agency`: add `dir: string = ""` to `compile` and `runCode` (after `cwd`); update the three docstrings: imports may name std::, dir-local `.agency` files, and pkg:: packages with a pure-Agency closure.
- [ ] **Step 4:** `make`. Save output.
- [ ] **Step 5: Agency execution test** `tests/agency/agency-sandbox-imports.agency`: (a) seed a scratch subdir with `solution.agency` + `helper.agency` (`write(...) with approve`), `runFile` a node whose module imports the helper → value round-trips; (b) call public `compile(source, dir)` with a valid local import and execute the compiled program; (c) call public `runCode(source, input, cwd, dir)` with a valid local import, make its result include the runtime cwd and helper value, and assert compile `dir` and runtime `cwd` are independent; (d) `compile` of source importing `./nope.ts` → failure naming not-Agency-source; (e) source importing `child_process` → failure; (f) source containing a splice → failure. Exact-match nodes in the `.test.json`.
- [ ] **Step 6:** `pnpm run agency test tests/agency/agency-sandbox-imports.test.json > /tmp/t3.txt 2>&1` → pass. Also run the existing `tests/agency` files exercising `runCode`/`runFile` (grep for them; run only those).
- [ ] **Step 7: Commit** ("stdlib compile/runCode/runFile: dir-confined local imports via sandboxed compile").

---

### Task 4: Shared test-file parser (`lib/testFormat/schema.ts`)

**Files:**
- Create: `lib/testFormat/schema.ts`
- Test: `lib/testFormat/schema.test.ts`

**Interfaces (Tasks 6, 8, 10 depend on these):**

```ts
export type InterruptAction = "approve" | "reject";
export type ParsedInterrupt = {
  action: InterruptAction;
  value?: unknown;
  expectedMessage?: string;
};

export type ParsedTestCase = {
  nodeName: string;
  input: string;
  expected: unknown;
  criteria: "exact";
  interrupts: ParsedInterrupt[];
  timeoutMs?: number;
  description?: string;
};

export type ParsedTestFile = {
  sourceFile: string;
  defaultTimeoutMs?: number;
  description?: string;
  cases: ParsedTestCase[];
};

// Shared pure text-to-data functions: no reads, writes, globals, or clocks.
export function parseTestFileSandbox(jsonText: string, jsonFilename: string): ParsedTestFile;
export function parseTestFileFull(jsonText: string, jsonFilename: string): FullTestFile;
```

`ParsedTestFile.sourceFile` defaults to `<test-basename>.agency`. Sandbox `expected` is `JSON.parse(expectedOutput)` at parse time and gives quoting guidance on failure. `FullTestFile` uses separately named case, mock, clock, criterion, and handler types and retains raw `expectedOutput` for the legacy raw-string fallback; do not reproduce the CLI's current nested inline object types.

Sandbox-profile refusals (spec ledger, each naming the field): `llmMocks`, `fetchMocks` (both levels), `fakeClock`, `argv`, `retry`, `skip`, `skipOnCI`, `skipReason`, `useTestLLMProvider`, `expectedCompileError`, `llmJudge` criteria, actions `modify`/`resolve`, `modifiedArgs`. Empty `tests` is an error. `evaluationCriteria` exactly `[{ "type": "exact" }]` (sandbox) / at least one known criterion (full); missing/empty/unknown errors in BOTH. Full profile carries the complete field set currently typed inline at `lib/cli/test.ts:36-120` (move the definitions here; the CLI imports them in Task 6). Use `z.strictObject` for the sandbox profile.

- [ ] **Step 1: Write failing tests**: valid sandbox file parses (`sourceFile` default and explicit override; `expected` is the parsed VALUE — `"5"` → `5`, `"\"ok\""` → `"ok"`); malformed JSON; missing/empty `tests`; missing/empty/zero/multiple/unknown `evaluationCriteria`; unknown top-level and case fields; malformed handler; approve/reject handler mapping; invalid field types; invalid default/per-case timeouts; unquoted `expectedOutput: "ok"` errors with quoting guidance; one test per refused sandbox field; full profile accepts `tests/agency/git.test.json` verbatim and focused fixtures for compile-error expectations, LLM/fetch mocks, fake clock, argv, skips, `resolve`, and `modify` actions.
- [ ] **Step 2: Run, verify failures. Step 3: Implement. Step 4: Run, verify pass. Commit** ("shared .test.json parser, sandbox + full profiles").

---

### Task 5: Shared verdict + declarative argument-binding plan

**Files:**
- Create: `lib/testFormat/verdict.ts`, `lib/testFormat/inputArgs.ts`
- Modify: `lib/runtime/agencyFunction.ts` (extract the binding decision; keep `UNSET` private)
- Test: `lib/testFormat/verdict.test.ts`, `lib/testFormat/inputArgs.test.ts`

**Interfaces:**
- Consumes: `formatDiff` (`lib/utils/diff.ts`), `parseAgency` (`lib/parser.ts`), and the runtime's optional/default/variadic semantics.
- Produces (Tasks 6, 7, 8 depend on these):

```ts
// lib/runtime/agencyFunction.ts — declarative decision shared by adapters.
export type BindingParameter = {
  name: string;
  hasDefault: boolean;
  variadic: boolean;
};
export type SuppliedBindingSlot = {
  kind: "supplied";
  parameterIndex: number;
  valueIndex: number;
};
export type DefaultBindingSlot = {
  kind: "default";
  parameterIndex: number;
};
export type VariadicBindingSlot = {
  kind: "variadic";
  parameterIndex: number;
  valueIndexes: number[];
};
export type BindingSlot =
  | SuppliedBindingSlot
  | DefaultBindingSlot
  | VariadicBindingSlot;
export type ArgumentBindingPlan = {
  parameters: BindingParameter[];
  values: unknown[];
  slots: BindingSlot[];
  missingRequiredParameterIndexes: number[];
  extraValueIndexes: number[];
};
export function planArgumentBindings(
  parameters: BindingParameter[],
  values: unknown[],
): ArgumentBindingPlan;
// Declaratively records arity issues instead of throwing. It does not know
// about the runtime's UNSET sentinel or run()'s named record.

// runtime-private adapter used by AgencyFunction.resolvePositional:
function renderRuntimeArguments(plan: ArgumentBindingPlan): unknown[];
// Emits UNSET for default slots and one gathered array for a variadic slot.
// It deliberately preserves AgencyFunction's current behavior for invalid
// direct runtime calls; extraction is not an arity behavior change.

// verdict.ts
export type PassingVerdict = { pass: true };
export type FailingVerdict = { pass: false; feedback: string };
export type Verdict = PassingVerdict | FailingVerdict;
export type ExactVerdictOptions = { rawStringFallback: boolean };
export function exactVerdict(
  actual: unknown,
  expectedOutput: string,
  options: ExactVerdictOptions,
): Verdict;
// rawStringFallback=true (full/CLI): unparseable expectedOutput falls back to
// comparing JSON.stringify(actual) as a raw string (legacy). false: throws
// with quoting guidance (sandbox callers pre-parse via Task 4 anyway).
export function exactVerdictValue(actual: unknown, expected: unknown): Verdict;
// the sandbox-path form: both sides already values; canonical structural equality.

// inputArgs.ts — std::agency adapter
export function parseInputValues(input: string): unknown[];
export function renderNamedArguments(plan: ArgumentBindingPlan): Record<string, unknown>;
export function bindInputArgs(input: string, parameters: BindingParameter[]): Record<string, unknown>;
```

**`bindInputArgs`**: empty → `{}` only for a genuinely zero/fully optional signature; otherwise the same binding validation applies. `parseInputValues` parses `__probe(${input})` with `parseAgency`, takes the call's argument list (never eval/Function/string-split), and permits only recursively JSON-representable literals: string, number (including negative/exponent forms), boolean, null, arrays, and objects. It rejects interpolation, references, calls, and other expressions with the argument index and node kind. `planArgumentBindings` owns arity/default/variadic decisions. `renderNamedArguments` rejects recorded missing/extra values with required/accepted counts, emits supplied values, omits default slots, and gathers a variadic slot into one named array. Note in a comment: `paramListSignature` (`lib/typeChecker/checker.ts`) additionally treats schema-injected params as optional—Task 8's node-parameter table marks those `hasDefault: true` so the owners agree.

- [ ] **Step 1: Write failing tests.** Verdict: nested object key order is ignored; arrays, booleans, null, negative/exponent numbers compare correctly; mismatch gives a useful diff; fallback on/off. Binding-plan tests assert complete literal `slots` and explicit adapter outputs—not one adapter against another—for: zero parameters; `10, 5`; strings; nested literal inputs; omitted defaults; too few required values; over-arity with required/accepted counts; zero and many values to a variadic parameter; default before variadic; schema-injected optional parameter. Parser tests reject identifiers, interpolation, calls, and non-literal object members with argument index and AST node kind. Existing `AgencyFunction` tests pin exact runtime arrays for default gaps and variadic gathering and must remain unchanged apart from calling through the extracted plan.
- [ ] **Step 2: Run, verify failures. Step 3: Implement** the plan first, then the runtime-private and named-record adapters. Preserve `UNSET` inside `agencyFunction.ts`.
- [ ] **Step 4: Run `lib/testFormat` + `lib/runtime/agencyFunction` tests, verify pass. Commit** ("shared exact verdict; input binding reuses the runtime packing owner").

---

### Task 6: Migrate CLI precompile and runner onto one parsed source owner

**Files:** `lib/cli/test.ts`, `lib/cli/precompile.ts`, their co-located tests. Both paths consume `parseTestFileFull`; neither separately interprets raw JSON nor independently derives a source filename.

- [ ] Step 1: fixture audit script (scratchpad) over `tests/**/*.test.json` + `evals/**/*.test.json`; fix offenders; commit separately if any.
- [ ] Step 2: failing tests in `lib/cli/test.test.ts` and `lib/cli/precompile.test.ts`: empty criteria errors; default and explicit differently named `sourceFile`; `expectedCompileError` with explicit source if supported; precompile grouping names the declared source.
- [ ] Step 3: migrate `lib/cli/test.ts` (types → schema imports; comparison at ~line 674 → `exactVerdict`; honor parsed `sourceFile`; `llmJudge`/mocks/fakeClock untouched). Migrate `groupTestSources`/`precompileTestSources` in `lib/cli/precompile.ts` to the same parsed owner.
- [ ] Step 4: add an integration test for the complete ownership path: parse a `.test.json` whose explicit source differs from its basename → precompile that declared source → `runSingleTest(preferCompiled: true)` → assert the generated `.js` for that source is the artifact executed (make source and stale/default-name artifacts return different sentinels).
- [ ] Step 5: `npx vitest run lib/cli/test.test.ts lib/cli/precompile.test.ts > /tmp/t6.txt 2>&1` → pass; spot-run two real agency tests through CLI precompile + run.
- [ ] Step 6: Commit ("agency test precompile and runner share sourceFile resolution").

---

### Task 7: `test()` in `std::agency`

**Files:**
- Modify: `stdlib/agency.agency` (types + `test`), `lib/stdlib/agency.ts` (TS seams)
- Test: `tests/agency/agency-test-fn.agency` + `.test.json`

**Interfaces:**
- Consumes: Task 3 compile path, `run()` (existing), Task 5 helpers. TS seams added here:

```ts
// lib/stdlib/agency.ts (exported through agency-lang/stdlib-lib/agency.js)
export function _exactVerdictFeedback(actual: unknown, expected: unknown): string; // "" = pass; exactVerdictValue + feedback rendering
```

- Produces (Agency surface, spec "API" verbatim):

```ts
export type InterruptAnswer = {
  action: "approve" | "reject"
  value?: any
  expectedMessage?: string
}
export type TestArguments = Record<string, any>
export type AgencyTestCase = {
  node: string
  args?: TestArguments
  expected: any
  interrupts?: InterruptAnswer[]
  wallClock?: number
  description?: string
}
export type CaseReport = {
  node: string
  pass: boolean
  feedback: string
}
export type TestReport = {
  pass: boolean
  cases: CaseReport[]
}

export def test(dir: string, filename: string, cases: AgencyTestCase[],
  wallClock: number = 60s, memory: number = 512mb, ipcPayload: number = 100mb,
  stdout: number = 1mb, maxCost: number | null = null): Result<TestReport>
```

Name production constants for non-ABI defaults and diagnostics (`DEFAULT_TEST_WALL_CLOCK`, `DEFAULT_TEST_MEMORY`, `DEFAULT_TEST_IPC_PAYLOAD`, `DEFAULT_TEST_STDOUT`, and any feedback truncation limit) rather than scattering numeric literals.

**Execution** (spec "Execution semantics"): compile once via `try _compileFile(dir, filename)` (failure → whole-call failure). Wrap the case loop in `guard(cost:)` exactly as `run()` does (`stdlib/agency.agency:176-211` is the template; a trip returns the `limit_exceeded` shape with `limit: "cost"`). Per case, sequentially: scripted-answer handler as a def closing over a mutable index; `handle { run(program, case.node, case.args ?? {}, wallClock: case.wallClock ?? wallClock, ...) } with handler`. Handler: `intr.effect == "std::run" && intr.data.moduleId == program.moduleId` → `approve()`; else if answers remain → consume: `expectedMessage` mismatch → record + `reject(...)`; `approve` → `approve(answer.value)`; `reject` → `reject()`; exhausted → stay silent (propagates outward). Post-run: leftover answers → fail ("expected N interrupts, saw M"); run failure → fail with its text; else `_exactVerdictFeedback(envelope.data, case.expected)`. Failing case appends and CONTINUES.

- [ ] **Step 1:** `_exactVerdictFeedback` TS seam + vitest coverage (follow the existing test home for `lib/stdlib` helpers). Task 8 owns harness parameter parsing because that path must parse once for all cases.
- [ ] **Step 2:** `test()` + types in `stdlib/agency.agency`. `make`.
- [ ] **Step 3: Agency execution test** `tests/agency/agency-test-fn.agency` (no LLM). Fixture: scratch subdir with `solution.agency` (pure def; a def that raises `std::write` via `write()`; a def that raises a bare `interrupt("gimme")`; a def that loops forever) + `harness.agency` importing it. Cases to pin (review finding 10 additions marked •):
  - for every parent-policy refusal below, first run the exact fixture with a permissive parent and assert its return value or sentinel proves the body/effect/launch is reachable; remove any sentinel before the restricted run;
  - empty cases → a passing empty report; passing + failing in one call → `pass:false`, first case passes, second has feedback, batch completed;
  - **parent veto** (load-bearing four-part safety test): first run the write fixture under a permissive parent and assert the sentinel file exists; remove it; run reject-all-but-initial-launch parent + a scripted `approve` on the same `std::write` case; assert the case fails, sentinel is absent, and feedback names `std::write`/parent rejection;
  - parent rejects the initial `std::run` launch → case fails and the harness body sentinel is absent;
  - scripted approve with value round-trips;
  - • scripted `reject` answer → case fails with the rejection, batch continues;
  - `expectedMessage` mismatch fails the case; leftover answers fail the case;
  - • exhausted answers propagate: one OUTER handler rejects and another approves; assert each outer handler ran and the approving result reaches the case;
  - a nested `std::run` raised by tested code for a different module id is not auto-approved; assert its target sentinel is absent and feedback names the mismatched launch;
  - • per-case timeout: the infinite-loop def with `wallClock: 500` fails with `limit_exceeded` feedback and the NEXT case still runs;
  - unknown node fails only that case and the next case runs; compile syntax failure → whole-call failure;
  - defaults and zero/many variadic arguments work through the public `test()` API;
  - prove compile-once behavior without implementation coupling in a fresh disposable harness: case 1 uses an approved write to replace the source with invalid text, then case 2 invokes a different node from the already compiled program and passes. A per-case recompile would fail;
  - whole-call `maxCost` exhaustion returns the structured cost failure rather than `TestReport` (use deterministic test LLM mocks or another existing cost-bearing fixture so the guard genuinely trips);
  - pass non-default wall-clock, memory, IPC-payload, stdout, and max-cost values and assert each reaches its owning `run`/guard interrupt payload.
- [ ] **Step 4:** `pnpm run agency test tests/agency/agency-test-fn.test.json > /tmp/t7.txt 2>&1` → pass.
- [ ] **Step 5: Commit** ("std::agency test(): sandboxed agency tests with parent-handler vetoes").

---

### Task 8: `testFile()` — gates BEFORE reads, whole-file conversion up front

**Files:**
- Modify: `stdlib/agency.agency` (`testFile`), `lib/stdlib/agency.ts` (seams)
- Test: `tests/agency/agency-testfile.agency` + `.test.json`

**Interfaces:**
- Consumes: `parseTestFileSandbox` (Task 4), `bindInputArgs` (Task 5), and `test()` (Task 7).
- Produces:

```ts
export type NodeBindingTable = Record<string, BindingParameter[]>;

// Read seams perform their read ONLY when called, so Agency can gate first.
export function _readTestFileSandbox(dir: string, filename: string):
  ParsedTestFileWire;
export function _readNodeBindingTable(dir: string, sourceFile: string):
  NodeBindingTable;
// resolveInSandbox → one read → one parse → table for every exported node.

// Pure text/data conversion: no reads and no execution.
export function _bindTestFileCases(
  parsed: ParsedTestFileWire,
  parameterTable: NodeBindingTable,
): BoundCaseWire[];
// Binds EVERY case and carries parsed expected values. Unknown nodes and any
// bad input throw before test() can launch a case.
```

```ts
// Agency — the exact sequence, gate before read, mirroring typecheckFile's
// gate-then-helper idiom (stdlib/agency.agency:483-487):
export def testFile(dir: string, filename: string): Result<TestReport> {
  return _testFileForGrading(dir, filename, null)
}

// @internal stdlib ABI for the shipped grader wrapper; not user-facing API.
export def _testFileForGrading(
  dir: string,
  filename: string,
  maxCost: number | null,
): Result<TestReport> {
  return interrupt std::read("Read this test file?", { dir: dir, filename: filename })
  const parsed = try _readTestFileSandbox(dir, filename)
  if (parsed is failure) { return parsed }
  return interrupt std::read("Read the tested source file?", { dir: dir, filename: parsed.value.sourceFile })
  const parameters = try _readNodeBindingTable(dir, parsed.value.sourceFile)
  if (parameters is failure) { return parameters }
  const bound = try _bindTestFileCases(parsed.value, parameters.value)
  if (bound is failure) { return bound }
  return test(
    dir,
    parsed.value.sourceFile,
    <bound cases>,
    wallClock: parsed.value.defaultTimeoutMs ?? DEFAULT_TEST_WALL_CLOCK,
    maxCost: maxCost,
  )
}
```

(`return interrupt ...` then continuing is the stdlib's gate idiom — the interrupt must be approved for execution to continue past it, exactly as `typecheckFile` does. The JSON is not read until after gate 1; the harness not until after gate 2; `test()`'s own `_compileFile` read happens after gate 2 as well.)

- [ ] **Step 1:** Implement + vitest the TS seams: valid file maps with parsed expected values; each refused field errors; non-literal input names the case/node kind; unknown node and arity failures name harness, node, case, and accepted counts; default and explicit source files; an escaping `sourceFile` is refused before read; default/per-case timeouts; defaults and variadics. Spy on `readFileSync` and assert a multi-case/multi-node table uses exactly one harness read and parse. Assert `_bindTestFileCases` performs no reads.
- [ ] **Step 2:** `testFile` in `stdlib/agency.agency`. `make`.
- [ ] **Step 3: Agency test** `tests/agency/agency-testfile.agency`:
  - multi-case file (one passing with `input: "3, 4"` onto a 2-param node, one failing) → report shape checked; default and explicit `sourceFile`, timeout precedence, defaults, and variadics work through public `testFile()`;
  - a file with `llmMocks` → failure naming the field; unquoted `expectedOutput` → quoting guidance;
  - • **first-gate test**: a permissive control approves the exact `{ dir, filename }` and reaches the intentional JSON parse error; then a parent rejects the same first `std::read`, and the result is the read rejection, not parse error. Record observed payload and assert exact values;
  - • **second-gate test**: valid JSON points to an intentionally malformed/unreadable harness. A permissive control approves both reads and reaches the harness error; then reject the second read, assert the read rejection instead, assert exactly two read payloads with declared source filename, and assert no `std::run` launch occurred;
  - • **all-up-front test**: for each conversion-failure class (malformed expected output, non-literal input, unknown node, and arity mismatch), place a valid first case before the invalid case, count matching initial `std::run` launch interrupts in an outer handler, and assert whole-call failure plus launch count exactly zero. Absence of a `TestReport` alone is not evidence of non-execution;
  - internal `_testFileForGrading` with deterministic cost-producing fixture genuinely trips `maxCost` and returns structured whole-call cost failure.
- [ ] **Step 4:** Run it; save output; pass.
- [ ] **Step 5: Commit** ("std::agency testFile(): gates before reads, whole-file conversion up front").

---

### Task 9: AgencyTestGrader + shipped wrapper + envelope + real transport tests

**Files:**
- Create: `lib/eval/grading/agencyTestGrader.ts`, `lib/eval/grading/reportEnvelope.ts`
- Create: `lib/agents/eval/agencyTestWrapper.agency` — **shipping is solved by placement** (review finding 5): `AGENT_DIRS := review policy agency-agent eval optimize` (`Makefile:14`) already compiles and stages `lib/agents/eval/**`, so the wrapper travels to dist like every bundled agent. Resolve its path at runtime via `getAgentsDir()` (`lib/importPaths.ts:113`) + `"eval/agencyTestWrapper.agency"`.
- Test: `lib/eval/grading/agencyTestGrader.test.ts` (unit, seam-injected) and `lib/eval/grading/agencyTestGrader.spawn.test.ts` (REAL transport — mandatory in CI, modeled on the existing `*.spawn.test.ts` pattern, e.g. `lib/cli/run.spawn.test.ts`)

**Interfaces:**
- Consumes: `BaseGrader`/`Grade`/`GraderInput` (`agency-lang/eval`), `testFile` (Task 8, inside the wrapper).
- Produces (Task 10 depends on):

```ts
// reportEnvelope.ts — strict zod (spec v4 finding 3)
export type EnvelopeCaseReport = {
  node: string;
  pass: boolean;
  feedback: string;
};
export type EnvelopeTestReport = {
  pass: boolean;
  cases: EnvelopeCaseReport[];
};
export type TestedEnvelope = {
  status: "tested";
  report: EnvelopeTestReport;
};
export type CouldNotTestEnvelope = {
  status: "could-not-test";
  feedback: string;
};
export type ReportEnvelope = TestedEnvelope | CouldNotTestEnvelope;
export function parseReportEnvelope(text: string): ReportEnvelope;

// agencyTestGrader.ts
export type AgencyTestGraderOptions = {
  harnessAgency: string;
  harnessJson: string;
  name: string;
  /** Framework-owned whole-batch limit. Omitted means no cost cap. */
  maxCost?: number | null;
};
export class AgencyTestGrader extends BaseGrader {
  constructor(opts: AgencyTestGraderOptions);
  // externalFiles(): [harnessAgency, harnessJson]; rebindExternalFile per contract
  // score: { kind: "scalar", value: passed/total }  ← "scalar", NOT "numeric"
  //   (lib/eval/grading/types.ts:26 — the only kinds are binary|scalar);
  // constructed with { mustPass: true, threshold: 1 }
}
```

**Wrapper** (`agencyTestWrapper.agency`): reads `scratchDir`, `jsonFilename`, `sourceFilename`, `reportPath`, and the grader option's framework-owned `maxCost` from `std::args` (the CLI forwards trailing args to program argv — `lib/cli/commands.ts:274-277`). Synthesized graders omit `maxCost` by default; transport tests set it to drive the real whole-call guard. The wrapper implements an explicit read-phase state machine, with named states `awaitingJsonRead`, `awaitingSourceRead`, `runningTests`, and `writingReport`. Extract the handler's pure decision into a separately tested `decideWrapperInterrupt(phase, expectedRead, interrupt)` function returning a named `WrapperPolicyDecision` union (`approveAndAdvance`, `approve`, or `reject`); the imperative handler only applies that decision and updates state.

In `awaitingJsonRead`, approve only `std::read` with exact `{ dir: scratchDir, filename: jsonFilename }`, then advance. In `awaitingSourceRead`, approve only `std::read` with exact `{ dir: scratchDir, filename: sourceFilename }`, then advance. No tested program has launched during either bootstrap phase, so phase + effect + exact payload is the authorization boundary; do not depend on an undocumented `origin` shape. In `runningTests`, approve initial `std::run` votes but reject every `std::read` (including scratch-local reads) and every other tested-code effect, naming the effect and phase. Unexpected, repeated, reordered, or wrong-payload reads are rejected without advancing. Call `_testFileForGrading(scratchDir, jsonFilename, maxCost)` inside the handler; then set `writingReport`, leave the handler, build the envelope, and write the report with a narrow inline approval. A per-case wall-clock failure remains `tested`; only whole-call failures such as cost exhaustion become `could-not-test`. Use one shared failure formatter: string failures verbatim; `limit_exceeded` rendered with limit, threshold, and used values.

**Grader `_run`** (mechanics mirror `evals/agency-agent/fib/graders.ts`): no workdir → fail "run left no workdir". Scratch via `mkdtempSync` under `process.cwd()`. `fs.cpSync(workdir, scratch, { recursive: true })`—default `dereference: false`; comment: symlinks copy as links; confinement rejects escapes (spec v4 finding 2). Overwrite both harness files from `this.harnessPath(...)` (snapshot-rebound). Pass `path.basename(harnessAgency)` as the wrapper's expected source read; an inconsistent JSON `sourceFile` is therefore rejected at the second gate rather than widening authorization.

```ts
execFileSync(process.execPath,
  [process.argv[1], "run", wrapperPath,
    scratchDir, jsonName, sourceName, reportPath, maxCostArg],
  { stdio: "pipe", timeout: WRAPPER_TIMEOUT_MS });
```

`reportPath` lives in a second temp dir OUTSIDE scratch. Name `WRAPPER_TIMEOUT_MS` and the stdout diagnostic-tail limit. Read → `parseReportEnvelope` → `tested`: scalar passed/total + failing-case feedback lines; `could-not-test`: score 0, feedback verbatim; spawn error / missing / malformed envelope: score 0 with the stdout tail (lift the fib grader's `testOutput` strip-and-tail helper into this file). Put scratch and report-directory deletion in `finally` blocks using `safeDeleteDirectoryWithin`; cleanup must run for success, spawn throw/timeout, missing report, malformed report, and grading exceptions.

- [ ] **Step 1: Unit tests** (inject a named `RunWrapper` seam so these stub the envelope file): strict envelope parsing accepts both exact branches and rejects unknown fields, wrong discriminants, and invalid nested case fields; scoring math (3/4 → `{ kind: "scalar", value: 0.75 }`, `passes()` false; 4/4 → passes); could-not-test → 0 + verbatim; missing/malformed envelope, wrapper crash, and wrapper timeout → 0 + bounded stdout tail; no-workdir; wholesale multi-file workdir copy; both harness files overwritten byte-for-byte from snapshots despite workdir tampering; `sourceFilename` and `maxCost` forwarded; cleanup asserted for every success/failure path.
- [ ] **Step 2: Wrapper-policy tests** exercise every phase and transition independently: exact first and second reads advance; wrong effect/dir/file, reordered and repeated reads reject without advancing; no `std::run` occurs before `runningTests`; `runningTests` rejects a scratch-local read; `std::run` is allowed only in the running phase; writes/launch mismatches reject; writing phase has no broad approvals.
- [ ] **Step 3: Spawn tests** (`agencyTestGrader.spawn.test.ts`, real CLI, no LLM, NOT skipped in CI — review finding 6):
  - `tested` both ways: green harness → 1.0; red case → fraction + diff feedback in the failing line;
  - `could-not-test`, string failure: solution that does not compile → score 0, compile error text in feedback, THROUGH the wrapper file (not stdout);
  - `could-not-test`, malformed test JSON → score 0 naming the field;
  - **wall-clock branch**: infinite-loop first case + tiny `defaultTimeoutMs`, followed by a passing case → `status: "tested"`, first case false with wall-clock feedback, second passes, and scalar partial credit;
  - **whole-call cost branch**: pass a small framework max-cost through the real wrapper to a deterministic cost-producing fixture (`AGENCY_USE_TEST_LLM_PROVIDER`/`AGENCY_LLM_MOCKS`) → `status: "could-not-test"`, score 0, structured cost feedback;
  - **forged stdout**: a harness node that `print`s a fake `{"status":"tested",...}` envelope — score follows the report FILE, not stdout;
  - **read safety**: positive control runs the same solution scratch-local `read()` under a permissive parent and returns a canary; restricted real grader run fails the case, cannot return the canary, and feedback names `std::read`/running phase—even though tested code has an inline approval;
  - **write safety**: positive control creates a sentinel; remove it; real grader run fails the case, sentinel remains absent, and feedback names `std::write`;
  - tampered workdir harness is overwritten through a real spawn, not only the injected seam.
- [ ] **Step 4: Implement** grader + envelope + wrapper. `make` (new agent-dir .agency).
- [ ] **Step 5:** Run both test files, save output, pass. **Step 6: Commit** ("AgencyTestGrader: phased reject-all wrapper, strict file envelope, real transport tests").

---

### Task 10: Discovery, synthesized module, revision persistence, preflight, holdout

**Files:**
- Modify: `lib/eval/loadInputs.ts` (discover `files/*.test.json` + `holdout/*.test.json` in `applyTestDirectoryDefaults`, `loadInputs.ts:134-151` area), `lib/eval/runTypes.ts` (`Test` gains `agencyTests?: AgencyTestDefinition[]`)
- Modify: `lib/eval/run/runSuite.ts` (`snapshotGraders` at `runSuite.ts:253` — synthesis + preflight; it already receives the tests and config; ADD the `opts.suite` identity parameter — review finding 8)
- Create: `lib/eval/grading/synthesizeGradersModule.ts`
- Modify: `lib/eval/grading/gradingModule.ts` (`snapshotSynthesizedModule`; extend existing `GradersSnapshot` and `RecordedGraders` with `revision`), `lib/runDirectory/annotations.ts` (`GradersIdentity` + zod at `annotations.ts:172` gain `revision?: GraderRevision`), the snapshot loader (`loadGradingSnapshot`) and the live load path assign `${sourceIdentity}@${sha256}` when present
- Verify (add regression test, code change only if needed): seeding copies only the test's `files` dir, so `holdout/` is never seeded (`lib/eval/run/runAgent.ts`)
- Tests: `lib/eval/loadInputs.test.ts`, `lib/eval/grading/synthesizeGradersModule.test.ts`, `lib/eval/grading/gradingModule.test.ts`, `lib/eval/run/runSuite.test.ts` (follow each file's existing patterns)

**Interfaces:**

```ts
export type AgencyTestVisibility = "visible" | "holdout";
export type AgencyTestDefinition = {
  harnessJson: string;
  harnessAgency: string;
  name: string;
  visibility: AgencyTestVisibility;
};
// Test.agencyTests?: AgencyTestDefinition[]

export type GraderRevision = {
  sourceIdentity: string;
  sha256: string;
};

export type HarnessPair = {
  harnessAgency: string;
  harnessJson: string;
  name: string;
};
export type SynthesizedGradersModule = { moduleSource: string };
export type SynthesizeGradersModuleArgs = {
  siblingGradersPath?: string;
  pairs: HarnessPair[];
};

// synthesizeGradersModule.ts — deterministic: fixed template, pairs sorted by name
export function synthesizeGradersModule(
  args: SynthesizeGradersModuleArgs,
): SynthesizedGradersModule;

// generated shape — sibling normalized (review finding 7: importBundle
// normalizes at load, gradingModule.ts:148, but this spread runs before that):
//   import { AgencyTestGrader } from "agency-lang/eval";
//   import sibling from "<siblingGradersPath>";            // when present
//   const siblingList = Array.isArray(sibling) ? sibling : [sibling];
//   export default [...siblingList,
//     new AgencyTestGrader({ harnessAgency: "...", harnessJson: "...", name: "fib-tests" }),
//   ];

// gradingModule.ts
export type SnapshotSynthesizedModuleArgs = {
  physicalPath: string;      // staging location of moduleSource
  sourceIdentity: string;
  revisionInputs: string[];  // sorted sha256 of each harness pair file
};
export function snapshotSynthesizedModule(
  args: SnapshotSynthesizedModuleArgs,
): GradersSnapshot;
// revision = { sourceIdentity,
//   sha256: sha256(bundleCode + revisionInputs.join("")) }
```

**Suite-identity flow** (review finding 8, explicit): `runSuite` already holds `opts.suite: SuiteIdentity | undefined` (`runSuite.ts:58`); pass it into `snapshotGraders`. Add one canonical serializer/hashing owner for the complete tagged `SuiteIdentity` value, including `sha` when present, rather than delimiter concatenation. Compute source identity from the canonical suite digest plus the test id; inline input uses a distinct tagged identity. Unit tests prove separator-like strings and suite variants cannot collide. `GradersSnapshot.revision` flows into the actual run row's `graders.revision` at the same place `graders` is recorded today (`recordCompletedRun` in `runSuite`).

**Preflight** (before any agent runs, in `snapshotGraders`): parse every discovered JSON with the sandbox profile. Resolve and require its declared/default `sourceFile`; eval-discovered harnesses must be sibling files as specified by the directory convention. Refuse basename collisions across `files/` ∪ `holdout/` naming both paths. Refuse any `approve` scripted answer ("eval grading rejects all effects; this scripted approval cannot take effect"). Load sibling grader names and refuse collisions with discovered names before execution. On every preflight failure, the runner is never called.

- [ ] **Step 1: Write failing tests:**
  - discovery fixture (`files/a.test.json`, `holdout/b.test.json`) → two `agencyTests` entries with `visible`/`holdout` visibility; no `.test.json` anywhere → field absent (goal-judge path untouched); missing declared/default `sourceFile` and non-sibling eval `sourceFile` each error naming JSON and source;
  - nested `.test.json` files are intentionally ignored because discovery is non-recursive; a test pins that behavior and docs state it;
  - collision refused naming both paths; approve-answer refused with the spec message; malformed JSON refused at preflight; grader-name collision with a sibling is refused before agent execution. For every preflight fixture inject/spy on the runner and assert call count zero;
  - synthesis determinism: permute pair inputs, sibling ordering, and mocked directory enumeration order and assert byte-identical source; composition: sibling exporting an ARRAY and sibling exporting a SINGLE grader both compose through `importBundle`; distinct suite identities, including delimiter-like fields and different `sha`, never collide;
  - revision: two staged runs of one suite → equal revisions; edits to Agency harness, JSON harness, and sibling `graders.ts` each change revision; permutations do not; `loadGradingSnapshot` with `revision` recorded → annotator `${sourceIdentity}@${sha256}`; old-shape directory (no `revision`) → legacy identity; **copied run directory** (`fs.cpSync` elsewhere, fresh load, grade) → same revision; load the recorded run fresh and assert the actual persisted score annotation uses the persisted revision identity;
  - holdout staging end to end: exercise `loadInputs → runSuite → runAgent`, inspect the staged workdir seen by the agent, assert all visible `files/` content is present and all `holdout/` content is absent—not merely a direct seeding-helper unit test;
  - • **end-to-end symlink sentinel** (review finding 10 / spec v4 finding 2): first use the trusted compile path to prove a workdir `solution.agency` importing `link.agency` (a symlink to external valid Agency source) can return the sentinel value; then grade it through the REAL restricted grader path (reuse Task 9 spawn harness), assert the sentinel value is not returned or copied into scratch, and assert the case fails with the confinement diagnostic.
- [ ] **Step 2: Run, verify failures. Step 3: Implement** (discovery → named run types → preflight + synthesis + `snapshotSynthesizedModule` → annotations schema + both loaders → suite-identity threading). Sort all filesystem-derived inputs at the ownership boundary before rendering/hashing.
- [ ] **Step 4: Run only the touched test files, verify pass. Commit** ("eval: discovered agency tests, synthesized grader module, persisted revision").

---

### Task 11: fib migration + docs

- [ ] Step 1: `evals/agency-agent/fib/files/fib-tests.agency` (imports `fib.agency`, one exported node per case) + `fib-tests.test.json` (`sourceFile` explicit); `holdout/fib-holdout.agency` + `.test.json` (larger n, e.g. `fib(20) == 6765`); update `fib/test.json` input text (self-check command `agency test fib-tests.test.json`); delete `graders.ts` and the old harness pair.
- [ ] Step 2: acceptance fixtures through the real grading path: known-good fib passes visible and holdout; an overfit implementation passes visible examples but fails the larger holdout; an incorrect implementation fails with node-specific useful diff feedback. Use deterministic inputs only—no live LLM.
- [ ] Step 3: run the Task-10 discovery tests against the real fib dir as a fixture. Do NOT run the live eval locally; CI covers it.
- [ ] Step 4: `docs/dev/std-agency-test.md` (public API; validator invariant + confinement + opaque validated closure/mirror TOCTOU mechanism + node_modules boundary; declarative binding plan; one-vote answers; gate-before-read sequence; phased wrapper policy that rejects tested-code reads; envelope/tamper defense; holdout; synthesized module + persisted revision; CLI convergence). Clearly label public API, framework-only stdlib ABI, compiler-private internals, and test seams. Update `docs/dev/eval-grading.md` coding-test section. CLAUDE.md pointers.
- [ ] Step 5: Pre-PR: `pnpm run lint:structure`, `pnpm run fmt:ts`, anti-pattern audit of the full diff, repo-wide guards (`git diff --numstat` binary check; `npx vitest run lib/sourceIsText.test.ts`). Commit ("fib eval on framework agency-test grading; dev docs").

---

## Self-review notes (v3)

- Cross-task contracts are aligned: opaque `ValidatedClosure` → `compileValidatedClosure` → `compileSandboxed`; parsed sandbox values + `ArgumentBindingPlan` → up-front bound cases; internal `_testFileForGrading(maxCost)` → phased wrapper → strict envelope; `AgencyTestDefinition` → synthesized module → extended `GradersSnapshot` revision.
- The v2 blockers have concrete owners: parser-owned module-path locations (Task 1), compiler-private mirror protocol (Tasks 1–2), shared binding plan with two adapters (Task 5), precompile-owned `sourceFile` (Task 6), one harness parse (Task 8), phased exact-read wrapper and real cost mechanism (Tasks 8–9), and existing snapshot-type extension/canonical suite identity (Task 10).
- Safety claims require positive controls and independent observables. In particular, up-front conversion counts zero launches, mirror tests mutate original files after validation, wrapper tests reject scratch-local reads, and preflight tests spy on the agent runner.
