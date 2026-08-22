# Eval grading of Agency coding tests: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (this project does NOT use subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/docs/superpowers/specs/2026-08-22-eval-agency-test-grading-design.md`. Read it first; every task names its section.

**Branch:** `adit/split-4-eval-grader` (PR #880, based on `main`). The branch currently carries the wrapper-based grader. This plan rewrites it in place: the first tasks add the `agency test` flags (which stand on their own), the middle tasks rebuild the grader on them, the last tasks delete what the old design needed.

**Goal:** `agency test` can run a test file with a caller-chosen root interrupt policy, a pure-Agency import closure, and machine-readable output; the eval framework grades a coding test by running `agency test --json --pure-agency --policy reject-all` against the agent's workdir with the framework's copy of each harness pair, and keeps those pairs in the run directory as plain files.

## Global constraints

- One concept per file. No module-level per-run state. Objects not maps, arrays not sets, types not interfaces. No dynamic imports.
- Every safety test needs a positive control (the same input passes without the flag) and a specific diagnostic to match, so the test cannot pass by accident.
- Save every test run's output to a file under the scratchpad and read it from there. Run only the suites that cover changed files. Never run the whole agency execution suite locally.
- `make` only after a change to `stdlib/**`, `lib/agents/**`, or templates. After TypeScript-only changes, `npx tsc --noEmit -p .` and vitest are enough.
- Deleting a directory in tests goes through `safeDeleteDirectoryWithin`, never a hand-rolled `rmSync` on a computed path.
- No force pushes, no amends, no commits on `main`.

## Sequencing

Tasks 1–4 change `agency test` only and are independently useful. Task 5 is the harness profile. Tasks 6–8 are the run directory and grader. Tasks 9–10 remove the old design and update docs. Task 11 is verification and the PR.

---

## Task 1: `--policy`, `--max-cost`, `--max-time` on `agency test` (spec Part 1, "--policy")

**Files:**
- `scripts/agency.ts` (the `test` command definition, around line 1140)
- `lib/cli/test.ts` (`test()`, `runTestFile`, `runSingleTest`)
- `lib/cli/util.ts` (`executeNodeAsync` already accepts `env`)
- `lib/runtime/builtinPolicies.ts` (`reject-all`)
- `lib/cli/test.test.ts`, `lib/runtime/builtinPolicies.test.ts` (or policy.test.ts)

Background: `agency run --policy` resolves a policy with `resolveRunPolicy` (`lib/cli/runPolicy.ts`) and puts its JSON into the child's environment as `AGENCY_RUN_POLICY` (`lib/cli/commands.ts:304-313`). The runtime's `runNode` installs the handler from that variable (`lib/runtime/node.ts:201`). The test runner spawns each case through `executeNodeAsync`, which merges an `env` object over `process.env`. So the work is: resolve once, pass the variables through.

- [ ] Add `"reject-all"` to `BUILTIN_POLICIES` and `builtinPolicy()` in `lib/runtime/builtinPolicies.ts`: `{ "*": [{ action: "reject" }] }`. Unit test: `checkPolicyExplicit(rejectAll, anyInterrupt)` is `{ type: "reject" }` for an effect with no rule of its own.
- [ ] Add a `TestRunOptions` type in `lib/cli/test.ts`: `{ policy?: ResolvedRunPolicy; maxCost?: number; maxTime?: number; pureAgency?: boolean; json?: boolean }`. Thread it from `test()` to `runTestFile` to `runSingleTest` as one object (no new positional parameters).
- [ ] In `runSingleTest`, build the child `env`: always delete `AGENCY_RUN_POLICY` and `AGENCY_RUN_POLICY_INTERACTIVE` (clear-then-set, copying the comment from `commands.ts`), then set `AGENCY_RUN_POLICY` from `options.policy.policyJson` when present; set `AGENCY_MAX_COST` / `AGENCY_MAX_TIME` when given. Pass it as `env` to `executeNodeAsync`. Note the existing `executeNodeAsync` may already set env entries (LLM mocks); merge, do not replace.
- [ ] In `scripts/agency.ts`, add `--policy <name|path>`, `--max-cost <dollars>`, `--max-time <duration>` to the `test` command, resolved the same way the `run` command resolves them (reuse the helpers `run` uses; do not re-parse durations by hand).
- [ ] Unit test in `lib/cli/test.test.ts`: the env builder deletes an inherited `AGENCY_RUN_POLICY` when no policy is given, and sets it to the resolved JSON when one is. (Extract the env builder as a small pure function so this is a plain test.)
- [ ] Agency execution test `tests/agency/test-cli-policy/` (an agency-js test is the right tier, since it drives the CLI): a tested node does `write("x.txt", "hi", ".") with approve` and returns whether the write succeeded. Positive control: `agency test` without `--policy` writes the file and the case expecting `"written"` passes. With `--policy reject-all`: the file is not written and the case fails with feedback containing the reject. Both assertions in one `test.js`, so the control and the restricted run share the fixture. Check `docs/misc/TESTING.md` for the agency-js layout.
- [ ] Commit: "agency test --policy/--max-cost/--max-time: the run's root handler and budget, in the test runner".

## Task 2: `--pure-agency` (spec Part 1, "--pure-agency")

**Files:**
- `lib/cli/test.ts` (`runTestFile`: the compile step; `runSingleTest`: where the compiled path is chosen)
- `lib/cli/util.ts` (`runAgencyNode` needs to accept an already-materialized compiled entry)
- `lib/cli/pureAgencyCompile.ts` (new, one concept: validated compile of one test source into a scratch layout)
- `lib/cli/pureAgencyCompile.test.ts`

Background: `runAgencyNode` picks `compiledPath` from `distDir`, a sibling `.js` (`preferCompiled`), or a fresh `compile()`. The sandboxed compile (`compileSandboxed`, #878) returns `{ code, modules?, entryPath? }` and the runtime already knows how to lay that out on disk (`materializeCompiledScript` in `lib/runtime/ipc.ts`, which writes under the package's `.agency-tmp/<id>/` and returns the entry script path). That function is reused as is.

- [ ] New `lib/cli/pureAgencyCompile.ts`: `compilePureAgency(sourceFile): { ok: true; scriptPath: string } | { ok: false; errors: string[] }`. Calls `compileSandboxed({ entry: { file: basename(sourceFile) }, dir: dirname(sourceFile) })`; on success calls `materializeCompiledScript(result)` and returns the script path. No `process.exit`, no throw on refusal.
- [ ] `runAgencyNode` gains an optional `compiledPath?: string` argument that short-circuits the three existing branches. Keep the branches' order and comments intact; the new argument is checked first and documented as "the caller already compiled this file".
- [ ] `runTestFile`: under `options.pureAgency`, call `compilePureAgency` once per file before the cases loop. On `ok: false`, log the errors, mark every case failed with that text as feedback, record the file in `failedFiles`, and return; do not `process.exit`. On success pass `scriptPath` as `compiledPath` to every case. Skip the precompile pass for these files (`test()` already groups files for precompile; exclude them when `pureAgency` is set).
- [ ] Cleanup: the materialized directory is deleted after the file's cases finish, through `safeDeleteDirectoryWithin(<.agency-tmp>, <dir>)`. Never derive the directory by path arithmetic; `materializeCompiledScript` returns the script path and the per-run dir is its parent only for single-file programs, so have `compilePureAgency` also return the run directory it created (the first segment under `.agency-tmp`, the same rule `cleanupTempDir` in `ipc.ts` uses; expose that rule as a named helper rather than copying it).
- [ ] Unit tests: a source importing a sibling `.agency` compiles and the script exists at the returned path; a source importing `fs` returns `ok: false` with "not Agency source" in the errors and no script; a source in `sub/` importing `./helper.agency` gets a script under `sub/` (nested entry, the #878 fix).
- [ ] Agency-js test `tests/agency-js/test-cli-pure-agency/`: the same fixture directory holds `good.agency` (std:: only) and `bad.agency` (imports `fs`). Positive control: `agency test bad.test.json` without the flag compiles and runs. With `--pure-agency`: `good` passes, `bad` fails with "Sandboxed compilation refused" in the output and the exit code is 1, and the process did not exit before printing the summary line for `good` (proves no `process.exit` on the refusal).
- [ ] Commit: "agency test --pure-agency: validated closure compile, refusals are file failures".

## Task 3: `--json` (spec Part 1, "--json")

**Files:**
- `lib/cli/testReport.ts` (new: the JSON document type, its zod schema, and the builder from `TestStats`-level data)
- `lib/cli/test.ts` (collect per-case outcomes; route human output to stderr under `--json`; print the document at the end)
- `scripts/agency.ts` (`--json` flag)
- `lib/cli/testReport.test.ts`

Background: `runTestFile` already computes per-case outcomes (`SingleTestOutcome`) and durations (`slowTests`), and returns a per-file summary that `test()` folds into `TestStats`. The JSON document is that data, kept per case instead of summed. The buffered logger (`createBufferedLogger`) is where stdout/stderr routing lives.

- [ ] `lib/cli/testReport.ts`: the types from the spec (`TestReport`, `TestFileReport`, `TestCaseReport`, with `version: 1`), a zod schema exported for the grader's strict parse, and `emptyReport()`. One file, one concept.
- [ ] `runTestFile` records a `TestCaseReport` per case: `node`, optional `description`/`input`, `status`, `feedback` (the same text the human output prints for a failure: exact diff, judge explanation, execution error, interrupt mismatch), `durationMs`. Return it alongside the existing summary. File-level `status`: `ran`, `compile-failed` (Task 2's path, with `error`), `skipped`, `aborted`.
- [ ] Under `options.json`, the buffered logger sends every line to stderr; `test()` prints `JSON.stringify(report)` to stdout once, after the suite summary, and `scripts/agency.ts` exits with the same code as today.
- [ ] Unit tests: the builder turns a mix of passed/failed/skipped cases and one compile-failed file into the documented shape; totals match; `version` is 1; the schema round-trips it.
- [ ] Agency-js test: `agency test --json` on a fixture with one passing and one failing case prints a single JSON document on stdout that parses and validates, has `passed: 1, failed: 1`, and the failing case's `feedback` contains the expected/actual values; stderr still contains "tests passed".
- [ ] Commit: "agency test --json: one machine-readable document on stdout".

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

**Files:** `lib/runDirectory/annotations.ts`, `lib/eval/runTypes.ts`, `lib/eval/run/runSuite.ts`, `lib/eval/grading/harnessSnapshot.ts` (new), tests beside each.

Background: `foldIntoRunDirectory` in `runSuite.ts` calls `recordCompletedRun({ gradersFiles, run: { payload } })`; `gradersFiles` are `{ name, content }` pairs stored under `graders/` with content-hash names (`writeGradersFiles`). The module-grader snapshot uses this for judge files. The harness record uses the same store.

- [ ] `annotations.ts`: add `harness?: HarnessRecord[]` to the `run` payload type and `RunAnnotationSchema`, where `HarnessRecord = { name, visibility: "visible" | "holdout", agency: string, json: string, sha256: string, maxCost?: number }`. `GradersIdentity` loses its `revision` field (Task 9 removes the writer; do the type here so the schema is final).
- [ ] New `lib/eval/grading/harnessSnapshot.ts`: `snapshotHarness(defs: AgencyTestDefinition[], maxCost?: number): { files: { name, content }[]; records: HarnessRecord[] }`. Stored name = `<sha256 of content>-<basename>` (what judge files do; check `snapshotGradingModule` for the exact naming helper and reuse it). `sha256` on the record = hash of `agency + "\0" + json`. Runs the Task 5 preflight on each pair first, so a refusal happens here, before any agent runs.
- [ ] `runSuite.ts`: `snapshotGraders` no longer special-cases `agencyTests`; a test with both `graders` and `agencyTests` gets both. `foldIntoRunDirectory` passes harness files into `gradersFiles` (concatenated with the module snapshot's files) and the records into the payload's `harness`.
- [ ] `runTypes.ts`: keep `AgencyTestDefinition`; add optional `harnessMaxCost?: number` to `Test` (read from `test.json` in `loadInputs.ts`, validated as a non-negative number).
- [ ] Tests: `harnessSnapshot.test.ts` (two pairs → four files with hash names, two records, sha stable across calls, preflight refusal surfaces with the file name); `runSuite` test that a test with harness pairs writes `graders/<hash>-…` files and a `harness` array on the run row (look for the existing `runSuite` tests that assert on the run row and extend one); `annotations.test.ts` schema accepts the field and rejects an unknown key inside a record.
- [ ] Commit: "Run directory keeps each harness pair as plain files with a `harness` record".

## Task 7: `AgencyTestGrader` on `agency test --json` (spec Part 2, "Grade time")

**Files:** `lib/eval/grading/agencyTestGrader.ts` (rewrite), `agencyTestGrader.test.ts`, `agencyTestGrader.spawn.test.ts`, `lib/eval/public.ts` (export unchanged).

- [ ] Options: `{ name, harnessAgency, harnessJson, maxCost?: number }` where the two paths are absolute (the loader resolves them; the grader never resolves against cwd). Drop `externalFiles`/`rebindExternalFile`: binding is the loader's job now (Task 8).
- [ ] `_run`: steps 1–8 of the spec. The spawn seam stays injectable (`RunWrapper`-style) so unit tests stub it; the spawn test drives the real CLI. Parse stdout with the `testReport` zod schema from Task 3; on failure, feedback = "agency test produced no report" + stderr tail.
- [ ] `revision` = `agency-tests/<name>@<sha256>` where the sha is computed from the two files' contents (same rule as Task 6, shared helper in `harnessSnapshot.ts`).
- [ ] Unit tests (stubbed spawn): all pass → 1; one of two fails → 0.5 with feedback naming the node; file `compile-failed` → 0 with the error; no workdir → 0 with "no workdir"; the agent's copy of the harness json in the workdir is overwritten (the stub asserts on the bytes it is handed); a symlink at the harness destination is replaced, not followed (assert the link target is untouched).
- [ ] Spawn tests (real CLI, as today's `agencyTestGrader.spawn.test.ts`): a good fib solution scores 1; a wrong one scores 0.5 with the diff in feedback; a solution that `import fs` scores 0 with "Sandboxed compilation refused"; a solution whose node does `write(...) with approve` scores 0 and the file does not exist afterwards (positive control: the same solution under plain `agency test` writes it); a solution calling `llm()` scores 0 with the cost-cap message (positive control not needed; assert the message). Keep these under the existing spawn-test timeout.
- [ ] Commit: "AgencyTestGrader runs agency test --json --pure-agency --policy reject-all".

## Task 8: loading harness graders at grade time (spec Part 2, "Grade time")

**Files:** `lib/eval/grading/gradeRun.ts` (`effectiveGraders`, `entryFor`), `lib/eval/grading/gradingModule.ts` (remove the `revision` branch), `lib/eval/run/runSuite.ts` or wherever live graders are assembled for `eval run`'s pre-run validation, tests.

- [ ] `entryFor` carries `harness` from the run row into `Entry`.
- [ ] `effectiveGraders` returns `[...moduleGraders, ...harnessGraders]` where `harnessGraders` builds one `AgencyTestGrader` per record bound to `path.join(gradersDir, record.agency / record.json)` and `maxCost: record.maxCost`. The override mode (`--graders`) replaces module graders only; harness graders always apply (they are the test's own).
- [ ] Live grading (a suite graded without a run directory, if that path exists; check `gradeRun.ts` callers): bind to the test directory's files from `test.agencyTests`.
- [ ] Tests: a run directory with a `harness` record and stored files grades with one grader per record whose `revision` matches the record's sha; a directory without the field grades exactly as before (regression: reuse an existing fixture); `--goal` keeps harness graders.
- [ ] Commit: "eval grade builds harness graders from the run row".

## Task 9: remove the old design (spec Part 3)

- [ ] Delete `lib/agents/eval/agencyTestWrapper.agency`, `tests/agency/agency-test-wrapper-policy.agency` + `.test.json`, `lib/eval/grading/reportEnvelope.ts`, `lib/eval/grading/synthesizeGradersModule.ts` + `.test.ts`.
- [ ] Remove `GraderRevision`, the `revision` field on `GradersSnapshot`/`RecordedGraders`, and the `loadGradingSnapshot` branch in `gradingModule.ts`; remove `revision` from `GradersIdentity` and the zod schema (Task 6 may have done the type already).
- [ ] Remove `_formatFailurePayload` from `stdlib/agency.agency` (then `make`).
- [ ] Delete `docs/superpowers/specs/2026-08-21-combined-grader-external-files-design.md` (it is on `main`; deleting it in this PR is fine, the spec says why).
- [ ] `git grep` for every removed name (`agencyTestWrapper`, `reportEnvelope`, `synthesizeGradersModule`, `_formatFailurePayload`, `sourceIdentity`, `GraderRevision`) and fix every hit, including docs.
- [ ] Commit: "Remove the wrapper, the envelope, and the synthesized grading module".

## Task 10: docs

- [ ] `docs/dev/std-agency-test.md`: replace the "Eval grading" section with the new mechanism (discovery, preflight, harness record, grader command line, the safety argument with its five bullets), and update the CLAUDE.md pointer line.
- [ ] `docs/dev/eval-grading.md`: rewrite "Coding tests" to describe `agency test --json --pure-agency --policy reject-all` and the three rules that survive (never run the harness from the workdir; spawn, never call `test()` in-process; scratch under `.agency-tmp`).
- [ ] `docs/dev/run-directory.md`: the `graders/` directory now also holds harness pairs; the run row has `harness`.
- [ ] Stdlib docs regenerate via `make` after Task 9 (do not hand-edit `docs/site/**`). The `agency test` CLI reference under `docs/site/cli/` is the owner's; list the three flags in the PR description for them.
- [ ] Commit: "Docs: eval grading on agency test".

## Task 11: verification and the PR

- [ ] `npx tsc --noEmit -p .`; `pnpm run fmt:ts`; `pnpm run lint:structure`; `npx vitest run lib/sourceIsText.test.ts` (the repo-wide guard that scoped runs miss); `git diff --numstat origin/main | awk '$1=="-"'` must print nothing (no binary files).
- [ ] Vitest for every changed file's suite: `lib/cli/test.test.ts`, `pureAgencyCompile`, `testReport`, `lib/testFormat`, `harnessSnapshot`, `agencyTestGrader` (+ spawn), `gradeRun`, `runSuite`, `annotations`, `builtinPolicies`/`policy`. Save output to the scratchpad; read failures from the file.
- [ ] Agency-js tests from Tasks 1–3 with `pnpm run agency test js <dir>`; the fib eval end to end: `agency eval run evals/agency-agent/fib --out <dir>` with a cheap model if one is configured, then `agency eval grade <dir>` and confirm two score rows per run (`fib-tests`, `fib-holdout`) with revisions of the form `agency-tests/<name>@<sha>`. If no model is available, the spawn tests in Task 7 are the evidence; say so in the PR.
- [ ] Anti-pattern audit of the diff against `docs/dev/anti-patterns.md` before pushing.
- [ ] Update PR #880's description: the new design in one paragraph, the three flags (and that `docs/site/cli/test.md` needs the owner's edit), the deletions, and the verification list. Push (fast-forward; no force).

## Out of scope, named so they are not done by accident

- Moving the CLI's `input` string to an `args` object (#881).
- A per-test custom grading policy (`harnessPolicy` in `test.json`).
- `pkg::` imports in the sandbox.
- Any change to `std::agency`'s `test()`/`testFile()` beyond deleting `_formatFailurePayload`.
