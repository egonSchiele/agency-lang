# Harbor Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agency eval import-harbor [<job>...] [--trials <file>] --out <dir> [--batch] [--reasoning]` converts the Harbor trials it's given into one batch of Agency run folders (ADI-372). Choosing which trials belong in a suite run is done by hand, and is not part of this plan.

**Architecture:**
- First, Agency's run summary learns an `void` outcome, and stops scoring every run that didn't end `ok` as 0.
- Then three small modules under `lib/eval/harbor/`:
  - a reader that parses `result.json` through one zod schema, and expands job folders and `--trials` files into trials,
  - a pure planner that numbers trials in input order, scores each one and builds its `run` row,
  - a writer that applies the plan through `recordCompletedRun` and `recordGradingPass`.
- A hidden CLI command prints the summary.

**Tech Stack:** TypeScript, zod 4, vitest, commander (`scripts/agency.ts`).

**Spec:** `packages/agency-lang/docs/superpowers/specs/2026-11-23-harbor-import-design.md`

## Global Constraints

- **ADI-370 must be merged before Task 4.** `RunPayload` and `RunAnnotationSchema` must have optional `benchmark?: string` and `reasoning?: string`. If they don't, stop, and don't work around it. A re-import leaves existing runs alone, so runs imported before these fields exist could never gain them.
- All writes go through `recordCompletedRun` and `recordGradingPass` (`lib/runDirectory/mutations.ts`).
- Run folder path: always `<out>/<batch>/<testId>/<trial>/`.
- **The command never chooses or drops trials.** It converts every trial it's given, numbers each test's trials 1, 2, 3… in input order, and only reports uneven trial counts.
- **Re-importing a smaller selection needs a fresh output folder.** The command only checks the folders it plans, so a trial dropped from the end of the input leaves its old folder behind. Delete `<out>/<batch>` first; the dev doc says so.
- **Annotators:**
  - `run` row: `{ kind: "harness", id: "harbor-import@<harnessVersion()>" }`.
  - Scores: `{ kind: "grader", id: "harbor-verifier:<benchmark>" }`.
- **Scoring (spec, rule C):**
  - No trace means void.
  - A reward means the reward is the score.
  - No reward plus an exception in `AGENT_FAULT = ["AgentTimeoutError", "NonZeroAgentExitCodeError"]` means a binary score of 0.
  - Anything else with no reward means void.
- **Silent run `traceId`:** `"harbor-" + sha256(`${harborJob}/${harborTrial}`).slice(0, 24)`.
- Work in a worktree off `origin/main`. Run `pnpm run typecheck` (it includes `tsconfig.tests.json`) before every commit. Run `make` once in a fresh worktree before grading or upload tests.

## Review Focus

1. **The same trial listed twice** (in a job folder and in `--trials`, or twice in the file) is a problem naming it, and is converted once. Test in Task 3.
2. **A `--trials` line that isn't a trial folder** (missing path, or no `result.json`) is a problem naming the line number. The rest still import. Test in Task 3.
3. **The input changed order on re-import:** a mismatch between a folder's `harborJob`/`harborTrial` and the plan is a failure naming both, never a silent "present". Test in Task 5.
4. **A task name containing `/` or `..`** is refused by the reader. Test in Task 3.
5. **Job-level files** (`config.json`, `job.log`, `lock.json`, the job's `result.json`) are never trials. Test in Task 3.

---

### Task 1: Score runs that didn't end `ok` by what they were given, and add `void`

**Files:**
- Modify: `lib/runDirectory/annotations.ts:88` (`RunOutcome`) and `:240` (the `ended` enum)
- Modify: `lib/runDirectory/list.ts:184` (`score`)
- Test: `lib/runDirectory/list.test.ts`, `lib/eval/batchStatistics.test.ts`
- Modify: `docs/dev/evals/run-directory.md` (the `run` row's `ended` values, and the score rule, in one line each)

**Interfaces:**
- Produces: `RunOutcome = "ok" | "error" | "timeout" | "cost-cap" | "killed" | "void"`. `RunSummary.score` is `effectiveScore` when `ended` is `ok`, `null` when it's `void`, and otherwise `effectiveScore ?? 0`.

- [ ] **Step 1: Write the failing tests** in `list.test.ts`. Build run folders with `recordCompletedRun`, then `recordGradingPass`.
  - `"a timed-out run keeps the score it was given"`: `ended: "timeout"` with a binary pass gives `score: 1`.
  - `"an ungraded run that didn't end ok still scores 0"`: `ended: "error"` with no scores gives `score: 0`. This is unchanged behavior.
  - `"a void run has no score"`: `ended: "void"` gives `score: null`.

  In `batchStatistics.test.ts`: `"a void run is left out of accuracy"`. Runs scoring 1 and 0, plus one void run, give `accuracy: 0.5`.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/runDirectory/list.test.ts lib/eval/batchStatistics.test.ts`. Expected: the timeout test fails (0 instead of 1), and the void tests fail on the schema.
- [ ] **Step 3: Implement.** Add `"void"` to the type and the zod enum, and change the `score` line to the spec's expression.
- [ ] **Step 4: Run** the two files, `pnpm exec vitest run lib/runDirectory lib/eval lib/runsExplorer`, and `pnpm run typecheck`. Expected: all pass. If `typecheck` reports a non-exhaustive switch on `RunOutcome`, handle `void` like `error`.

  `statusOf` (`list.ts`) and `runsExplorer/rows.ts` show an `void` run as `failed`. That's intended; leave both alone.
- [ ] **Step 5: Update `run-directory.md`, then commit** with the message `Runs keep their given score when they don't end ok; add a void outcome`.

### Task 2: Share `harnessVersion`

**Files:**
- Create: `lib/eval/harnessVersion.ts`
- Modify: `lib/eval/run/runSuite.ts:664` (remove the private copy, import the shared one)
- Test: `lib/eval/harnessVersion.test.ts`

**Interfaces:**
- Produces: `export function harnessVersion(): string`. It is today's lookup, moved unchanged.

- [ ] **Step 1: Write the failing test** `"returns this package's version"`, comparing against `packages/agency-lang/package.json`'s `version`.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/eval/harnessVersion.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Move the function and import it in `runSuite.ts`.**
- [ ] **Step 4: Run** that test, `pnpm exec vitest run lib/eval/run`, and `pnpm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `Share harnessVersion with other eval harnesses`.

### Task 3: Read Harbor trials

**Files:**
- Create: `lib/eval/harbor/readTrials.ts`, `lib/eval/harbor/testFixtures.ts`
- Test: `lib/eval/harbor/readTrials.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type HarborTrial = {
    jobName: string;             // the job folder's name
    trialName: string;           // the trial folder's name
    testId: string;              // task_name after its first "/"
    benchmark: string;           // result.json `source`
    startedAt: string;
    rewards: Record<string, number> | null;
    exception: { type: string; message: string } | null;
    statelogPath: string | null; // <trial>/agent/statelog.jsonl when it exists
  };
  export type HarborProblem = { path: string; reason: string };
  export type ReadTrialResult = { ok: true; trial: HarborTrial } | { ok: false; problem: HarborProblem };
  export function readHarborTrial(trialDir: string): ReadTrialResult;
  export function readHarborInputs({ jobDirs, trialsFile }: {
    jobDirs: string[];
    trialsFile?: string;
  }): { trials: HarborTrial[]; problems: HarborProblem[] };
  ```
- **Input order:**
  1. Job folders in argument order. Within a job, its trials are sorted by `startedAt`, then `trialName`. A trial is a subfolder holding `result.json`.
  2. Then the `--trials` lines in file order. Each line is a trial folder path, resolved against the file's own folder. Blank lines and `#` comments are skipped.
  3. A trial seen a second time is a problem: `listed twice`. Trials are compared by `fs.realpathSync` of the trial folder, so `x`, `./x`, an absolute path and a symlink are the same trial.
- `HarborResultSchema` is private, a `z.looseObject`. It reads `task_name`, `source`, `started_at`, `verifier_result: { rewards: record<number> | null } | null`, and `exception_info: { exception_type, exception_message } | null`.
- Test helper: `writeHarborTrial(jobDir, { name, taskName, source, startedAt, rewards, exception?, statelogLines? }): string`.

- [ ] **Step 1: Write the failing tests:**
  - `"a job folder gives its trials ordered by start time"`: job-level `config.json`, `job.log`, `lock.json` and `result.json` are ignored.
  - `"a trials file gives its trials in line order, skipping blanks and comments"`.
  - `"job folders come before the trials file, in argument order"`.
  - `"a trial listed twice is a problem and is read once"` (Review Focus 1): once from its job folder and once as a relative `--trials` line.
  - `"a trials line that isn't a trial folder is a problem naming the line"` (Review Focus 2).
  - `"strips the source prefix from the task name"`.
  - `"refuses a task name containing / or .."` (Review Focus 4).
  - `"reports a result.json missing a field, naming it"`.
  - `"statelogPath is null when the agent never started"`.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/eval/harbor/readTrials.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `readHarborTrial` and `readHarborInputs`.**
- [ ] **Step 4: Run it again, then `pnpm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `Read Harbor trials from job folders and trial lists`.

### Task 4: Plan the import (pure)

**Files:**
- Create: `lib/eval/harbor/planImport.ts`
- Test: `lib/eval/harbor/planImport.test.ts`

**Interfaces:**
- Consumes: `HarborTrial` (Task 3), `RunOutcome` and `RunPayload` (`annotations.ts`, with ADI-370's fields), and `ScoreDraft` (`mutations.ts`).
- Produces:
  ```ts
  export type PlannedScore = Pick<ScoreDraft, "name" | "score">;
  export type PlannedRun = {
    trial: HarborTrial;
    relativeDir: string;           // `${testId}/${payload.trial}`
    payload: RunPayload;           // the whole run row
    scores: PlannedScore[];        // [] = unscored
    silentTraceId: string | null;  // set when statelogPath is null
  };
  export type ImportPlan = {
    batch: string;
    runs: PlannedRun[];
    trialCounts: Record<number, string[]>; // trials per test -> test ids
    unknownExceptions: string[];           // distinct, sorted
  };
  export function isVoid(trial: HarborTrial): boolean;
  export function scoresOf(trial: HarborTrial): PlannedScore[];
  export function endedOf(trial: HarborTrial): RunOutcome;
  export function planHarborImport({ trials, batch, reasoning }: {
    trials: HarborTrial[];         // in input order
    batch: string;
    reasoning?: string;
  }): ImportPlan;
  ```
- `payload` is `{ kind: "run", test: { id }, suite: null, ended, error?, flags: { harborJob: jobName, harborTrial: trialName }, batch, trial, benchmark, reasoning? }`. `trial` is the test's 1-based position among its trials in input order.

- [ ] **Step 1: Write the failing tests:**
  - `isVoid`:
    - no trace gives `true`, even with `NonZeroAgentExitCodeError`;
    - a trace with a reward gives `false`, even with `AgentTimeoutError`;
    - a trace, no reward and `AgentTimeoutError` or `NonZeroAgentExitCodeError` gives `false`;
    - a trace, no reward and `DaytonaError`, `CancelledError`, `VerifierTimeoutError`, `RewardFileNotFoundError` or `SomethingNew` gives `true`.
  - `scoresOf`:
    - `{reward: 1}` gives a binary pass, `{reward: 0}` a binary fail, and `{reward: 0.5}` a scalar 0.5;
    - two keys give two scores;
    - an agent-fault trial with no reward gives one binary fail named `reward`;
    - a void trial gives `[]`.
  - `endedOf`:
    - a void trial gives `"void"`;
    - no exception gives `"ok"`;
    - `AgentTimeoutError` gives `"timeout"`;
    - `CancelledError` with a reward gives `"killed"`;
    - anything else gives `"error"`.
  - `planHarborImport`:
    - trials `[A(job1), B(job1), A(job2)]` give A trials 1 and 2, and B trial 1, with `relativeDir` `A/1`, `A/2` and `B/1`;
    - `trialCounts` is `{2: ["A"], 1: ["B"]}`;
    - `payload` equals the full expected run row, with `flags.harborJob` as the job folder's name;
    - `silentTraceId` is the same on two calls with the same input, differs for another trial name, and is null when there's a trace;
    - `unknownExceptions` lists `SomethingNew` once.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/eval/harbor/planImport.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement it.** The `AGENT_FAULT` list is a `const` array in this file.
- [ ] **Step 4: Run it again, then `pnpm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `Plan Harbor trials as Agency runs`.

### Task 5: Write the run folders

**Files:**
- Create: `lib/eval/harbor/importHarbor.ts`
- Test: `lib/eval/harbor/importHarbor.test.ts`

**Interfaces:**
- Consumes: `readHarborInputs` (Task 3), `planHarborImport` and `ImportPlan` (Task 4), `harnessVersion` (Task 2), `recordCompletedRun`, `recordGradingPass`, `readTracesOrThrow`, and `readRunDirectory`.
- Produces:
  ```ts
  export type ImportOutcome =
    | { status: "imported" | "present" | "scored"; dir: string }
    | { status: "failed"; path: string; error: string };
  export type ImportResult = {
    plan: ImportPlan;
    outcomes: ImportOutcome[];
    problems: HarborProblem[];
    uploadPath: string;            // <out>/<batch>
  };
  export function importHarbor({ jobDirs, trialsFile, outDir, batch, reasoning }: {
    jobDirs: string[]; trialsFile?: string; outDir: string; batch?: string; reasoning?: string;
  }): ImportResult;
  ```
- **Batch:** `batch`. If it isn't given and there is exactly one job folder and no `trialsFile`, use that folder's name. Otherwise throw `Error("import-harbor: --batch is required unless importing one job folder")`.
- **Per planned run:**
  1. **The folder has a `run` row.** If its `flags` don't match the plan, the result is `failed` with an error naming both job/trial pairs. If they match and `gradingPasses > 0` or the plan has no scores, the result is `present`. Otherwise call only `recordGradingPass`, and the result is `scored`.
  2. **Otherwise,** `traceId` is `silentTraceId`, or the single trace in `readTracesOrThrow(statelogPath)`. Call `recordCompletedRun` with `stagedStatelogFile` (omitted for a silent run) and `run: { traceId, annotator, payload }`. Then call `recordGradingPass` if there are scores. The result is `imported`.
  3. **Any throw** gives `failed`, and the loop continues.

- [ ] **Step 1: Write the failing tests:**
  - `"imports a trial that runs list reads"`: `summarizeRunDirectory` gives `testId`, `batch`, `trial`, `score` and `status: "ok"`. The `run` row also has `benchmark` and `reasoning`.
  - `"a trial without a trace is a silent run with no score"`: the summary gives `score: null`.
  - `"a second import changes nothing"`: every file under `<out>` is byte-identical, and every outcome is `present`.
  - `"a run cut off before its scores gets only its scores"`: the outcome is `scored`, and there's a single `run` row.
  - `"importing in a different order fails the moved runs, naming both"` (Review Focus 3).
  - `"a trace with two trace ids fails that trial only"`.
  - `"--batch is required for several job folders or a trials file"`.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/eval/harbor/importHarbor.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** `pnpm exec vitest run lib/eval/harbor` and `pnpm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `Import Harbor trials as run folders`.

### Task 6: The CLI command

**Files:**
- Modify: `scripts/agency.ts` (beside `evalCmd.command("upload")`, around `:1350`)
- Create: `lib/eval/harbor/formatImport.ts`
- Test: `lib/eval/harbor/formatImport.test.ts`
- Modify: `docs/dev/evals/eval-tracking.md` (a short "Importing Harbor jobs" section: the inputs, that the command never picks trials, how trials are numbered and scored, the spec's three examples, and that re-importing a smaller selection needs `<out>/<batch>` deleted first). Dev docs only.

**Interfaces:**
- Produces: `export function formatImportSummary(result: ImportResult): string[]`. It returns:
  1. one line per `failed` outcome and per problem;
  2. `<n> imported · <n> present · <n> scored · <n> void · <n> failed`;
  3. when `trialCounts` has more than one key, `uneven trials: 5 trials: 498 tests; 4 trials: 2 tests (A, B)`. Tests are listed only for the smaller groups, at most 10 per group, then `…`;
  4. `unknown exception types (counted as void): A, B` when there are any;
  5. `upload with: agency eval upload <uploadPath>`.
- `hasErrors(result: ImportResult): boolean` is true when there's any `failed` outcome or any problem.

- [ ] **Step 1: Write the failing tests:** `formatImportSummary` on a fixed `ImportResult` with uneven trials (exact lines), and `hasErrors` for a result with only problems.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/eval/harbor/formatImport.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement both, and register the command:**
  ```ts
  evalCmd.command("import-harbor", { hidden: true })
    .argument("[jobs...]")
    .option("--trials <file>")
    .requiredOption("--out <dir>")
    .option("--batch <name>")
    .option("--reasoning <level>")
  ```
  No job folders and no `--trials` is a usage error (exit 2). The command prints the summary and sets `process.exitCode = 1` when `hasErrors`. A missing `--batch` exits 2 with the error's message.
- [ ] **Step 4: Run** `pnpm exec vitest run lib/eval/harbor`, `pnpm run typecheck`, then `make`. Check `node dist/scripts/agency.js eval import-harbor --help`. Expected: tests pass, the help lists the options, and `eval --help` does **not** list `import-harbor`.
- [ ] **Step 5: Write the doc section, and commit** with the message `agency eval import-harbor`.

### Task 7: Check against real jobs

No code. This proves the ticket's "Done when".

- [ ] **Step 1: Import one job.** `node dist/scripts/agency.js eval import-harbor ~/bench-agency/jobs/k1-agency-minimal --out $TMPDIR/harbor`. Expected: 500 trials written, `failed` 0, and no uneven-trials line.
- [ ] **Step 2: Import five jobs as one batch.** `k1-agency-minimal` … `k5-agency-minimal` with `--batch k-agency-minimal`. Expected: no uneven-trials line, and `node dist/scripts/agency.js runs list $TMPDIR/harbor/k-agency-minimal` shows the batch with an accuracy.
- [ ] **Step 3: Import a hand-picked list.** Write a `--trials` file with three lines: test A's trial from `full-agency-6e9db1438-flash-high`, test A's rerun from `-flash-high-fixup`, and test B's trial from `full-agency-6e9db1438-flash-high`. Expected: A gets trials 1 and 2, B gets trial 1, and the uneven-trials line names B.
- [ ] **Step 4: Re-import steps 1 and 2.** Expected: `diff -r` against a copy shows nothing, and every trial is `present`.
- [ ] **Step 5: Upload `$TMPDIR/harbor/k-agency-minimal` to a local statelog**, following statelog `docs/dev/eval-tracking.md`, "Testing an upload locally". This requires statelog on an agency-lang build that includes Task 1. Point statelog at the local build if it isn't released yet. Expected: everything uploads, and the batch page shows an accuracy.
