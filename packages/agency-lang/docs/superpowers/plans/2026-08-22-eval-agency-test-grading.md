# Eval grading of Agency coding tests: implementation plan (v2)

Post-review (PR #882) the implementation departs from Tasks 1–3 in three
ways: the env carriers have one owner, `withRootCarriers` in
`lib/cli/childEnv.ts`, used by `run`, `agent`, and the test runner (no
`testChildEnv.ts`); `--agency-only` writes sibling `.js` files like a normal
compile (`compileAgencyOnly` in `lib/compiler/compileSandboxed.ts`, no temp
directory, no `agencyOnlyCompile.ts`); and the runner returns the report
only, with counts, the failed-file list, and timings derived from it.

v2 addresses the review in
`docs/superpowers/plans/2026-08-22-eval-agency-test-grading-REVIEW.md`:
Task 3 now changes the per-case outcome contract and routes every line of
human output through one sink; Task 1 clears and sets the budget keys the
way `agency run` does, as strings; the `revision` removal lives in Task 9
only; Task 6 names its combined snapshot type and uses the existing
`<sha256><ext>` file naming; Task 8 has no live-grading placeholder.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (this project does NOT use subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-22-eval-agency-test-grading-design.md`. Read it first; every task names its section.

**Branch:** `adit/split-4-eval-grader` (PR #880, based on `main`). The branch currently carries the wrapper-based grader. This plan rewrites it in place: the first tasks add the `agency test` flags (which stand on their own), the middle tasks rebuild the grader on them, the last tasks delete what the old design needed.

**Goal:** `agency test` (and `agency run`) can run with a caller-chosen root interrupt policy and a pure-Agency import closure, and `agency test` can print machine-readable output; the eval framework grades a coding test by running `agency test --json --agency-only --reject '*'` against the agent's workdir with the framework's copy of each harness pair, and keeps those pairs in the run directory as plain files.

## Global constraints

- One concept per file. No module-level per-run state. Objects not maps, arrays not sets, types not interfaces. No dynamic imports.
- Every safety test needs a positive control (the same input passes without the flag) and a specific diagnostic to match, so the test cannot pass by accident.
- Save every test run's output to a file under the scratchpad and read it from there. Run only the suites that cover changed files. Never run the whole agency execution suite locally.
- `make` only after a change to `stdlib/**`, `lib/agents/**`, or templates. After TypeScript-only changes, `npx tsc --noEmit -p .` and vitest are enough.
- Deleting a directory in tests goes through `safeDeleteDirectoryWithin`, never a hand-rolled `rmSync` on a computed path.
- **Symlinks: do not write code to support them.** If a step would need link-aware logic (copying links, resolving them, protecting against them), choose the rule that makes links irrelevant instead (skip them, refuse them) and say so in a comment.
- No force pushes, no amends, no commits on `main`.

## Sequencing

Tasks 1–4 change `agency test` only and are independently useful. Task 5 is the harness profile. Tasks 6–8 are the run directory and grader. Tasks 9–10 remove the old design and update docs. Task 11 is verification and the PR.

---

## Task 1: `--policy`, `--approve`, `--reject`, `--max-cost`, `--max-time` on `agency test` (spec Part 1, "--policy")

**Files:**
- `scripts/agency.ts` (the `test` command definition, around line 1140)
- `lib/cli/test.ts` (`test()`, `runTestFile`, `runSingleTest`)
- `lib/cli/testChildEnv.ts` (new, one concept: the environment a test case's child gets)
- `lib/cli/util.ts` (`runAgencyNode` / `executeNodeAsync`)
- `lib/cli/testChildEnv.test.ts`

Background: `agency run` resolves `--policy/--approve/--reject` with `resolveRunPolicy` (`lib/cli/runPolicy.ts`) and `--max-cost/--max-time` with `resolveBudget` (`lib/cli/budget.ts`, which returns **strings**: dollars as a number string, time already converted to milliseconds). It then builds the child's environment with a clear-then-set rule for all four variables (`lib/cli/commands.ts:304-321`): delete `AGENCY_RUN_POLICY`, `AGENCY_RUN_POLICY_INTERACTIVE`, `AGENCY_MAX_COST`, `AGENCY_MAX_TIME`, then set the ones this invocation resolved. The runtime installs the handler and the budget from those variables in `runNode` (`lib/runtime/node.ts:201-202`). The test runner spawns each case through `runAgencyNode`, which merges an `env` object over `process.env`; it has no way to *delete* a key today. `--reject '*'` is already reject-all because the policy's wildcard key is `"*"`; no built-in policy is added.

- [ ] `TestRunOptions` in `lib/cli/test.ts`: `{ policy?: ResolvedRunPolicy; budget?: { maxCost?: string; maxTime?: string }; agencyOnly?: boolean; json?: boolean }`. `budget` is exactly `resolveBudget`'s return, so the conversion boundary is the CLI flag parser and nothing downstream re-parses. Thread it from `test()` to `runTestFile` to `runSingleTest` as one object (no new positional parameters).
- [ ] New `lib/cli/testChildEnv.ts`: `testChildEnv(options): { set: Record<string, string>; unset: string[] }`. `unset` is always the four keys (`AGENCY_RUN_POLICY`, `AGENCY_RUN_POLICY_INTERACTIVE`, `AGENCY_MAX_COST`, `AGENCY_MAX_TIME`), with the comment from `commands.ts` ("an internal carrier from THIS run's flags to the child, never a knob a parent shell can set"). `set` holds `AGENCY_RUN_POLICY` from `options.policy.policyJson` and the two budget strings when present. Pure function, no I/O.
- [ ] `runAgencyNode` gains `unsetEnv?: string[]` beside `env`: the child environment is `process.env` minus `unsetEnv`, plus `env`. `executeNodeAsync` passes it through. No other caller changes.
- [ ] `scripts/agency.ts`: add `--policy <name|path>`, `--approve <effects>`, `--reject <effects>`, `--max-cost <dollars>`, `--max-time <duration>` to the `test` command, resolved with `resolveRunPolicy` and `resolveBudget` exactly as the `run` command does (reuse its option descriptions).
- [ ] Unit tests (`testChildEnv.test.ts`): no flags → `unset` has the four keys and `set` is empty (the no-budget, no-policy inheritance case the review raised); `--reject '*'` → `set.AGENCY_RUN_POLICY` parses to a policy whose `"*"` rule is `reject`; a budget `{ maxCost: "5", maxTime: "60000" }` maps to the two env names unchanged. Plus one test of `runAgencyNode`'s env assembly: a key present in `process.env` and listed in `unsetEnv` is absent from the spawned env (stub the spawn; assert on the env it receives).
- [ ] Agency-js test `tests/agency-js/test-cli-policy/`: a tested node does `write("x.txt", "hi", ".") with approve` and returns whether the write succeeded. Positive control: `agency test` without a policy writes the file and the case expecting `"written"` passes. With `--reject '*'`: the file is not written and the case fails with feedback containing the reject. Both in one `test.js`. Check `docs/misc/TESTING.md` for the agency-js layout.
- [ ] Commit: "agency test --policy/--approve/--reject/--max-cost/--max-time: the run's root handler and budget, in the test runner".

## Task 2: `--agency-only` on `agency test` and `agency run` (spec Part 1, "--agency-only")

**Files:**
- `lib/cli/test.ts` (`runTestFile`: the compile step; `runSingleTest`: where the compiled path is chosen)
- `lib/cli/util.ts` (`runAgencyNode` needs to accept an already-materialized compiled entry)
- `lib/cli/agencyOnlyCompile.ts` (new, one concept: validated compile of one test source into a scratch layout)
- `lib/cli/agencyOnlyCompile.test.ts`

Background: `runAgencyNode` picks `compiledPath` from `distDir`, a sibling `.js` (`preferCompiled`), or a fresh `compile()`. The sandboxed compile (`compileSandboxed`, #878) returns `{ code, modules?, entryPath? }` and the runtime already knows how to lay that out on disk (`materializeCompiledScript` in `lib/runtime/ipc.ts`, which writes under the package's `.agency-tmp/<id>/` and returns the entry script path). That function is reused as is.

- [ ] New `lib/cli/agencyOnlyCompile.ts`: `compileAgencyOnly(sourceFile): { ok: true; scriptPath: string } | { ok: false; errors: string[] }`. Calls `compileSandboxed({ entry: { file: basename(sourceFile) }, dir: dirname(sourceFile) })`; on success calls `materializeCompiledScript(result)` and returns the script path. No `process.exit`, no throw on refusal.
- [ ] `runAgencyNode` gains an optional `compiledPath?: string` argument that short-circuits the three existing branches. Keep the branches' order and comments intact; the new argument is checked first and documented as "the caller already compiled this file".
- [ ] `runTestFile`: under `options.agencyOnly`, call `compileAgencyOnly` once per file before the cases loop. On `ok: false`, log the errors, mark every case failed with that text as feedback, record the file in `failedFiles`, and return; do not `process.exit`. On success pass `scriptPath` as `compiledPath` to every case. Skip the precompile pass for these files (`test()` already groups files for precompile; exclude them when `agencyOnly` is set).
- [ ] Cleanup: the materialized directory is deleted after the file's cases finish, through `safeDeleteDirectoryWithin(<.agency-tmp>, <dir>)`. Never derive the directory by path arithmetic; `materializeCompiledScript` returns the script path and the per-run dir is its parent only for single-file programs, so have `compileAgencyOnly` also return the run directory it created (the first segment under `.agency-tmp`, the same rule the runtime's own cleanup in `ipc.ts` uses; expose that rule as a named, exported helper rather than copying it — it became `removeCompiledScriptDir`).
- [ ] Unit tests: a source importing a sibling `.agency` compiles and the script exists at the returned path; a source importing `fs` returns `ok: false` with "not Agency source" in the errors and no script; a source in `sub/` importing `./helper.agency` gets a script under `sub/` (nested entry, the #878 fix).
- [ ] `agency run --agency-only`: in `lib/cli/commands.ts` `runCommand`, when the flag is set, replace the `compile(...)` call (line 282) with `compileAgencyOnly(inputFile)`; on `ok: false` print the errors and exit 1 (a refusal IS the run's failure here; `run` already exits 1 on a compile error). Add the flag in `scripts/agency.ts` next to `--policy`. Agency-js test: `agency run --agency-only bad.agency` (imports `fs`) exits 1 with "Sandboxed compilation refused"; `agency run --agency-only --reject '*' writes.agency` exits 0 and the file it tried to write does not exist; positive control: without the flags the file exists.
- [ ] Agency-js test `tests/agency-js/test-cli-agency-only/`: the same fixture directory holds `good.agency` (std:: only) and `bad.agency` (imports `fs`). Positive control: `agency test bad.test.json` without the flag compiles and runs. With `--agency-only`: `good` passes, `bad` fails with "Sandboxed compilation refused" in the output and the exit code is 1, and the process did not exit before printing the summary line for `good` (proves no `process.exit` on the refusal).
- [ ] Commit: "agency test --agency-only: validated closure compile, refusals are file failures".

## Task 3: `--json` (spec Part 1, "--json")

**Files:**
- `lib/cli/testReport.ts` (new: the JSON document type, its zod schema, totals)
- `lib/cli/testOutput.ts` (new: the one sink every human line of the test command goes through)
- `lib/cli/test.ts` (outcome contract, sink threading, precompile quiet)
- `scripts/agency.ts` (`--json` flag; the action's summary and slow-test printing go through the sink)
- `lib/cli/testReport.test.ts`, `lib/cli/testOutput.test.ts`, `lib/cli/test.test.ts`

Background, and why this task is bigger than "print JSON at the end": today `runSingleTest` returns only `"passed" | "failed" | "aborted"` and the failure text (the exact-match diff, the judge verdict, the execution error, the interrupt mismatch) exists only as `log(...)` calls, so there is nothing to put in a case's `feedback`. And stdout is written from more places than the buffered logger: `test()` prints the shard line and the suite-abort summary with `console.log` (`lib/cli/test.ts:1027-1039, 1058`), the precompile pass prints unless called with `{ quiet: true }` (`lib/cli/precompile.ts:117`), and the command action in `scripts/agency.ts` prints the file/test totals and the slowest-tests table with `console.log` (`1205-1215`, `printSlowestTests`). One JSON document on stdout means every one of those goes elsewhere under `--json`.

**Outcome contract.**
- [ ] Replace `SingleTestOutcome` with `CaseOutcome = { status: "passed" | "failed" | "aborted"; feedback?: string; durationMs: number }`. `runSingleTest` builds `feedback` from the same strings it logs today (keep logging them; the sink decides where they go): the exact verdict's feedback, the judge's explanation, `Test execution error: …`, the interrupt mismatch. `runTestWithRetries` returns the **last attempt's** outcome, so the feedback is the final failure, and adds `attempts` to it.
- [ ] `runTestFile` returns, beside today's summary, `TestFileReport` (from `testReport.ts`): `file`, `sourceFile`, `status` (`ran` | `compile-failed` with `error` | `skipped` | `aborted`), and one `TestCaseReport` per case (`node`, optional `description`/`input`, `status`, `feedback`, `durationMs`, `attempts`). A case skipped by `skip`/`skipOnCI` is `skipped`. Under `compile-failed` (Task 2's refusal path) the cases array lists every case as `failed` with the file's error as feedback, so a consumer counting cases sees the right denominator.
- [ ] `test()` returns `TestStats` plus the full `TestReport` (`version: 1`, `files`, totals computed by `testReport.ts`, never by hand in the caller).

**Output routing.**
- [ ] New `lib/cli/testOutput.ts`: `TestOutput = { line(msg, stream?): void; flushDocument(doc): void }` with two constructors: `humanOutput()` (stdout/stderr as today) and `jsonOutput()` (every `line` goes to stderr; `flushDocument` writes `JSON.stringify(doc)` + newline to stdout once). The buffered per-file logger (`createBufferedLogger`) writes into a `TestOutput` instead of `console`.
- [ ] Thread one `TestOutput` through `test()`, `runTestFile`, `printSuiteAbortSummary`, and the shard line. Call `precompileTestSources(config, files, { quiet: options.json })`; the `CompileClosureError` path prints through the sink's stderr and still exits 1.
- [ ] `scripts/agency.ts` test action: construct the sink from `opts.json`, pass it to `test()`, print the totals and `printSlowestTests` through it (they become stderr under `--json`), then `flushDocument(report)` when `--json`, then the existing exit code.
- [ ] Audit: `git grep -n "console\.\(log\|error\)" lib/cli/test.ts scripts/agency.ts` restricted to the `test` code paths (not `fixtures`, not `test js`) must show nothing left outside the sink; record the grep in the commit message.

**Tests.**
- [ ] `testReport.test.ts`: totals over a mix of passed/failed/skipped cases and one `compile-failed` file; `version` is 1; the zod schema round-trips the document; a `compile-failed` file contributes its cases to `failed`.
- [ ] `testOutput.test.ts`: `jsonOutput().line("x")` lands on stderr, not stdout; `flushDocument` writes exactly one line to stdout; `humanOutput` is the current behavior (capture both streams).
- [ ] `test.test.ts`: `runTestWithRetries` returns the final attempt's feedback when every attempt fails (stub `runSingleTest`).
- [ ] Agency-js tests, three fixtures in one `tests/agency-js/test-cli-json/` test.js, each asserting stdout is **exactly one** parseable line and stderr still carries the human summary:
  - a normal run: one passing and one failing case; `passed: 1, failed: 1`; the failing case's `feedback` contains the expected and actual values;
  - a sharded run: `--shard 1/2` over two files; the document lists only the shard's file and the shard line is on stderr;
  - an aborted run: a case with `timeoutMs` far below a node that sleeps (`std::system` `sleep` or a busy loop), under a suite-wide ceiling the fixture cannot set — so instead drive the abort summary directly in a unit test: `printSuiteAbortSummary(suite, jsonOutput())` writes nothing to stdout. The suite-abort path cannot be triggered deterministically from outside; the unit test pins the routing and the report builder test pins the `aborted` status.
- [ ] Commit: "agency test --json: structured case outcomes, one output sink, one document on stdout".

## Task 4: documentation for the flags

**Files:** `docs/dev/cli-arguments.md` (mention the three new agency-side flags if it lists them), `docs/dev/eval-grading.md` (a short "how the grader runs `agency test`" paragraph comes in Task 10), and the `agency test` reference page under `docs/site/cli/` is owner-owned: leave it, note it in the PR.

- [ ] Add a dev note section "Running tests under a policy and a pure-Agency closure" to `docs/dev/eval-grading.md` or a new `docs/dev/test-cli-sandbox.md` (one concept: what the two flags guarantee and why static init is not a hole; cite `lib/runtime/node.ts:201`, `interrupts.ts:409`, and the startup-reads memory). Add the CLAUDE.md pointer.
- [ ] Commit with Task 3 or separately.

## Task 5: the eval harness profile (spec Part 2, "Preflight")

**Files:** `lib/testFormat/schema.ts`, `lib/testFormat/schema.test.ts`

- [ ] `parseTestFileEvalHarness(jsonText, jsonFilename, siblingAgencyBasename)`: parse with `parseTestFileFull`, then refuse by name (message names file, case index, node, field): `interruptHandlers`, `llmMocks`, `fetchMocks` (file or case), `fakeClock`, `useTestLLMProvider`, `argv`, `skip`, `skipOnCI`, `skipReason`, `expectedCompileError`; `evaluationCriteria` must be exactly `[{ type: "exact" }]`; `sourceFile` when present must equal the sibling basename. Returns the full-profile file.
- [ ] Tests: one accepting case; one test per refused field (a `test.each` over the list, each asserting the field name appears in the error); the `sourceFile` mismatch; the `llmJudge` criterion.
- [ ] Commit: "testFormat: the eval harness profile".

## Task 6: the run row's `harness` record (spec Part 2, "Run time")

**Files:** `lib/runDirectory/annotations.ts`, `lib/eval/runTypes.ts`, `lib/eval/loadInputs.ts`, `lib/eval/run/runSuite.ts`, `lib/eval/grading/harnessSnapshot.ts` (new), tests beside each.

Background: `foldIntoRunDirectory` in `runSuite.ts` calls `recordCompletedRun({ gradersFiles, run: { payload } })`; `gradersFiles` are `{ name, content }` pairs stored under `graders/` (`writeGradersFiles` in `lib/runDirectory/mutations.ts`, which skips a name already present). The module-grader snapshot names a judge file `<sha256 of content><extension>` (`snapshotGradingModule`, `lib/eval/grading/gradingModule.ts:88`); there is no shared naming helper, and none is added: harness files use the same rule inline, so a harness `.agency` is stored as `<sha256>.agency` and its json as `<sha256>.test.json`. The run row's `harness` record maps logical names to those stored names, so the basename is never needed in the store. This task does **not** touch `revision`; that is Task 9's.

- [ ] `annotations.ts`: add `harness?: HarnessRecord[]` to the `run` payload type and `RunAnnotationSchema`, where `HarnessRecord = { name: string; visibility: "visible" | "holdout"; agency: string; json: string; sha256: string; maxCost?: number }`. `GradersIdentity` is unchanged here.
- [ ] New `lib/eval/grading/harnessSnapshot.ts`: `HarnessSnapshot = { files: { name: string; content: string }[]; records: HarnessRecord[] }` and `snapshotHarness(defs: AgencyTestDefinition[], maxCost?: number): HarnessSnapshot`. Runs the Task 5 preflight on each pair first (a refusal throws, naming the file), reads both files, names them `<sha256>.agency` / `<sha256>.test.json`, sets `sha256` on the record to the hash of `agency + "\0" + json`, and dedupes `files` by name.
- [ ] `runSuite.ts`: `snapshotGraders` returns one `TestSnapshots = { module?: TestGraders; harness?: HarnessSnapshot }` per test (today it returns `TestGraders | undefined`; the `agencyTests` special case that synthesized a module is removed). `executeTest` passes the pair through unchanged. `foldIntoRunDirectory` writes `gradersFiles: [...(module?.files ?? []), ...(harness?.files ?? [])]` and the payload gets `graders` from `module` (as today) and `harness` from `harness.records`. Show the type in the commit, not just the behavior.
- [ ] `runTypes.ts` / `loadInputs.ts`: keep `AgencyTestDefinition`; add optional `harnessMaxCost?: number` to `Test`, read from `test.json`, validated as a finite non-negative number with a message naming the file.
- [ ] Tests: `harnessSnapshot.test.ts` (two pairs → four files named by hash and extension, two records, `sha256` stable across calls, a preflight refusal surfaces with the file name, the same content in two pairs is stored once); `runSuite` test that a test with harness pairs writes `graders/<sha256>.agency` etc. and a `harness` array on the run row (extend an existing run-row test); `annotations.test.ts` accepts the field and rejects an unknown key inside a record.
- [ ] Commit: "Run directory keeps each harness pair as plain files with a `harness` record".

## Task 7: `AgencyTestGrader` on `agency test --json` (spec Part 2, "Grade time")

**Files:** `lib/eval/grading/agencyTestGrader.ts` (rewrite), `agencyTestGrader.test.ts`, `agencyTestGrader.spawn.test.ts`, `lib/eval/public.ts` (export unchanged).

- [ ] Options: `{ name, agencyFile, testJsonFile, maxCost?: number }` where the two paths are absolute (the loader resolves them; the grader never resolves against cwd). Drop `externalFiles`/`rebindExternalFile`: binding is the loader's job now (Task 8).
- [ ] `_run`: steps 1–8 of the spec. The workdir copy uses `cpSync` with a `filter` that returns false for anything whose `lstat` is a symbolic link; one comment says why (no link support, by rule). Default `maxCost` 5 when the option is absent. The spawn seam stays injectable (`RunWrapper`-style) so unit tests stub it; the spawn test drives the real CLI. Parse stdout with the `testReport` zod schema from Task 3; on failure, feedback = "agency test produced no report" + stderr tail.
- [ ] `revision` = `agency-tests/<name>@<sha256>` where the sha is computed from the two files' contents (same rule as Task 6, shared helper in `harnessSnapshot.ts`).
- [ ] Unit tests (stubbed spawn): all pass → 1; one of two fails → 0.5 with feedback naming the node; file `compile-failed` → 0 with the error; no workdir → 0 with "no workdir"; the agent's copy of the harness json in the workdir is overwritten (the stub asserts on the bytes it is handed); a symlink at the harness destination is replaced, not followed (assert the link target is untouched).
- [ ] Spawn tests (real CLI, as today's `agencyTestGrader.spawn.test.ts`): a good fib solution scores 1; a wrong one scores 0.5 with the diff in feedback; a solution that `import fs` scores 0 with "Sandboxed compilation refused"; a solution whose node does `write(...) with approve` scores 0 and the file does not exist afterwards (positive control: the same solution under plain `agency test` writes it); a workdir containing a symlink grades without the link being present in the scratch copy. The cost cap is covered by a unit test of the env (Task 1), not by a paid call. Keep these under the existing spawn-test timeout.
- [ ] Commit: "AgencyTestGrader runs agency test --json --agency-only --reject '*'".

## Task 8: loading harness graders at grade time (spec Part 2, "Grade time")

**Files:** `lib/eval/grading/gradeRun.ts` (`effectiveGraders`, `entryFor`), tests.

Background: grading's only input is a run directory (`gradeRun`/`gradeSnapshot` in `gradeRun.ts`; callers are `gradeSuite.ts` and the optimizer). There is no live-from-suite grading path, so harness graders are built from the run row only. `eval run`'s pre-run validation loads module graders through `makeGraderModuleCache`; harness pairs are validated by Task 6's preflight instead, and nothing else is needed there.

- [ ] `entryFor` carries `harness` from the run row into `Entry` (beside `graders`).
- [ ] `effectiveGraders` returns `[...moduleGraders, ...harnessGraders]`: module graders keep today's precedence (override > test-owned snapshot > recorded module path > config-origin snapshot > fallback); `harnessGraders` is one `AgencyTestGrader` per record, bound to `path.join(gradersDir, record.agency)` / `record.json`, with `maxCost: record.maxCost`. Harness graders apply under `--graders <override>` and under `--goal`, because they are the test's own.
- [ ] Tests: a run directory with a `harness` record and stored files grades with one grader per record whose `revision` is `agency-tests/<name>@<sha256>`; a directory without the field grades exactly as before (reuse an existing fixture); `--goal` and `--graders` keep harness graders; a record whose stored file is missing fails grading with a message naming the stored name (mirror `loadGradingSnapshot`'s "snapshot not found" wording).
- [ ] Commit: "eval grade builds harness graders from the run row".

## Task 9: remove the old design (spec Part 3)

- [ ] Delete `lib/agents/eval/agencyTestWrapper.agency`, `tests/agency/agency-test-wrapper-policy.agency` + `.test.json`, `lib/eval/grading/reportEnvelope.ts`, `lib/eval/grading/synthesizeGradersModule.ts` + `.test.ts`.
- [ ] Remove, all in this one task and in one commit so each step typechecks: the synthesized-grader writer in `runSuite.ts` (already gone in Task 6), `GraderRevision`, the `revision` field on `GradersSnapshot` and `RecordedGraders`, the `revision` branch of `loadGradingSnapshot` in `gradingModule.ts`, and `revision` on `GradersIdentity` plus its zod schema in `annotations.ts`. Run the `gradingModule`, `annotations`, and `gradeRun` suites after.
- [ ] Remove `_formatFailurePayload` from `stdlib/agency.agency` (then `make`).
- [ ] Delete `docs/superpowers/specs/2026-08-21-combined-grader-external-files-design.md` (it is on `main`; deleting it in this PR is fine, the spec says why).
- [ ] `git grep` for every removed name (`agencyTestWrapper`, `reportEnvelope`, `synthesizeGradersModule`, `_formatFailurePayload`, `sourceIdentity`, `GraderRevision`) and fix every hit, including docs.
- [ ] Commit: "Remove the wrapper, the envelope, and the synthesized grading module".

## Task 10: docs

- [ ] `docs/dev/std-agency-test.md`: replace the "Eval grading" section with the new mechanism (discovery, preflight, harness record, grader command line, the safety argument with its five bullets), and update the CLAUDE.md pointer line.
- [ ] `docs/dev/eval-grading.md`: rewrite "Coding tests" to describe `agency test --json --agency-only --reject '*'` and the three rules that survive (never run the harness from the workdir; spawn, never call `test()` in-process; scratch under `.agency-tmp`).
- [ ] `docs/dev/run-directory.md`: the `graders/` directory now also holds harness pairs; the run row has `harness`.
- [ ] Stdlib docs regenerate via `make` after Task 9 (do not hand-edit `docs/site/**`). The `agency test` CLI reference under `docs/site/cli/` is the owner's; list the three flags in the PR description for them.
- [ ] Commit: "Docs: eval grading on agency test".

## Task 11: verification and the PR

- [ ] `npx tsc --noEmit -p .`; `pnpm run fmt:ts`; `pnpm run lint:structure`; `npx vitest run lib/sourceIsText.test.ts` (the repo-wide guard that scoped runs miss); `git diff --numstat origin/main | awk '$1=="-"'` must print nothing (no binary files).
- [ ] Vitest for every changed file's suite: `lib/cli/test.test.ts`, `agencyOnlyCompile`, `testReport`, `lib/testFormat`, `harnessSnapshot`, `agencyTestGrader` (+ spawn), `gradeRun`, `runSuite`, `annotations`, `runPolicy`. Save output to the scratchpad; read failures from the file.
- [ ] Agency-js tests from Tasks 1–3 with `pnpm run agency test js <dir>`; the fib eval end to end: `agency eval run evals/agency-agent/fib --out <dir>` with a cheap model if one is configured, then `agency eval grade <dir>` and confirm two score rows per run (`fib-tests`, `fib-holdout`) with revisions of the form `agency-tests/<name>@<sha>`. If no model is available, the spawn tests in Task 7 are the evidence; say so in the PR.
- [ ] Anti-pattern audit of the diff against `docs/dev/anti-patterns.md` before pushing.
- [ ] Update PR #880's description: the new design in one paragraph, the three flags (and that `docs/site/cli/test.md` needs the owner's edit), the deletions, and the verification list. Push (fast-forward; no force).

## Out of scope, named so they are not done by accident

- Moving the CLI's `input` string to an `args` object (#881).
- A per-test custom grading policy (`harnessPolicy` in `test.json`).
- Capability-set names in `--approve` / `--reject`, and rewriting the built-in policies as unions of `std::capabilities` sets (the policy clean-up; its own change).
- `pkg::` imports in the sandbox.
- Any change to `std::agency`'s `test()`/`testFile()` beyond deleting `_formatFailurePayload`.
