# std::agency `test()` + eval AgencyTestGrader Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (this project does NOT use subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

v2 revises per `2026-08-20-std-agency-test-REVIEW.md`: the closure snapshot
now carries import EDGES and the mirror rewrites them (absolute and
symlink-alias imports cannot escape back to caller files); `testFile` gates
each read BEFORE the TS seam performs it and converts the whole file to
typed cases up front; score kind is `scalar`; the wrapper ships via the
existing `lib/agents/eval` staging and approves reads scratch-wide (fixing
the sourceFile bootstrap); real non-LLM wrapper-transport spawn tests are
mandatory; sibling grader exports are normalized in the generated module;
the suite identity is threaded explicitly into the revision; argument
binding reuses the runtime's positional-packing owner; and the missing
safety tests are added to their owning tasks.

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

---

### Task 1: Closure validator + snapshot

**Files:**
- Create: `lib/compiler/closureValidator.ts`
- Test: `lib/compiler/closureValidator.test.ts`

**Interfaces:**
- Consumes: `parseAgency` (`lib/parser.ts`), `getAllImports` (`lib/analysis/imports.ts`), `importKind`/`isStdlibImport`/`isPkgImport` (`lib/importPaths.ts`), `splicesIn` (exported from `lib/preprocessors/expandSplices.ts` — export it if module-private today), `resolveAgencyImportPath` (`lib/importPaths.ts`) for pkg resolution.
- Produces (Task 2 depends on these exact shapes):

```ts
export type LocalEdge = {
  fromCanonical: string;   // key into files ("<entry>" for a string entry)
  importPath: string;      // the path exactly as written in the source
  toCanonical: string;     // key into files of the resolved target
  /** Byte span of the module-path string literal inside the importing
   *  file's source (from the import statement's AST loc), so the mirror
   *  can splice a rewritten path without touching any other byte. */
  span: { start: number; end: number };
};

export type ClosureSnapshot = {
  /** realpath of dir, or null = no local root: dir was "" and ANY local
   *  import anywhere in the closure is a validation error. Never resolve
   *  "" to cwd. */
  root: string | null;
  /** canonical key → validated content. Local .agency files only.
   *  Keys are fs.realpathSync results, except the string entry, which
   *  uses the literal key "<entry>". relPath is POSIX, relative to root
   *  ("__entry__.agency" for the string entry). */
  files: Record<string, { source: string; relPath: string }>;
  /** Every LOCAL import edge in the closure (absolute, relative, and
   *  symlink-alias forms all included — one edge per import statement). */
  edges: LocalEdge[];
  /** Key into `files` of the entry. */
  entryCanonical: string;
  /** pkg:: module paths that were validated (read from node_modules). */
  pkgModules: string[];
};

export function validateClosure(args: {
  entry: { source: string } | { file: string };  // file is relative to dir
  dir: string;                                    // "" → root: null
}): ClosureSnapshot; // throws ClosureValidationError listing EVERY violation
```

**Rules the validator enforces** (spec: "The safety invariant and the import policy"):
- Walk the raw import graph breadth-first from the entry: parse each file with `parseAgency`, collect `getAllImports`, recurse into `local` and `pkg` imports. A file that fails to parse is a validation error naming the file.
- Per import, by `importKind`: `stdlib` → allowed, not walked (trusted). `node` → violation ("imports 'fs', which is not Agency source"). `local` → must end in `.agency` (a `./x.ts` classifies as local — refuse non-`.agency` explicitly); resolve against the importing file's directory; `fs.realpathSync` the result and require `startsWith(root + path.sep)` (replicate the containment shape of `resolveInSandbox`, `lib/stdlib/agency.ts:129`, with a comment naming it; do not import across the stdlib layer). A symlink whose realpath lands inside `root` is VALID — record the edge with the alias `importPath` and the resolved `toCanonical`. `root === null` → any local import is a violation. `pkg` → resolve via `resolveAgencyImportPath`, walk the package's `.agency` files under the same no-TS/no-node/no-splice rules with the PACKAGE ROOT as their own confinement boundary; record in `pkgModules`.
- Per file: `splicesIn(ast).length > 0` → violation ("contains a compile-time splice, which sandboxed compilation refuses").
- Re-export statements (`export { x } from "./y.agency"`) are import edges too — confirm `getAllImports` surfaces them; if not, walk `exportFrom` nodes explicitly. One test pins this.
- Collect ALL violations before throwing (the list-every-violation style of `checkImportPolicy`, `lib/compiler/compile.ts:80`).

- [ ] **Step 1: Write failing tests** in `lib/compiler/closureValidator.test.ts` with `fs.mkdtempSync` fixtures:
  - (a) entry + relative local import → both in `files`, edge recorded with correct span (assert `source.slice(span.start, span.end)` equals the written path);
  - (b) **absolute import inside dir** (`import { x } from "${dir}/helper.agency"`) → valid, edge recorded;
  - (c) **symlink alias inside dir** (`alias.agency` → `real.agency`, import names the alias) → valid, `toCanonical` is real.agency's realpath;
  - (d) `../outside.agency` → violation; (e) symlink inside dir pointing OUTSIDE → violation;
  - (f) `./helper.ts` → violation; (g) `import fs from "fs"` / `child_process` → violation;
  - (h) splice in an imported file → violation, and both a splice and an import violation are listed when both exist;
  - (i) **re-export edge**: `export { x } from "./y.agency"` where y imports `fs` → violation reached through the re-export;
  - (j) **pkg:: safe closure**: a fake package fixture under a temp `node_modules` (pure-agency files) validates and lands in `pkgModules`; (k) **pkg:: unsafe closure**: the package's agency file imports `child_process` → violation naming the package file;
  - (l) `dir: ""` with any local import → violation; `dir: ""` with only std:: imports → `root: null`, empty `files` except `"<entry>"`.

```ts
test("absolute import inside dir stays valid and is recorded as an edge", () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".cv-abs-"));
  fs.writeFileSync(path.join(dir, "helper.agency"), "export def h(): number { return 7 }");
  fs.writeFileSync(path.join(dir, "main.agency"),
    `import { h } from "${path.join(dir, "helper.agency")}"\nexport node main(): number { return h() }`);
  const snap = validateClosure({ entry: { file: "main.agency" }, dir });
  const edge = snap.edges.find((e) => e.toCanonical.endsWith("helper.agency"));
  expect(edge).toBeDefined();
  expect(snap.files[edge!.toCanonical].relPath).toBe("helper.agency");
});
```

- [ ] **Step 2: Run tests, verify they fail** (`npx vitest run lib/compiler/closureValidator.test.ts > /tmp/t1.txt 2>&1`).
- [ ] **Step 3: Implement `validateClosure`** per the rules. Validation only — no compilation, no mirror I/O.
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** ("closure validator: pure-Agency import closure with dir confinement and edges").

---

### Task 2: Sandboxed compile from the validated mirror

**Files:**
- Create: `lib/compiler/compileSandboxed.ts`
- Test: `lib/compiler/compileSandboxed.test.ts`

**Interfaces:**
- Consumes: `validateClosure`/`ClosureSnapshot`/`LocalEdge` (Task 1), `compileSource` (`lib/compiler/compile.ts`).
- Produces (Task 3 depends on this):

```ts
export function compileSandboxed(args: {
  entry: { source: string } | { file: string };
  dir: string; // "" = no local imports possible
}): CompileResult; // same CompileResult as compileSource

/** The internal step compileSandboxed runs after validation; exported
 *  because the swap-seam test needs to interpose between the two. */
export function compileFromSnapshot(snapshot: ClosureSnapshot): CompileResult;
```

**Mirror materialization** (spec: "Splice refusal must precede splice execution"; review finding 1):
1. `validateClosure` → snapshot. `ClosureValidationError` → `{ success: false, errors }`.
2. Mirror root: `const root = fs.mkdtempSync(path.join(os.tmpdir(), "agency-sandbox-")); fs.chmodSync(root, 0o700);` (`mkdtempSync` creates the directory — chmod after, never a second mkdir).
3. For each `files` entry, compute the mirrored source: start from the validated `source` and, for every edge whose `fromCanonical` is this file, splice the edge's span with the POSIX relative path from this file's `relPath` to the target's `relPath` (`"./" + path.posix.relative(path.posix.dirname(fromRel), toRel)`). Apply splices back-to-front by span start so offsets stay valid. This is the whole fix for absolute and symlink-alias imports: EVERY local import in the mirror names a mirror file, so `compileSource` can never follow a path back into the caller's directory. Only import-path bytes change; everything else is the validated bytes, so line numbers in diagnostics are unaffected (spans never cross lines).
4. Write each mirrored source at `root/relPath` (mkdir -p parents). The `"<entry>"` file lands at `root/__entry__.agency`.
5. `compileSource(mirrorEntrySource, { typechecker: { enabled: true }, sourcePath: <mirror entry path>, imports: { allowKinds: ["stdlib", "local", "pkg"] } })` — the policy stays on as a belt.
6. `finally`: remove the mirror.

**Boundary comment to include** (spec finding-1 resolution): local files come only from the validated mirror. `pkg::` files are re-read from `node_modules`; acceptable because `node_modules` is already-trusted executable content (whoever can write it can write this process's own JS), unlike caller-owned directories.

- [ ] **Step 1: Write failing tests:**
  - (a) two-file relative-import compile → `success: true`;
  - (b) **absolute-inside-dir import compiles from the mirror**: after `validateClosure`, overwrite the caller's `helper.agency` with garbage, then `compileFromSnapshot(snapshot)` → still succeeds (proves no re-read through the absolute path);
  - (c) **symlink-alias import** compiles (alias edge rewritten to the real file's mirrored path);
  - (d) **swap-seam splice test**: validate a clean closure, overwrite the real `helper.agency` with a splice whose generator writes a sentinel (copy a working generator form from the existing splice fixtures under `tests/`), `compileFromSnapshot` → succeeds on clean bytes AND the sentinel does not exist;
  - (e) **splice sentinel test**: entry importing a file that contains a side-effect splice → `compileSandboxed` returns `success: false` AND no sentinel exists;
  - (f) `dir: ""` + relative import → failure from validation.
- [ ] **Step 2: Run, verify failures.**
- [ ] **Step 3: Implement** (`compileSandboxed = compileFromSnapshot(validateClosure(...))` plus the error mapping).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** ("sandboxed compile: mirror with rewritten import edges closes the TOCTOU boundary").

---

### Task 3: Wire the stdlib — `compile(source, dir)`, `runCode(..., dir)`, `runFile` local imports

Unchanged from v1 of this plan except it consumes the Task 2 interface above.

**Files:**
- Modify: `lib/stdlib/agency.ts` (`compileToProgram`, `_compile`, `_compileFile`)
- Modify: `stdlib/agency.agency` (`compile`, `runCode`, `runFile` signatures + docstrings)
- Test: `tests/agency/agency-sandbox-imports.agency` + `tests/agency/agency-sandbox-imports.test.json`

**Interfaces:**
- Consumes: `compileSandboxed` (Task 2).
- Produces: `compile(source: string, dir: string = "")`, `runCode(..., cwd, dir: string = "")` (trailing optional — existing call sites unaffected), `runFile(dir, filename, ...)` compiles with `dir` as the confinement boundary.

- [ ] **Step 1:** `lib/stdlib/agency.ts`: `compileToProgram(entry, dir)` → `compileSandboxed`; `_compile(source, dir = "")`; `_compileFile(dir, filename)` → `compileSandboxed({ entry: { file: filename }, dir })` (keep `resolveInSandbox` for the entry-file existence check).
- [ ] **Step 2:** `stdlib/agency.agency`: add `dir: string = ""` to `compile` and `runCode` (after `cwd`); update the three docstrings: imports may name std::, dir-local `.agency` files, and pkg:: packages with a pure-Agency closure.
- [ ] **Step 3:** `make`. Save output.
- [ ] **Step 4: Agency execution test** `tests/agency/agency-sandbox-imports.agency`: (a) seed a scratch subdir with `solution.agency` + `helper.agency` (`write(...) with approve`), `runFile` a node whose module imports the helper → value round-trips; (b) `compile` of source importing `./nope.ts` → failure naming not-Agency-source; (c) source importing `child_process` → failure; (d) source containing a splice → failure. Exact-match nodes in the `.test.json`.
- [ ] **Step 5:** `pnpm run agency test tests/agency/agency-sandbox-imports.test.json > /tmp/t3.txt 2>&1` → pass. Also run the existing `tests/agency` files exercising `runCode`/`runFile` (grep for them; run only those).
- [ ] **Step 6: Commit** ("stdlib compile/runCode/runFile: dir-confined local imports via sandboxed compile").

---

### Task 4: Shared test-file parser (`lib/testFormat/schema.ts`)

Same as plan v1 with one change (review finding 4): the sandbox profile parses `expectedOutput` to a VALUE at parse time.

**Files:**
- Create: `lib/testFormat/schema.ts`
- Test: `lib/testFormat/schema.test.ts`

**Interfaces (Tasks 6, 8, 10 depend on these):**

```ts
export type ParsedTestCase = {
  nodeName: string;
  input: string;                     // raw argument-expression string (bound in Task 5/8)
  expected: unknown;                 // JSON.parse of expectedOutput — parse errors are
                                     // file-level errors WITH the how-to-quote guidance
  criteria: "exact";
  interrupts: { action: "approve" | "reject"; value?: unknown; expectedMessage?: string }[];
  timeoutMs?: number;
  description?: string;
};
export type ParsedTestFile = {
  sourceFile: string;                // explicit field, else <basename>.agency
  defaultTimeoutMs?: number;
  description?: string;
  cases: ParsedTestCase[];
};
export function parseTestFileSandbox(jsonText: string, jsonFilename: string): ParsedTestFile;
export function parseTestFileFull(jsonText: string, jsonFilename: string): FullTestFile;
// FullTestFile keeps expectedOutput RAW (the full profile has the raw-string
// fallback, so parsing is the verdict layer's job there).
```

Sandbox-profile refusals (spec ledger, each naming the field): `llmMocks`, `fetchMocks` (both levels), `fakeClock`, `argv`, `retry`, `skip`, `skipOnCI`, `skipReason`, `useTestLLMProvider`, `expectedCompileError`, `llmJudge` criteria, actions `modify`/`resolve`, `modifiedArgs`. Empty `tests` is an error. `evaluationCriteria` exactly `[{ "type": "exact" }]` (sandbox) / at least one known criterion (full); missing/empty/unknown errors in BOTH. Full profile carries the complete field set currently typed inline at `lib/cli/test.ts:36-120` (move the definitions here; the CLI imports them in Task 6). Use `z.strictObject` for the sandbox profile.

- [ ] **Step 1: Write failing tests**: valid sandbox file parses (`sourceFile` default; `expected` is the parsed VALUE — `"5"` → `5`, `"\"ok\""` → `"ok"`); unquoted `expectedOutput: "ok"` errors with quoting guidance; one test per refused field; empty `tests`; empty/unknown criteria in both profiles; full profile accepts `tests/agency/git.test.json` verbatim.
- [ ] **Step 2: Run, verify failures. Step 3: Implement. Step 4: Run, verify pass. Commit** ("shared .test.json parser, sandbox + full profiles").

---

### Task 5: Shared verdict + input binding on the runtime's packing owner

**Files:**
- Create: `lib/testFormat/verdict.ts`, `lib/testFormat/inputArgs.ts`
- Modify: `lib/runtime/agencyFunction.ts` (extract the positional-packing rules)
- Test: `lib/testFormat/verdict.test.ts`, `lib/testFormat/inputArgs.test.ts`

**Interfaces:**
- Consumes: `formatDiff` (`lib/utils/diff.ts`), `parseAgency` (`lib/parser.ts`), and the packing owner below.
- Produces (Tasks 6, 7, 8 depend on these):

```ts
// lib/runtime/agencyFunction.ts — extract, do not duplicate (review finding 9):
// pull the body of the private resolvePositional (lib/runtime/agencyFunction.ts:369)
// into an exported pure function the method then calls:
export function bindPositionalArgs(
  params: { name: string; hasDefault: boolean; variadic: boolean }[],
  values: unknown[],
): Record<string, unknown>; // throws on genuine arity violations, naming the
                            // accepted range; omitted defaulted params are ABSENT;
                            // variadic gathers extras into one array param

// verdict.ts
export type Verdict = { pass: true } | { pass: false; feedback: string };
export function exactVerdict(actual: unknown, expectedOutput: string,
  opts: { rawStringFallback: boolean }): Verdict;
// rawStringFallback=true (full/CLI): unparseable expectedOutput falls back to
// comparing JSON.stringify(actual) as a raw string (legacy). false: throws
// with quoting guidance (sandbox callers pre-parse via Task 4 anyway).
export function exactVerdictValue(actual: unknown, expected: unknown): Verdict;
// the sandbox-path form: both sides already values; canonical structural equality.

// inputArgs.ts
export function bindInputArgs(input: string, params: Parameters<typeof bindPositionalArgs>[0]): Record<string, unknown>;
```

**`bindInputArgs`**: empty → `{}`. Else parse `__probe(${input})` with `parseAgency`, take the call's argument list (never eval/Function/string-split); every argument must be a literal JSON-representable value (string/number/boolean/null, arrays/objects of those) — anything else throws naming the expression; then delegate the arity/packing decision to `bindPositionalArgs`. Note in a comment: `paramListSignature` (`lib/typeChecker/checker.ts`) additionally treats schema-injected params as optional — the param lists Task 7's `_nodeParams` produces must mark those `hasDefault: true` so the two owners agree.

- [ ] **Step 1: Write failing tests.** Verdict: key-order-insensitive object pass; mismatch fails with diff feedback; fallback on/off. inputArgs, each compared against a REAL call through `AgencyFunction` with the same param list (the anti-parallel-implementation check): exact `10, 5`; strings; defaulted param omitted → absent; variadic gathers; injection-eligible signature (schema-injected marked optional) accepts the shorter list; identifier arg throws; over-arity throws naming the range. `bindPositionalArgs` extraction: the existing `agencyFunction` tests still pass unchanged.
- [ ] **Step 2: Run, verify failures. Step 3: Implement** (extraction first, then the two new files).
- [ ] **Step 4: Run `lib/testFormat` + `lib/runtime/agencyFunction` tests, verify pass. Commit** ("shared exact verdict; input binding reuses the runtime packing owner").

---

### Task 6: Migrate the CLI runner onto the shared parser + verdict

Unchanged from plan v1 (fixture audit, `parseTestFileFull`, `exactVerdict(..., { rawStringFallback: true })`, honor `sourceFile`, empty-criteria regression, spot-run `tests/agency/git.test.json`). Commit ("agency test runs on the shared parser and exact verdict").

- [ ] Step 1: fixture audit script (scratchpad) over `tests/**/*.test.json` + `evals/**/*.test.json`; fix offenders; commit separately if any.
- [ ] Step 2: failing tests in `lib/cli/test.test.ts` (empty criteria errors; explicit `sourceFile` honored).
- [ ] Step 3: migrate `lib/cli/test.ts` (types → schema imports; comparison at ~line 674 → `exactVerdict`; honor `sourceFile`; `llmJudge`/mocks/fakeClock untouched).
- [ ] Step 4: `npx vitest run lib/cli/test.test.ts > /tmp/t6.txt 2>&1` → pass; spot-run two real agency tests via the CLI.
- [ ] Step 5: Commit.

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
export function _nodeParams(dir: string, filename: string, node: string):
  { name: string; hasDefault: boolean; variadic: boolean }[]; // parses the harness
  // (resolveInSandbox read), finds the exported node, marks schema-injected
  // params hasDefault:true (agreeing with paramListSignature), throws naming
  // a missing node
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

**Execution** (spec "Execution semantics"): compile once via `try _compileFile(dir, filename)` (failure → whole-call failure). Wrap the case loop in `guard(cost:)` exactly as `run()` does (`stdlib/agency.agency:176-211` is the template; a trip returns the `limit_exceeded` shape with `limit: "cost"`). Per case, sequentially: scripted-answer handler as a def closing over a mutable index; `handle { run(program, case.node, case.args ?? {}, wallClock: case.wallClock ?? wallClock, ...) } with handler`. Handler: `intr.effect == "std::run" && intr.data.moduleId == program.moduleId` → `approve()`; else if answers remain → consume: `expectedMessage` mismatch → record + `reject(...)`; `approve` → `approve(answer.value)`; `reject` → `reject()`; exhausted → stay silent (propagates outward). Post-run: leftover answers → fail ("expected N interrupts, saw M"); run failure → fail with its text; else `_exactVerdictFeedback(envelope.data, case.expected)`. Failing case appends and CONTINUES.

- [ ] **Step 1:** TS seams + vitest coverage (follow the existing test home for `lib/stdlib` helpers).
- [ ] **Step 2:** `test()` + types in `stdlib/agency.agency`. `make`.
- [ ] **Step 3: Agency execution test** `tests/agency/agency-test-fn.agency` (no LLM). Fixture: scratch subdir with `solution.agency` (pure def; a def that raises `std::write` via `write()`; a def that raises a bare `interrupt("gimme")`; a def that loops forever) + `harness.agency` importing it. Cases to pin (review finding 10 additions marked •):
  - passing + failing in one call → `pass:false`, first case passes, second has feedback, batch completed;
  - **parent veto** (load-bearing): reject-all-but-`std::run` parent + a scripted `approve` on a `std::write` case → case FAILS;
  - scripted approve with value round-trips;
  - • scripted `reject` answer → case fails with the rejection, batch continues;
  - `expectedMessage` mismatch fails the case; leftover answers fail the case;
  - • exhausted answers propagate: an OUTER handler sees the interrupt and rejects it — assert the outer handler ran (set a flag var);
  - • per-case timeout: the infinite-loop def with `wallClock: 500` fails with `limit_exceeded` feedback and the NEXT case still runs;
  - compile failure (missing export) → whole-call failure.
- [ ] **Step 4:** `pnpm run agency test tests/agency/agency-test-fn.test.json > /tmp/t7.txt 2>&1` → pass.
- [ ] **Step 5: Commit** ("std::agency test(): sandboxed agency tests with parent-handler vetoes").

---

### Task 8: `testFile()` — gates BEFORE reads, whole-file conversion up front

**Files:**
- Modify: `stdlib/agency.agency` (`testFile`), `lib/stdlib/agency.ts` (seams)
- Test: `tests/agency/agency-testfile.agency` + `.test.json`

**Interfaces:**
- Consumes: `parseTestFileSandbox` (Task 4), `bindInputArgs` (Task 5), `_nodeParams` (Task 7), `test()` (Task 7).
- Produces:

```ts
// TS seams — each performs its read ONLY when called, so the Agency layer
// can gate first (review finding 2):
export function _readTestFileSandbox(dir: string, filename: string):
  ParsedTestFileWire; // resolveInSandbox → readFileSync → parseTestFileSandbox;
                      // returns { sourceFile, defaultTimeoutMs, rawCases }
export function _bindTestFileCases(dir: string, sourceFile: string,
  rawCases: ParsedTestFileWire["rawCases"]): BoundCaseWire[];
  // reads/parses the harness ONCE (_nodeParams per referenced node), binds
  // EVERY case's input and carries the already-parsed `expected` value;
  // any bad case throws here — before any case runs (spec: whole-call failure)
```

```ts
// Agency — the exact sequence, gate before read, mirroring typecheckFile's
// gate-then-helper idiom (stdlib/agency.agency:483-487):
export def testFile(dir: string, filename: string): Result<TestReport> {
  return interrupt std::read("Read this test file?", { dir: dir, filename: filename })
  const parsed = try _readTestFileSandbox(dir, filename)
  if (parsed is failure) { return parsed }
  return interrupt std::read("Read the tested source file?", { dir: dir, filename: parsed.value.sourceFile })
  const bound = try _bindTestFileCases(dir, parsed.value.sourceFile, parsed.value.rawCases)
  if (bound is failure) { return bound }
  return test(dir, parsed.value.sourceFile, <bound cases>, wallClock: parsed.value.defaultTimeoutMs ?? 60s)
}
```

(`return interrupt ...` then continuing is the stdlib's gate idiom — the interrupt must be approved for execution to continue past it, exactly as `typecheckFile` does. The JSON is not read until after gate 1; the harness not until after gate 2; `test()`'s own `_compileFile` read happens after gate 2 as well.)

- [ ] **Step 1:** Implement + vitest the TS seams (valid file maps with parsed `expected` values; each refused field errors; a non-literal `input` names the case).
- [ ] **Step 2:** `testFile` in `stdlib/agency.agency`. `make`.
- [ ] **Step 3: Agency test** `tests/agency/agency-testfile.agency`:
  - multi-case file (one passing with `input: "3, 4"` onto a 2-param node, one failing) → report shape checked;
  - a file with `llmMocks` → failure naming the field; unquoted `expectedOutput` → quoting guidance;
  - • **gate-order test** (review finding 2): parent handler REJECTS the first `std::read`, and the JSON on disk is intentionally MALFORMED → the result is the read rejection, NOT a parse error (proves the file was never read);
  - • **all-up-front test** (review finding 4): file with a valid first case and a malformed second (`expectedOutput` unquoted string) → whole-call failure, and the harness node of case 1 never ran (case-1 node bumps a counter file? No — effects are rejected; instead have case 1's node return a value and assert the failure carries NO TestReport, i.e. `result is failure`).
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
export type ReportEnvelope =
  | { status: "tested"; report: { pass: boolean; cases: { node: string; pass: boolean; feedback: string }[] } }
  | { status: "could-not-test"; feedback: string };
export function parseReportEnvelope(text: string): ReportEnvelope;

// agencyTestGrader.ts
export class AgencyTestGrader extends BaseGrader {
  constructor(opts: { harnessAgency: string; harnessJson: string; name: string });
  // externalFiles(): [harnessAgency, harnessJson]; rebindExternalFile per contract
  // score: { kind: "scalar", value: passed/total }  ← "scalar", NOT "numeric"
  //   (lib/eval/grading/types.ts:26 — the only kinds are binary|scalar);
  // constructed with { mustPass: true, threshold: 1 }
}
```

**Wrapper** (`agencyTestWrapper.agency`): reads `scratchDir`, `jsonFilename`, `reportPath` from `std::args` (the CLI forwards trailing args to program argv — `lib/cli/commands.ts:274-277`; spawn form below is final, not an open question). Handler (fixes the sourceFile bootstrap, review finding 2): approve `std::run`; approve `std::read` when `intr.data.dir`, realpath-resolved, is inside `scratchDir` (the scratch dir holds only the workdir copy + snapshot harness — reading agent-written inputs leaks nothing the grader does not already hold); reject everything else naming the effect. Body: `handle { const r = testFile(scratchDir, jsonFilename) } with rejectAllPolicy`, then OUTSIDE the handle build the envelope (failure → `could-not-test` with one shared formatter: string failures verbatim; `limit_exceeded` rendered "cost/wallClock limit exceeded: threshold X, used Y") and `write(reportPath ...) with approve`.

**Grader `_run`** (mechanics mirror `evals/agency-agent/fib/graders.ts`): no workdir → fail "run left no workdir". Scratch via `mkdtempSync` under `process.cwd()`. `fs.cpSync(workdir, scratch, { recursive: true })` — default `dereference: false`; comment: symlinks copy as links; confinement rejects escapes (spec v4 finding 2). Overwrite harness pair from `this.harnessPath(...)` (snapshot-rebound). Spawn:

```ts
execFileSync(process.execPath,
  [process.argv[1], "run", wrapperPath, scratchDir, jsonName, reportPath],
  { stdio: "pipe", timeout: 10 * 60 * 1000 });
```

`reportPath` in a second temp dir OUTSIDE scratch. Read → `parseReportEnvelope` → `tested`: scalar passed/total + failing-case feedback lines; `could-not-test`: score 0, feedback verbatim; spawn error / missing / malformed envelope: score 0 with the stdout tail (lift the fib grader's `testOutput` strip-and-tail helper into this file).

- [ ] **Step 1: Unit tests** (inject a `runWrapper: (args) => void` seam so these stub the envelope file): envelope strict parsing (both branches; junk rejected); scoring math (3/4 → `{ kind: "scalar", value: 0.75 }`, `passes()` false; 4/4 → passes); could-not-test → 0 + verbatim; missing/malformed envelope → 0 + stdout tail; no-workdir; tamper defense (scratch harness bytes = snapshot copy despite an edited workdir harness).
- [ ] **Step 2: Spawn tests** (`agencyTestGrader.spawn.test.ts`, real CLI, no LLM, NOT skipped in CI — review finding 6):
  - `tested` both ways: green harness → 1.0; red case → fraction + diff feedback in the failing line;
  - `could-not-test`, string failure: solution that does not compile → score 0, compile error text in feedback, THROUGH the wrapper file (not stdout);
  - `could-not-test`, malformed test JSON → score 0 naming the field;
  - `could-not-test`, structured limit: a case whose node loops forever + tiny `defaultTimeoutMs` → the wallClock `limit_exceeded` rendered by the shared formatter;
  - **forged stdout**: a harness node that `print`s a fake `{"status":"tested",...}` envelope — score follows the report FILE, not stdout;
  - **safety**: a harness node whose solution call raises `std::write` → rejected by the wrapper, case fails, nothing written.
- [ ] **Step 3: Implement** grader + envelope + wrapper. `make` (new agent-dir .agency).
- [ ] **Step 4:** Run both test files, save output, pass. **Step 5: Commit** ("AgencyTestGrader: shipped reject-all wrapper, strict file envelope, real transport tests").

---

### Task 10: Discovery, synthesized module, revision persistence, preflight, holdout

**Files:**
- Modify: `lib/eval/loadInputs.ts` (discover `files/*.test.json` + `holdout/*.test.json` in `applyTestDirectoryDefaults`, `loadInputs.ts:134-151` area), `lib/eval/runTypes.ts` (`Test` gains `agencyTests?: { harnessJson: string; harnessAgency: string; name: string; holdout: boolean }[]`)
- Modify: `lib/eval/run/runSuite.ts` (`snapshotGraders` at `runSuite.ts:253` — synthesis + preflight; it already receives the tests and config; ADD the `opts.suite` identity parameter — review finding 8)
- Create: `lib/eval/grading/synthesizeGradersModule.ts`
- Modify: `lib/eval/grading/gradingModule.ts` (`snapshotSynthesizedModule`; `GradingSnapshot` gains `revision`), `lib/runDirectory/annotations.ts` (`GradersIdentity` + zod at `annotations.ts:172` gain `revision?: { sourceIdentity: string; sha256: string }`), the snapshot loader (`loadGradingSnapshot`) and the live load path assign `${sourceIdentity}@${sha256}` when present
- Verify (add regression test, code change only if needed): seeding copies only the test's `files` dir, so `holdout/` is never seeded (`lib/eval/run/runAgent.ts`)
- Tests: `lib/eval/loadInputs.test.ts`, `lib/eval/grading/synthesizeGradersModule.test.ts`, `lib/eval/grading/gradingModule.test.ts`, `lib/eval/run/runSuite.test.ts` (follow each file's existing patterns)

**Interfaces:**

```ts
// synthesizeGradersModule.ts — deterministic: fixed template, pairs sorted by name
export function synthesizeGradersModule(args: {
  siblingGradersPath?: string;
  pairs: { harnessAgency: string; harnessJson: string; name: string }[];
}): { moduleSource: string };

// generated shape — sibling normalized (review finding 7: importBundle
// normalizes at load, gradingModule.ts:148, but this spread runs before that):
//   import { AgencyTestGrader } from "agency-lang/eval";
//   import sibling from "<siblingGradersPath>";            // when present
//   const siblingList = Array.isArray(sibling) ? sibling : [sibling];
//   export default [...siblingList,
//     new AgencyTestGrader({ harnessAgency: "...", harnessJson: "...", name: "fib-tests" }),
//   ];

// gradingModule.ts
export function snapshotSynthesizedModule(args: {
  physicalPath: string;      // staging location of moduleSource
  sourceIdentity: string;
  revisionInputs: string[];  // sorted sha256 of each harness pair file
}): GradingSnapshot;         // .revision = { sourceIdentity,
                             //   sha256: sha256(bundleCode + revisionInputs.join("")) }
```

**Suite-identity flow** (review finding 8, explicit): `runSuite` already holds `opts.suite: SuiteIdentity | undefined` (`runSuite.ts:58`); pass it into `snapshotGraders`, which computes per test `sourceIdentity = "agency-tests:" + (suiteIdentityString(opts.suite) ?? "inline:--input") + "/" + test.id` (reuse however the run row currently stringifies `suite` — find the field written on the `run` annotation and use the same rendering, so revision and run row agree). `GradingSnapshot.revision` flows into the run row's `graders.revision` at the same place `graders` is recorded today (the `recordCompletedRun` fold in `runSuite`).

**Preflight** (before any agent runs, in `snapshotGraders`): parse every discovered JSON with the sandbox profile (broken file fails the run naming it); refuse basename collisions across `files/` ∪ `holdout/` naming both paths; refuse any `approve` scripted answer ("eval grading rejects all effects; this scripted approval cannot take effect").

- [ ] **Step 1: Write failing tests:**
  - discovery fixture (`files/a.test.json`, `holdout/b.test.json`) → two `agencyTests` entries, holdout flagged; no `.test.json` anywhere → field absent (goal-judge path untouched);
  - collision refused naming both paths; approve-answer refused with the spec message; malformed JSON refused at preflight;
  - synthesis determinism (same input twice → byte-identical source); composition: sibling exporting an ARRAY and sibling exporting a SINGLE grader both compose (load the generated module through `importBundle`); duplicate names between sibling and discovered rely on the existing load-time refusal — pin it;
  - revision: two staged runs of one suite → equal revisions; edit one harness byte → different; `loadGradingSnapshot` with `revision` recorded → annotator `${sourceIdentity}@${sha256}`; old-shape directory (no `revision`) → legacy identity; **copied run directory** (`fs.cpSync` elsewhere, fresh load, grade) → same revision;
  - holdout seeding: `runAgent` seeding test asserting `holdout/` contents absent from the staged workdir;
  - • **end-to-end symlink sentinel** (review finding 10 / spec v4 finding 2): a workdir containing `solution.agency` importing `link.agency` which is a symlink to an external sentinel file — grade it through the REAL grader path (reuse the Task 9 spawn harness): the sentinel's content is neither copied into scratch nor compiled, and the case fails with the confinement error.
- [ ] **Step 2: Run, verify failures. Step 3: Implement** (discovery → runTypes → preflight + synthesis + `snapshotSynthesizedModule` → annotations schema + both loaders → suite-identity threading).
- [ ] **Step 4: Run only the touched test files, verify pass. Commit** ("eval: discovered agency tests, synthesized grader module, persisted revision").

---

### Task 11: fib migration + docs

Unchanged from plan v1.

- [ ] Step 1: `evals/agency-agent/fib/files/fib-tests.agency` (imports `fib.agency`, one exported node per case) + `fib-tests.test.json` (`sourceFile` explicit); `holdout/fib-holdout.agency` + `.test.json` (larger n, e.g. `fib(20) == 6765`); update `fib/test.json` input text (self-check command `agency test fib-tests.test.json`); delete `graders.ts` and the old harness pair.
- [ ] Step 2: sanity-run the visible harness against a known-good `fib.agency` in a scratch dir via `pnpm run agency test` → green; break fib → red with diff.
- [ ] Step 3: run the Task-10 discovery tests against the real fib dir as a fixture. Do NOT run the live eval locally; CI covers it.
- [ ] Step 4: `docs/dev/std-agency-test.md` (contract; validator invariant + confinement + mirror/TOCTOU + node_modules boundary; one-vote answers; gate-before-read sequence; wrapper/envelope/tamper defense; scratch-wide read approval and why; holdout; synthesized module + persisted revision; CLI convergence). Update `docs/dev/eval-grading.md` coding-test section. CLAUDE.md pointers.
- [ ] Step 5: Pre-PR: `pnpm run lint:structure`, `pnpm run fmt:ts`, anti-pattern audit of the full diff, repo-wide guards (`git diff --numstat` binary check; `npx vitest run lib/sourceIsText.test.ts`). Commit ("fib eval on framework agency-test grading; dev docs").

---

## Self-review notes (v2)

- Every review finding has a home: F1 → Tasks 1–2 (edges, rewrite, absolute/alias/swap tests, chmod fix, `root: null`); F2 → Task 8 sequence + gate-order test, Task 9 scratch-wide read approval; F3 → Task 9 `scalar`; F4 → Task 4 parses `expected`, Task 8 `_bindTestFileCases` up front + all-up-front test; F5 → wrapper under `lib/agents/eval/` (already in `AGENT_DIRS`), `getAgentsDir()` resolution; F6 → mandatory spawn tests incl. structured wallClock limit + forged stdout, spawn form fixed now; F7 → normalized sibling + both-shapes tests; F8 → `opts.suite` threading + `GradingSnapshot.revision` + run-row recording named; F9 → `bindPositionalArgs` extraction + real-call comparison tests; F10 → the •-marked additions in Tasks 1, 7, 8, 10.
- Types cross-checked across tasks: `ClosureSnapshot`/`LocalEdge` (T1→T2), `compileSandboxed`/`compileFromSnapshot` (T2→T3), `ParsedTestFile.expected: unknown` (T4→T8), `bindPositionalArgs`/`exactVerdictValue` (T5→T6/T7/T8), `_exactVerdictFeedback(actual, expected)` now takes values on both sides (T7→T8), `AgencyTestGrader`/`parseReportEnvelope` (T9→T10), `synthesizeGradersModule`/`snapshotSynthesizedModule` (T10).
- Remaining known unknowns are named in-place with a resolution rule (e.g. whether `getAllImports` surfaces re-export edges — Task 1 pins it with a test either way; how the run row stringifies `suite` — Task 10 says reuse that exact rendering).
