# std::agency `test()` + eval AgencyTestGrader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (this project does NOT use subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `test()`/`testFile()` to `std::agency` (run agency tests in the `run()` sandbox with parent-handler vetoes), promote the fib grading pattern into a framework-owned AgencyTestGrader with `holdout/` support, and replace the std::-only import rule with a pure-Agency closure validator.

**Architecture:** A new sandboxed compile entry validates the raw import closure (no TS/JS, no node builtins, no splices; local files realpath-confined to `dir`) and compiles from a private mirror of the validated bytes, closing the TOCTOU hole. A shared test-file parser and verdict helper serve both the CLI runner and the new stdlib functions. `test()` is written in Agency on top of `run()`, so parent-handler semantics come free. The eval framework discovers `files/*.test.json` + `holdout/*.test.json`, synthesizes a grading module, and grades through a reject-all Agency wrapper that reports via a file envelope.

**Tech Stack:** TypeScript (vitest), Agency (tests/agency execution tests), zod for schemas, esbuild (existing grader bundling).

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/docs/superpowers/specs/2026-08-20-std-agency-test-design.md` (v4). Read it first; every task cites its sections.

## Global Constraints

- All paths below are relative to `packages/agency-lang/` unless absolute.
- After ANY change to `stdlib/*.agency` or files they import, run `make` (not `pnpm run build` — it skips stdlib/agents). Run `make` once per batch of stdlib edits, not per edit (test-and-build-economy).
- Run ONLY the tests covering your changed files; save output to a file (e.g. `npx vitest run lib/testFormat > /tmp/out.txt 2>&1`); do not re-run to re-read failures.
- Agency execution tests run one at a time: `pnpm run agency test tests/agency/<name>.test.json`. Do NOT run the whole agency suite locally; CI does that.
- No dynamic imports. Objects not Maps. Arrays not Sets. Types not interfaces. One concept per file. No narrating comments.
- Never commit on main. Work on branch `adit/std-agency-test`.
- Commit messages: write to a file, `git commit -F <file>` (apostrophes break `-m`).
- The safety invariant (spec, "The safety invariant and the import policy"): the compile closure may contain only Agency source + `std::`; refuse TS/JS, node builtins, `pkg::` reaching those, and splices — with splice refusal BEFORE any expansion.

---

### Task 1: Closure validator + snapshot

**Files:**
- Create: `lib/compiler/closureValidator.ts`
- Test: `lib/compiler/closureValidator.test.ts`

**Interfaces:**
- Consumes: `parseAgency` (`lib/parser.ts`), `getAllImports` (`lib/analysis/imports.ts`), `importKind`/`isStdlibImport`/`isPkgImport` (`lib/importPaths.ts`), `splicesIn` (exported from `lib/preprocessors/expandSplices.ts` — export it if it is module-private today), `resolveAgencyImportPath` (`lib/importPaths.ts`) for pkg/local resolution.
- Produces (Task 2 depends on these exact shapes):

```ts
export type ClosureSnapshot = {
  /** realpath of the sandbox dir the local files are confined to. */
  rootDir: string;
  /** realpath → validated content. Local files only (see pkgFiles). */
  files: Record<string, { source: string; relPath: string }>;
  /** realpath of the entry file within `files`. */
  entryPath: string;
  /** pkg:: module paths that were validated (read from node_modules). */
  pkgModules: string[];
};

export function validateClosure(args: {
  /** Entry as source text (string form) or a file inside dir (file form). */
  entry: { source: string } | { file: string };
  dir: string;
}): ClosureSnapshot; // throws ClosureValidationError with every violation listed
```

**Rules the validator enforces** (spec: "The safety invariant and the import policy"):
- Walk the raw import graph breadth-first from the entry: parse each file with `parseAgency`, collect `getAllImports`, recurse into `local` and `pkg` imports. Parsing a file that fails to parse is a validation error naming the file.
- Per import, by `importKind`: `stdlib` → allowed, not walked (trusted). `node` → violation ("imports 'fs', which is not Agency source"). `local` → must end in `.agency` (a `./x.ts` classifies as local — refuse non-`.agency` explicitly), resolve against the importing file's directory, then `fs.realpathSync` and require `startsWith(realpath(dir) + sep)` (reuse the containment shape of `resolveInSandbox` in `lib/stdlib/agency.ts:129`; do not import it — it lives in the stdlib layer — replicate the realpath+`sep` check here with a comment naming it). `pkg` → resolve via `resolveAgencyImportPath`, walk the package's `.agency` files under the same no-TS/no-node/no-splice rules with the package root as their confinement boundary; record in `pkgModules`.
- Per file: `splicesIn(ast).length > 0` → violation ("contains a compile-time splice, which sandboxed compilation refuses").
- Collect ALL violations before throwing (match `checkImportPolicy`'s list-every-violation style, `lib/compiler/compile.ts:80`).

- [ ] **Step 1: Write failing tests** in `lib/compiler/closureValidator.test.ts`. Use `fs.mkdtempSync` fixtures. Cases: (a) entry + local import inside dir → snapshot has both files, relPaths right; (b) `../outside.agency` import → error naming file + import; (c) symlink inside dir pointing outside → error (create with `fs.symlinkSync`); (d) `import { x } from "./helper.ts"` → error; (e) `import fs from "fs"` (and `child_process`) → error; (f) a file containing `$( ... )` → splice violation, and the error message lists BOTH a splice violation and an import violation when both exist; (g) string-form entry (`{ source }`) with a relative import resolving inside dir works; (h) string-form entry with no dir-local imports and `dir` empty behaves as std::-only.

```ts
test("import escaping the dir via .. is refused", () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".cv-test-"));
  fs.writeFileSync(path.join(dir, "main.agency"),
    'import { x } from "../outside.agency"\nexport node main() { return x }');
  expect(() => validateClosure({ entry: { file: "main.agency" }, dir }))
    .toThrow(/outside the sandbox dir/);
});
```

- [ ] **Step 2: Run tests, verify they fail** (`npx vitest run lib/compiler/closureValidator.test.ts > /tmp/t1.txt 2>&1`; expect "validateClosure is not defined"-class failures).
- [ ] **Step 3: Implement `validateClosure`** per the rules above. Keep it one concept: validation only, no compilation, no mirror I/O.
- [ ] **Step 4: Run tests, verify pass** (same command).
- [ ] **Step 5: Commit** ("closure validator: pure-Agency import closure with dir confinement").

---

### Task 2: Sandboxed compile from the validated mirror

**Files:**
- Create: `lib/compiler/compileSandboxed.ts`
- Test: `lib/compiler/compileSandboxed.test.ts`

**Interfaces:**
- Consumes: `validateClosure`/`ClosureSnapshot` (Task 1), `compileSource` (`lib/compiler/compile.ts`).
- Produces (Task 3 depends on this):

```ts
export function compileSandboxed(args: {
  entry: { source: string } | { file: string };
  dir: string; // "" = no local imports possible
}): CompileResult; // same CompileResult as compileSource
```

**Mechanics** (spec: "Splice refusal must precede splice execution"):
1. `validateClosure` → snapshot. Any `ClosureValidationError` returns `{ success: false, errors }`.
2. Write every `snapshot.files` entry into a fresh private mirror (`fs.mkdtempSync(path.join(os.tmpdir(), "agency-sandbox-"))`, `fs.mkdirSync(..., { mode: 0o700 })` on the root) preserving `relPath` layout. String-form entries get a synthetic `__entry_<nanoid>.agency` at the mirror root.
3. `compileSource(mirrorEntrySource, { ...config, sourcePath: mirrorEntryPath, imports: { allowKinds: ["stdlib", "local", "pkg"] } })`. The compile reads ONLY mirror files (validated bytes) for local content; the import policy stays on as a belt.
4. `finally`: remove the mirror.

**Boundary to state in a file comment** (spec finding-1 resolution): local files come from the validated mirror, never re-read from the caller's dir — that is the TOCTOU fix. `pkg::` files are re-read from `node_modules` at compile time; that is acceptable because `node_modules` is already-trusted executable content (whoever can write it can write the grading process's own JS), unlike caller-owned directories.

- [ ] **Step 1: Write failing tests.** (a) two-file compile succeeds and `run`s (compile only here — assert `success: true`); (b) **swap-seam test**: validate-then-swap — write `helper.agency` clean, monkeypatch nothing; instead call `validateClosure` yourself, then overwrite the REAL `helper.agency` with a file containing a splice whose generator writes a sentinel (`$( writeSentinel() )` shape from existing splice fixtures — see `tests/` splice fixtures for a working generator form), then hand the pre-built snapshot to the mirror+compile internals (export a `compileFromSnapshot(snapshot)` seam for exactly this test) and assert the sentinel file does NOT exist and the compile used the clean bytes; (c) **splice sentinel test**: entry importing a file whose splice generator writes a sentinel → `success: false` AND no sentinel file exists; (d) dir="" with a relative import → failure.
- [ ] **Step 2: Run, verify failures.**
- [ ] **Step 3: Implement** `compileSandboxed` + exported `compileFromSnapshot(snapshot, config?)` (the seam is the real internal step, not test-only scaffolding: `compileSandboxed = compileFromSnapshot(validateClosure(...))`).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** ("sandboxed compile consumes the validated closure mirror").

---

### Task 3: Wire the stdlib — `compile(source, dir)`, `runCode(..., dir)`, `runFile` local imports

**Files:**
- Modify: `lib/stdlib/agency.ts` (`compileToProgram`, `_compile`, `_compileFile`)
- Modify: `stdlib/agency.agency` (`compile`, `runCode`, `runFile` signatures + docstrings)
- Test: `tests/agency/agency-sandbox-imports.agency` + `tests/agency/agency-sandbox-imports.test.json`

**Interfaces:**
- Consumes: `compileSandboxed` (Task 2).
- Produces: stdlib surface per spec "Functions" + "import policy": `compile(source: string, dir: string = "")`, `runCode(..., cwd, dir: string = "")` (both trailing optional — existing call sites unaffected), `runFile(dir, filename, ...)` now compiles with `dir` as the confinement boundary (local imports work).

- [ ] **Step 1:** In `lib/stdlib/agency.ts`, change `compileToProgram(source)` → `compileToProgram(entry, dir)` calling `compileSandboxed`; `_compile(source, dir = "")`; `_compileFile(dir, filename)` → `compileSandboxed({ entry: { file: filename }, dir })` (keep `resolveInSandbox` for the entry-file read). Note the `{ typechecker: { enabled: true } }` config must still be passed through.
- [ ] **Step 2:** In `stdlib/agency.agency`: add `dir: string = ""` to `compile` and `runCode` (after `cwd`), pass through; update docstrings to say imports may name std::, dir-local `.agency` files, and pkg:: packages with a pure-Agency closure. Update `runFile`'s docstring the same way.
- [ ] **Step 3:** `make` (stdlib changed). Save output.
- [ ] **Step 4: Write the agency execution test** `tests/agency/agency-sandbox-imports.agency`: nodes that (a) write `solution.agency` + `helper.agency` into a scratch subdir (`write(...) with approve`), then `runFile` a node whose module imports the helper → value round-trips; (b) `compile("import { x } from \"./nope.ts\" ...")` → failure mentioning not-Agency-source; (c) `compile` of source importing `child_process` → failure; (d) source containing a splice → failure. Each node returns a string checked by exact criteria in the `.test.json`.
- [ ] **Step 5:** `pnpm run agency test tests/agency/agency-sandbox-imports.test.json > /tmp/t3.txt 2>&1` → pass. Also run the existing neighbors that cover this surface: `tests/agency` files exercising `runCode`/`runFile` (grep for `runCode` under `tests/agency/` and run those files only).
- [ ] **Step 6: Commit** ("stdlib compile/runCode/runFile: dir-confined local imports via sandboxed compile").

---

### Task 4: Shared test-file parser (`lib/testFormat/schema.ts`)

**Files:**
- Create: `lib/testFormat/schema.ts`
- Test: `lib/testFormat/schema.test.ts`

**Interfaces:**
- Consumes: zod (already a dependency).
- Produces (Tasks 6, 8, 10 depend on these):

```ts
export type ParsedTestCase = {
  nodeName: string;
  input: string;                     // raw argument-expression string
  expectedOutput: string;            // raw; verdict layer parses it
  criteria: "exact";                 // sandbox profile; full profile widens
  interrupts: { action: "approve" | "reject"; value?: unknown; expectedMessage?: string }[];
  timeoutMs?: number;
  description?: string;
};
export type ParsedTestFile = {
  sourceFile: string;                // resolved: explicit field, else <basename>.agency
  defaultTimeoutMs?: number;
  description?: string;
  cases: ParsedTestCase[];
};
export function parseTestFileSandbox(jsonText: string, jsonFilename: string): ParsedTestFile; // throws with field-naming errors
export function parseTestFileFull(jsonText: string, jsonFilename: string): FullTestFile;      // full profile: every existing field, validated
```

**Rules** (spec: "The sandbox profile, complete field ledger"): sandbox profile refuses — naming the field — `llmMocks`, `fetchMocks` (both levels), `fakeClock`, `argv`, `retry`, `skip`, `skipOnCI`, `skipReason`, `useTestLLMProvider`, `expectedCompileError`, `llmJudge` criteria, interrupt actions `modify`/`resolve`, `modifiedArgs`. Empty `tests` array is an error. `evaluationCriteria` must be exactly `[{ "type": "exact" }]` in the sandbox profile; the full profile requires at least one criterion of a known type — missing/empty/unknown is an error in BOTH. Full profile carries the complete `TestCase`/`Tests` shape currently typed inline in `lib/cli/test.ts:36-120` (move those field definitions here; `lib/cli/test.ts` will import them in Task 6).

- [ ] **Step 1: Write failing tests**: valid sandbox file parses (mapping incl. `sourceFile` default from `fib-tests.test.json` → `fib-tests.agency`); one test per refused field asserting the error names it; empty `tests`; empty `evaluationCriteria` errors in both profiles; unknown criteria type errors; full profile accepts an existing repo fixture verbatim (read `tests/agency/git.test.json` as a fixture input).
- [ ] **Step 2: Run, verify failures.**
- [ ] **Step 3: Implement** with zod (`z.strictObject` for the sandbox profile so unknown fields fail closed).
- [ ] **Step 4: Run, verify pass. Commit** ("shared .test.json parser, sandbox + full profiles").

---

### Task 5: Shared verdict + input conversion (`lib/testFormat/verdict.ts`, `lib/testFormat/inputArgs.ts`)

**Files:**
- Create: `lib/testFormat/verdict.ts`, `lib/testFormat/inputArgs.ts`
- Test: `lib/testFormat/verdict.test.ts`, `lib/testFormat/inputArgs.test.ts`

**Interfaces:**
- Consumes: `formatDiff` (`lib/utils/diff.ts`), `parseAgency` (`lib/parser.ts`).
- Produces (Tasks 6, 7, 8 depend on these):

```ts
// verdict.ts
export type Verdict = { pass: true } | { pass: false; feedback: string };
/** Structural equality on canonicalized JSON values (key-order insensitive). */
export function exactVerdict(actual: unknown, expectedOutput: string,
  opts: { rawStringFallback: boolean }): Verdict;
// rawStringFallback=true (full profile): unparseable expectedOutput falls back
// to comparing against JSON.stringify(actual) as a raw string — the CLI legacy.
// rawStringFallback=false (sandbox): unparseable expectedOutput THROWS with
// "how to quote a string" guidance.

// inputArgs.ts
export type BoundArgs = Record<string, unknown>;
/** Parse an agency-test `input` string into named args for `node`. */
export function bindInputArgs(input: string, params: ParamInfo[]): BoundArgs;
export type ParamInfo = { name: string; hasDefault: boolean; variadic: boolean };
```

**`bindInputArgs` algorithm** (spec: "The `input` conversion algorithm"): empty → `{}`. Else parse `__probe(${input})` with `parseAgency` and take the call expression's argument list (never eval/Function/string-split). Each argument must be a literal JSON-representable value (string/number/boolean/null, arrays/objects of those) — anything else (identifier, call, interpolation) throws naming the expression. Bind positionally with the language's arity rules: minimum = count of non-default non-variadic params; omitted defaulted params stay ABSENT from the record; extras beyond fixed params require a variadic param and bind to it as an array (the shape `run()`'s named-args calling already accepts — mirror how `AgencyFunction` params mark `variadic` in `lib/stdlib/agency.ts:80`). Violations name the node, the accepted range, and what was given.

- [ ] **Step 1: Write failing tests.** Verdict: `{"a":1,"b":2}` vs `{"b":2,"a":1}` passes; number vs string fails with a diff in feedback; raw fallback on/off behavior. inputArgs: `""`; `10, 5` onto `(a: number, b: number)`; `"alice", "coffee"` onto two strings; defaulted param omitted stays absent; variadic collects extras; identifier arg throws; too many args on non-variadic throws naming range.
- [ ] **Step 2: Run, verify failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, verify pass. Commit** ("shared exact verdict + input argument binding").

---

### Task 6: Migrate the CLI runner onto the shared parser + verdict

**Files:**
- Modify: `lib/cli/test.ts` (types 36-120 → import from `lib/testFormat/schema.ts`; comparison at ~line 674 → `exactVerdict(actual, testCase.expectedOutput, { rawStringFallback: true })`; honor `sourceFile` when present)
- Test: `lib/cli/test.test.ts` (existing; extend)
- Possibly modify: offending fixtures under `tests/**/*.test.json`

**Interfaces:** Consumes Task 4 + 5 exports. Produces no new surface — behavior parity plus strictness.

- [ ] **Step 1: Fixture audit.** Script (scratchpad, throwaway): walk `tests/**/*.test.json` + `evals/**/*.test.json`, run each through `parseTestFileFull`, print failures. Fix offending fixtures (expected classes: empty `evaluationCriteria`, unknown stray fields). Commit fixture fixes separately if any.
- [ ] **Step 2: Write failing test** in `lib/cli/test.test.ts`: an inline fixture with empty `evaluationCriteria` now errors (regression for the accidental-pass); a fixture with explicit `sourceFile` pointing at a differently-named `.agency` runs that file.
- [ ] **Step 3: Migrate** `lib/cli/test.ts`: delete the local `Exact`/`LLMJudge`/`Criteria`/`TestCase`/`Tests` type block in favor of schema imports; parse via `parseTestFileFull`; replace the `actual === testCase.expectedOutput` comparison with `exactVerdict` (keep `formatDiff` output shape for failures); honor `sourceFile`. Keep `llmJudge` execution, mocks, fakeClock etc. untouched — full profile carries them.
- [ ] **Step 4:** `npx vitest run lib/cli/test.test.ts > /tmp/t6.txt 2>&1` → pass. Spot-run two real agency tests through the CLI (e.g. `pnpm run agency test tests/agency/git.test.json`) to prove parity.
- [ ] **Step 5: Commit** ("agency test runs on the shared parser and exact verdict").

---

### Task 7: `test()` in `std::agency`

**Files:**
- Modify: `stdlib/agency.agency` (types + `test`), `lib/stdlib/agency.ts` (verdict/param-info TS seams)
- Test: `tests/agency/agency-test-fn.agency` + `.test.json`

**Interfaces:**
- Consumes: `compile`-via-`runFile` path (Task 3), `run()` (existing), TS seams added here:

```ts
// lib/stdlib/agency.ts additions (exported through agency-lang/stdlib-lib/agency.js)
export function _exactVerdictFeedback(actual: unknown, expectedJson: string): string; // "" = pass; wraps exactVerdict(rawStringFallback:false) rendering
export function _nodeParams(dir: string, filename: string, node: string): ParamInfo[]; // parses the harness file (validated read via resolveInSandbox), finds the exported node, else throws naming it
```

- Produces (Agency surface, spec "API" verbatim):

```ts
export type InterruptAnswer = { action: "approve" | "reject"; value?: any; expectedMessage?: string }
export type TestCase = { node: string; args?: Record<string, any>; expected: any;
  interrupts?: InterruptAnswer[]; wallClock?: number; description?: string }
export type CaseResult = { node: string; pass: boolean; feedback: string }
export type TestReport = { pass: boolean; cases: CaseResult[] }

export def test(dir: string, filename: string, cases: TestCase[],
  wallClock: number = 60s, memory: number = 512mb, ipcPayload: number = 100mb,
  stdout: number = 1mb, maxCost: number | null = null): Result<TestReport>
```

**Execution** (spec "Execution semantics"): compile once via the Task-3 path (`try _compileFile(dir, filename)`; failure → whole-call failure). Wrap the case loop in the same `guard(cost:)` pattern `run()` uses (`stdlib/agency.agency:176-211` is the template; a guard trip returns the `limit_exceeded` failure shape with `limit: "cost"`). Per case, sequentially: build the scripted-answer handler as a named def closing over a mutable index + the case's answers; `handle { run(program, case.node, case.args ?? {}, wallClock: case.wallClock ?? wallClock, ...) } with handler`. Handler logic: `intr.effect == "std::run" && intr.data.moduleId == program.moduleId` → `approve()`; else if answers remain → consume one: `expectedMessage` set and mismatched → record mismatch, `reject("expected interrupt message ...")`; `action == "approve"` → `approve(answer.value)`; else `reject()`; answers exhausted → return nothing (stay silent). After the run: leftover answers → fail ("expected N interrupts, saw M"); run failure → fail with the failure text; else compare `envelope.data` via `_exactVerdictFeedback(value.data, <expected as JSON>)` — since `expected` is already a value in the typed core, serialize it with `JSON.stringify` on the Agency side (`toJSON` builtin) before passing. Failing case appends `pass:false` and CONTINUES.

- [ ] **Step 1:** Add `_exactVerdictFeedback` + `_nodeParams` to `lib/stdlib/agency.ts` with vitest coverage in `lib/stdlib/agency.test.ts` (or the file's existing test home — check for `lib/stdlib/*.test.ts` and follow suit).
- [ ] **Step 2:** Write `test()` + types in `stdlib/agency.agency` per above. `make`.
- [ ] **Step 3: Agency execution test** `tests/agency/agency-test-fn.agency` (no LLM): nodes seed a scratch subdir with `solution.agency` (a pure `fib`-like def + one def that raises `std::write` via `write()`) and `harness.agency` (imports solution, exports `testGood`, `testBad`, `testEffect` nodes). Cases:
  - passing + failing case in one `test()` call → report `pass:false`, `cases[0].pass true`, `cases[1].feedback` non-empty, batch completed;
  - **parent veto**: wrap `test()` in `handle { ... } with (i) { if (i.effect == "std::run") { return approve() } return reject() }` and a case whose node raises `std::write` with a scripted `approve` answer → case FAILS (rejected) — the load-bearing one-vote test;
  - scripted approve with value: harness node calls bare `interrupt("gimme")`, answer `{action:"approve", value:"x"}` → node returns "x";
  - `expectedMessage` mismatch fails the case; leftover answers fail the case; compile failure (solution missing export) → whole-call failure.
- [ ] **Step 4:** `pnpm run agency test tests/agency/agency-test-fn.test.json > /tmp/t7.txt 2>&1` → pass.
- [ ] **Step 5: Commit** ("std::agency test(): sandboxed agency tests with parent-handler vetoes").

---

### Task 8: `testFile()` in `std::agency`

**Files:**
- Modify: `stdlib/agency.agency` (`testFile`), `lib/stdlib/agency.ts` (`_parseTestFileSandbox` seam)
- Test: `tests/agency/agency-testfile.agency` + `.test.json`

**Interfaces:**
- Consumes: `parseTestFileSandbox` (Task 4), `bindInputArgs` + `_nodeParams` (Tasks 5/7), `test()` (Task 7).
- Produces:

```ts
// TS seam: parse + convert in one hop so Agency never handles raw JSON fields.
export function _parseTestFileSandbox(dir: string, filename: string): {
  sourceFile: string; defaultTimeoutMs?: number;
  cases: { node: string; args: Record<string, unknown>; expectedJson: string;
           interrupts: InterruptAnswerWire[]; wallClock?: number; description?: string }[];
}; // resolveInSandbox on the json path; sourceFile resolved relative to dir; bindInputArgs applied per case UP FRONT (spec: bad input = whole-call failure before any case runs)

// Agency:
export def testFile(dir: string, filename: string): Result<TestReport>
// raises std::read for the JSON and for the resolved sourceFile, then delegates:
// test(dir, parsed.sourceFile, cases, wallClock: parsed.defaultTimeoutMs ?? 60s)
```

- [ ] **Step 1:** Implement `_parseTestFileSandbox` with vitest tests (valid file maps; each refused field errors; `input` conversion failures name the case).
- [ ] **Step 2:** Implement `testFile` in `stdlib/agency.agency` — two `interrupt std::read(...)` raises (JSON, then sourceFile) with `{ dir, filename }` payloads, then delegate. `make`.
- [ ] **Step 3: Agency test** `tests/agency/agency-testfile.agency`: seed a dir with solution + harness + a hand-written `.test.json` (multi-case: one passing with `input: "3, 4"` onto a 2-param node, one failing); node calls `testFile(...) with approve` and asserts report shape; a second node feeds a `.test.json` containing `llmMocks` and asserts the failure names the field; a third feeds `expectedOutput: "ok"` (unquoted) and asserts the quoting guidance appears.
- [ ] **Step 4:** Run it; save output; pass.
- [ ] **Step 5: Commit** ("std::agency testFile(): the portable .test.json profile").

---

### Task 9: AgencyTestGrader + wrapper + envelope

**Files:**
- Create: `lib/eval/grading/agencyTestGrader.ts`, `lib/eval/grading/agencyTestWrapper.agency` (shipped asset — check `Makefile`/`package.json` `files` so it lands in dist; follow how `lib/agents/**/*.agency` ships), `lib/eval/grading/reportEnvelope.ts`
- Test: `lib/eval/grading/agencyTestGrader.test.ts`

**Interfaces:**
- Consumes: `BaseGrader`/`Grade`/`GraderInput` (`lib/eval/grading/baseGrader.ts`, exported via `agency-lang/eval`), `testFile` (Task 8, inside the wrapper).
- Produces (Task 10 depends on):

```ts
// reportEnvelope.ts — strict zod schema (spec v4 finding 3)
export type ReportEnvelope =
  | { status: "tested"; report: { pass: boolean; cases: { node: string; pass: boolean; feedback: string }[] } }
  | { status: "could-not-test"; feedback: string };
export function parseReportEnvelope(text: string): ReportEnvelope; // throws on anything else

// agencyTestGrader.ts
export class AgencyTestGrader extends BaseGrader {
  constructor(opts: { harnessAgency: string; harnessJson: string; name: string });
  // externalFiles(): [harnessAgency, harnessJson]; rebindExternalFile per BaseGrader contract
  // score: { kind: "numeric", value: passed/total }; construct with { mustPass: true, threshold: 1 }
}
```

**Wrapper** (`agencyTestWrapper.agency`, spec "What one grading pass does"): takes `dir`, `jsonFilename`, `reportPath` via `std::args`; reject-all handler def — approve `std::run`; approve `std::read` ONLY when `data.filename` is the harness JSON or its sourceFile; reject everything else with "eval sandbox rejected effect \"${intr.effect}\""; `handle { const r = testFile(dir, jsonFilename) } with rejectAll`; then OUTSIDE the handle, build the envelope from `r` (failure → `{ status: "could-not-test", feedback: <one shared formatter: string failures verbatim; limit_exceeded rendered as "cost/wallClock limit exceeded: threshold X, used Y"> }`) and `write(reportPath contents) with approve`.

**Grader `_run`** (mirror the fib grader's mechanics, `evals/agency-agent/fib/graders.ts`): no workdir → fail "run left no workdir". `mkdtempSync` scratch under `process.cwd()`. Copy workdir wholesale with `fs.cpSync(src, dst, { recursive: true })` — default `dereference: false`, add a comment: symlinks copy as links; confinement rejects escapes (spec v4 finding 2). Overwrite harness pair from `this.harnessPath(...)` (snapshot-rebound). Spawn `execFileSync(process.execPath, [process.argv[1], "run", wrapperPath, "--", scratchDir, jsonName, reportPath], { timeout: 10 * 60 * 1000, stdio: "pipe" })` — confirm the wrapper-arg passing form against how `agency run` forwards program args (see `docs/dev/cli-arguments.md`); `reportPath` sits in a second temp dir OUTSIDE scratch. Read + `parseReportEnvelope`; `tested` → numeric passed/total with failing-case feedback lines; `could-not-test` → score 0, feedback verbatim; spawn error / missing / malformed envelope → score 0 with stdout tail (reuse the fib grader's `testOutput` tail-and-strip helper — lift it into `agencyTestGrader.ts`).

- [ ] **Step 1: Write failing vitest tests** (mock at the spawn seam — inject a `runWrapper` function so tests stub the envelope; plus one unmocked test marked to skip on CI if build artifacts are unavailable): envelope parsing (both branches, strict rejection of junk); scoring math (3/4 → 0.75, `passes()` false; 4/4 → 1, passes true); could-not-test → 0 + verbatim feedback; forged-stdout case (stub prints fake envelope JSON to stdout, real report file says fail → score follows the FILE); no-workdir fail; tamper defense (scratch dir's harness bytes = snapshot copy even when workdir contained an edited harness).
- [ ] **Step 2: Run, verify failures. Step 3: Implement grader + envelope + wrapper.** `make` (new shipped .agency).
- [ ] **Step 4: Run, verify pass. Commit** ("AgencyTestGrader: reject-all wrapper, file envelope, tamper defense").

---

### Task 10: Discovery, synthesized module, revision persistence, preflight, holdout seeding

**Files:**
- Modify: `lib/eval/loadInputs.ts` (discover `files/*.test.json` + `holdout/*.test.json` in `applyTestDirectoryDefaults`, `loadInputs.ts:134-151` area; carry them on the `Test` type — add `agencyTests?: { harnessJson: string; harnessAgency: string; holdout: boolean }[]` to `lib/eval/runTypes.ts`)
- Modify: `lib/eval/run/runSuite.ts` (grader decision point: synthesize the module when `agencyTests` present; preflight validations)
- Create: `lib/eval/grading/synthesizeGradersModule.ts`
- Modify: `lib/eval/grading/gradingModule.ts` (new entry point + revision), `lib/runDirectory/annotations.ts` (`GradersIdentity` gains `revision?: { sourceIdentity: string; sha256: string }`, zod at `annotations.ts:172` area), `lib/eval/grading/baseGrader.ts` or the snapshot loader (`loadGradingSnapshot`) to assign the recorded revision
- Modify: seeding path so `holdout/` is NEVER seeded (seeding copies only the test's `files` dir — verify in `lib/eval/run/runAgent.ts` and add the regression test rather than new code if already true)
- Tests: `lib/eval/loadInputs.test.ts`, `lib/eval/grading/synthesizeGradersModule.test.ts`, `lib/eval/grading/gradingModule.test.ts`, `lib/eval/run/runSuite.test.ts` (follow each file's existing test patterns)

**Interfaces:**
- Consumes: `AgencyTestGrader` (Task 9), `parseTestFileSandbox` (Task 4), `snapshotGradingModule`/`loadGradingSnapshot` (`lib/eval/grading/gradingModule.ts`).
- Produces:

```ts
// synthesizeGradersModule.ts
export function synthesizeGradersModule(args: {
  testDir: string;                       // eval test directory
  siblingGradersPath?: string;           // test's own graders.ts, composed first
  pairs: { harnessAgency: string; harnessJson: string; name: string }[]; // sorted by name
}): { moduleSource: string };            // deterministic TS source (fixed template, sorted)

// gradingModule.ts addition
export function snapshotSynthesizedModule(args: {
  physicalPath: string;                  // where moduleSource was written (staging)
  sourceIdentity: string;                // "agency-tests:<suite identity>/<test id>"
  revisionInputs: string[];              // sorted sha256 of each harness pair file
}): GradingSnapshot;                     // revision = `${sourceIdentity}@${sha256(bundleCode + revisionInputs.join(""))}`
```

**Rules** (spec: "Ownership" + v4 finding 1): run row records `graders.revision = { sourceIdentity, sha256 }`; BOTH `loadGradingModule`-live-path (when grading a not-yet-run suite via preflight graders) and `loadGradingSnapshot` assign `${sourceIdentity}@${sha256}` when `revision` is present; absent → existing code-only identity (old dirs readable). Preflight (in `runSuite`, before any agent runs): parse every discovered JSON with the sandbox profile (broken file fails the run up front); refuse basename collisions across `files/` ∪ `holdout/` naming both paths; refuse any `approve` scripted answer ("eval grading rejects all effects; this scripted approval cannot take effect"). Synthesized module template:

```ts
// generated — do not edit
import { AgencyTestGrader } from "agency-lang/eval";
${siblingGradersPath ? `import sibling from ${JSON.stringify(siblingGradersPath)};` : ""}
const discovered = [
  new AgencyTestGrader({ harnessAgency: "...", harnessJson: "...", name: "fib-tests" }),
];
export default [${siblingGradersPath ? "...sibling, " : ""}...discovered];
```

- [ ] **Step 1: Write failing tests**: discovery (a fixture eval-test dir with `files/a.test.json`, `holdout/b.test.json` → `agencyTests` entries, holdout flagged); collision fixture refused naming both; approve-answer fixture refused with the spec message; synthesis determinism (same input twice → identical source); revision: snapshot two staged copies of one suite → equal revisions; edit a harness byte → different; `loadGradingSnapshot` on a directory with `revision` recorded returns annotator `${sourceIdentity}@${sha256}`, and on an old-shape directory returns the legacy identity; **copied run directory**: `fs.cpSync` a run dir elsewhere, grade from snapshot, same revision; holdout seeding: a `runAgent` seeding test asserting `holdout/` contents absent from the staged workdir.
- [ ] **Step 2: Run, verify failures. Step 3: Implement** (discovery → runTypes field → runSuite preflight + synthesis + `snapshotSynthesizedModule` → annotations schema + both loaders).
- [ ] **Step 4: Run the touched test files only, verify pass. Commit** ("eval: discovered agency tests, synthesized grader module, persisted revision").

---

### Task 11: fib migration + docs

**Files:**
- Delete: `evals/agency-agent/fib/graders.ts`
- Rewrite: `evals/agency-agent/fib/files/fib-harness.agency` → `evals/agency-agent/fib/files/fib-tests.agency`, `fib-harness.test.json` → `fib-tests.test.json`
- Create: `evals/agency-agent/fib/holdout/fib-holdout.agency` + `fib-holdout.test.json`
- Modify: `evals/agency-agent/fib/test.json` (input text: self-check command becomes `agency test fib-tests.test.json`)
- Create: `docs/dev/std-agency-test.md`; Modify: `docs/dev/eval-grading.md` (coding-test section), `CLAUDE.md` (two pointers)

**Interfaces:** Consumes everything above; produces the acceptance fixture.

- [ ] **Step 1:** New harness: `import { fib } from "fib.agency"`, one exported node per case (`test0` → `fib(0)` … a few points), no compile/run/handler code. JSON: one case per node, exact criteria, `sourceFile: "fib-tests.agency"`. Holdout: larger n values (e.g. `fib(20) == 6765`), same shape.
- [ ] **Step 2:** Sanity-run the harness the way the agent will: place a known-good `fib.agency` beside copies in a scratch dir, `pnpm run agency test <scratch>/fib-tests.test.json` → green; break fib → red with the diff.
- [ ] **Step 3:** Delete `graders.ts`; run the eval-framework unit tests from Task 10 against the real fib dir as a fixture (discovery finds `fib-tests` + `fib-holdout`; no `graders.ts` composition). Do NOT run the live eval locally (LLM cost); CI covers it.
- [ ] **Step 4:** Write `docs/dev/std-agency-test.md` covering, in plain prose with examples: the contract of `test`/`testFile`; the closure-validator invariant + dir confinement + the mirror/TOCTOU rule + the node_modules boundary; one-vote scripted answers; wrapper/envelope/tamper-defense; holdout; synthesized module + persisted revision; CLI convergence (shared parser/verdict now, execution split by trust posture). Update `docs/dev/eval-grading.md`'s "Coding tests" section to point at the framework surface. Add both to CLAUDE.md's docs list.
- [ ] **Step 5:** Pre-PR: `pnpm run lint:structure`, `pnpm run fmt:ts`, anti-pattern audit of the whole diff (`docs/dev/anti-patterns.md`), repo-wide guards (no raw NUL bytes: check `git diff --numstat` for `- -` binary rows; run `npx vitest run lib/sourceIsText.test.ts`). Commit ("fib eval on framework agency-test grading; dev docs").

---

## Self-review notes (done at write time)

- Spec coverage walked section-by-section: safety invariant/import policy → Tasks 1–3; splice ordering + swap seam → Task 2; API/types → Task 7; parser/verdict/CLI migration + field ledger + input algorithm → Tasks 4–6, 8; execution semantics → Task 7; eval conventions, ownership, revision, envelope, preflight, holdout, symlinks → Tasks 9–10; deletion/migration + docs → Task 11; local-machine chain → covered by Tasks 1–3 (confinement), 7 (veto test), 9 (wrapper), 10 (preflight).
- Known open implementation question the executor may hit: the exact `agency run <wrapper> -- <args>` forwarding form (Task 9) — resolve against `docs/dev/cli-arguments.md` at execution time; the task says so explicitly.
- Types cross-checked: `ClosureSnapshot` (T1→T2), `compileSandboxed` (T2→T3), `ParsedTestFile` (T4→T6/T8), `exactVerdict`/`bindInputArgs` (T5→T6/T7/T8), `_exactVerdictFeedback`/`_nodeParams` (T7→T8), `AgencyTestGrader`/`parseReportEnvelope` (T9→T10), `synthesizeGradersModule`/`snapshotSynthesizedModule` (T10).
