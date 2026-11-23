# Harbor Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agency eval import-harbor <job>... --out <dir> [--batch] [--reasoning]` turns Harbor job folders into Agency run folders that `agency runs list` reads and `agency eval upload` sends to statelog (ADI-372).

**Architecture:** Three small modules under `lib/eval/harbor/`:
- a reader that parses each trial's `result.json` through one zod schema,
- a pure planner that maps trials to run-row fields, trial numbers and scores,
- a writer that applies the plan through `recordCompletedRun` and `recordGradingPass`.

The CLI only parses flags and prints the summary.

**Tech Stack:** TypeScript, zod, vitest, commander (`scripts/agency.ts`).

**Spec:** `packages/agency-lang/docs/superpowers/specs/2026-11-23-harbor-import-design.md`

## Global Constraints

- **ADI-370 must be merged first.** `RunPayload` and `RunAnnotationSchema` (`lib/runDirectory/annotations.ts`) must have optional `benchmark?: string` and `reasoning?: string`. If they don't, stop: this plan does not add them.
- All writes go through `recordCompletedRun` and `recordGradingPass` (`lib/runDirectory/mutations.ts`). Nothing else writes `annotations.jsonl` or `statelog.jsonl`.
- Run folder path: always `<out>/<batch>/<testId>/<trial>/`, even with one trial. (Unlike `runDirFor` in `runSuite.ts`, which drops the trial folder for a single trial, because a batch can gain trials later through `--batch`.)
- The `run` row's annotator is `{ kind: "harness", id: "harbor-import@<harnessVersion()>" }`. The score annotator is `{ kind: "grader", id: "harbor-verifier:<benchmark>" }`.
- Rule C, verbatim from the spec. Agent at fault (`AgentTimeoutError`, `RewardFileNotFoundError`, `NonZeroAgentExitCodeError`) with no reward: one binary score of 0. Any other exception with no reward: no score.
- Rewards come only from `result.json`'s `verifier_result.rewards`. That is Harbor's own copy of `reward.txt` and `reward.json`.
- Work happens in a worktree off `origin/main`. Run `pnpm run typecheck` (it includes `tsconfig.tests.json`) before every commit. Grading tests need `make` run once in a fresh worktree.

## Review Focus

1. **A trial folder with no `result.json`** (Harbor crashed mid-trial) is reported as a problem. The rest of the job still imports. Test in Task 2.
2. **Two trials of one task with the same `started_at`** must still get stable trial numbers on every re-import: ties break on the trial folder name. Test in Task 3.
3. **A trace file with two trace ids, or an unparseable line,** is refused by `recordCompletedRun`. That trial must be reported as failed, not crash the import. Test in Task 4.
4. **Re-importing with a different `--reasoning`** leaves runs already imported untouched, and the output says how many were already present. Test in Task 4.
5. **Job-level files** (`config.json`, `job.log`, `lock.json`, the job's own `result.json`) are never treated as trials: a trial is a subfolder holding `result.json`. Test in Task 2.

---

### Task 1: Share `harnessVersion`

**Files:**
- Create: `lib/eval/harnessVersion.ts`
- Modify: `lib/eval/run/runSuite.ts:664` (remove the private copy, import the shared one)
- Test: `lib/eval/harnessVersion.test.ts`

**Interfaces:**
- Produces: `export function harnessVersion(): string`. It is the same lookup as today: walk up from the module to the first `package.json` and return its `version`.

- [ ] **Step 1: Write the failing test.** `it("returns this package's version")`: expect `harnessVersion()` to equal `JSON.parse(fs.readFileSync(<packages/agency-lang/package.json>)).version`.
- [ ] **Step 2: Run it.** `pnpm exec vitest run lib/eval/harnessVersion.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Move the function into `lib/eval/harnessVersion.ts`, export it, and import it in `runSuite.ts`.**
- [ ] **Step 4: Run** `pnpm exec vitest run lib/eval/harnessVersion.test.ts lib/eval/run` and `pnpm run typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** with the message `Share harnessVersion with other eval harnesses`.

### Task 2: Read a Harbor job

**Files:**
- Create: `lib/eval/harbor/readJob.ts`
- Create: `lib/eval/harbor/testFixtures.ts` (`writeHarborTrial`)
- Test: `lib/eval/harbor/readJob.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type HarborTrial = {
    jobDir: string;          // absolute
    trialName: string;       // the trial folder's name
    testId: string;          // task_name after its first "/"
    benchmark: string;       // result.json `source`
    startedAt: string;       // ISO
    rewards: Record<string, number> | null;
    exception: { type: string; message: string } | null;
    statelogPath: string | null; // <trial>/agent/statelog.jsonl when it exists
  };
  export type HarborProblem = { path: string; reason: string };
  export function readHarborJob(jobDir: string): { trials: HarborTrial[]; problems: HarborProblem[] };
  ```
- `HarborResultSchema` (zod, private) reads only `task_name`, `source`, `started_at`, `verifier_result: { rewards: record<number> | null } | null`, and `exception_info: { exception_type, exception_message } | null`. Unknown keys pass (`z.looseObject`).
- Test helper: `writeHarborTrial(jobDir: string, trial: { name: string; taskName: string; source: string; startedAt: string; rewards: Record<string, number> | null; exception?: { type: string; message: string }; statelogLines?: string[] }): string`.

- [ ] **Step 1: Write the failing tests:**
  - `"reads every trial folder that holds a result.json"`: two trials plus job-level `config.json`, `job.log` and `result.json` give exactly 2 trials.
  - `"strips the source prefix from the task name"`: `swe-bench/astropy__astropy-12907` gives `testId: "astropy__astropy-12907"`.
  - `"reports a trial without result.json and keeps going"`: one good trial and one folder holding only `agent/` give 1 trial and 1 problem whose `reason` mentions `result.json`.
  - `"reports a result.json missing a field, naming the field"`: drop `task_name` and expect a problem whose `reason` contains `task_name`.
  - `"statelogPath is null when the trial has no trace"`.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/eval/harbor/readJob.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `readHarborJob`.** Sort trial folders by name, so the order is deterministic.
- [ ] **Step 4: Run it again, then `pnpm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `Read Harbor job folders for import`.

### Task 3: Plan the import (pure)

**Files:**
- Create: `lib/eval/harbor/planImport.ts`
- Test: `lib/eval/harbor/planImport.test.ts`

**Interfaces:**
- Consumes: `HarborTrial` (Task 2), `RunOutcome` and `Score` (`lib/runDirectory/annotations.ts`).
- Produces:
  ```ts
  export type PlannedScore = { name: string; score: Score };
  export type PlannedRun = {
    trial: HarborTrial;
    relativeDir: string;          // `${testId}/${trialNumber}`
    trialNumber: number;
    ended: RunOutcome;
    error?: string;               // `${type}: ${message}` when exception is set
    scores: PlannedScore[];       // [] = unscored
    unknownException?: string;    // an exception type outside both rule-C lists
  };
  export function planHarborImport({ jobs, batch, reasoning }: {
    jobs: HarborTrial[][];        // one array per job, in command-line order
    batch: string;
    reasoning?: string;
  }): { batch: string; reasoning?: string; runs: PlannedRun[] };
  export function endedOf(exceptionType: string | null): RunOutcome;
  export function scoresOf(rewards: Record<string, number> | null, exceptionType: string | null): PlannedScore[];
  ```

- [ ] **Step 1: Write the failing tests:**
  - `endedOf`: `null` gives `"ok"`, `AgentTimeoutError` gives `"timeout"`, `CancelledError` gives `"killed"`, and `DaytonaError` and an unknown type give `"error"`.
  - `scoresOf`:
    - `{reward: 1}` gives `[{name: "reward", score: {kind: "binary", pass: true}}]`.
    - `{reward: 0}` gives a binary fail.
    - `{reward: 0.5}` gives `{kind: "scalar", value: 0.5}`.
    - `{a: 1, b: 0}` gives two scores.
    - `(null, "AgentTimeoutError")`, `(null, "RewardFileNotFoundError")` and `(null, "NonZeroAgentExitCodeError")` each give one binary fail named `reward`.
    - `(null, "DaytonaError")`, `(null, "CancelledError")` and `(null, "SomethingNew")` each give `[]`.
    - `({reward: 1}, "AgentTimeoutError")` gives a pass: the reward wins.
  - Trial numbers:
    - One job with 3 trials of task A at `t2, t1, t3` gives trial numbers by time: `t1→1, t2→2, t3→3`.
    - Equal `startedAt` values break ties on `trialName`.
    - Two jobs `[[A@t5], [A@t1]]` give `1` for the first job and `2` for the second: numbering follows command-line order, not time, across jobs.
  - `relativeDir` is `"astropy__astropy-12907/1"`.
  - `unknownException` is set for `SomethingNew` and unset for every listed type.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/eval/harbor/planImport.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `endedOf`, `scoresOf` and `planHarborImport`.** The two rule-C lists are `const` arrays in this file.
- [ ] **Step 4: Run it again, then `pnpm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `Plan Harbor trials as Agency runs`.

### Task 4: Write the run folders

**Files:**
- Create: `lib/eval/harbor/importHarbor.ts`
- Test: `lib/eval/harbor/importHarbor.test.ts`

**Interfaces:**
- Consumes: `readHarborJob` (Task 2), `planHarborImport` (Task 3), `harnessVersion` (Task 1), `recordCompletedRun` and `recordGradingPass` (`mutations.ts`), `readTracesOrThrow` (`lib/runDirectory/traces.ts`), and `readRunDirectory` with `summarizeRunDirectory`.
- Produces:
  ```ts
  export type ImportOutcome =
    | { status: "imported" | "present" | "scored"; dir: string }
    | { status: "no-trace"; path: string }
    | { status: "failed"; path: string; error: string };
  export type ImportResult = {
    batch: string;
    outcomes: ImportOutcome[];
    problems: HarborProblem[];
    unscored: number;               // runs written with no score (infrastructure)
    unknownExceptions: string[];    // distinct, sorted
  };
  export function importHarborJobs({ jobDirs, outDir, batch, reasoning }: {
    jobDirs: string[]; outDir: string; batch?: string; reasoning?: string;
  }): ImportResult;
  ```
- **Batch:** `batch ?? path.basename(jobDirs[0])`. When there are several `jobDirs` and no batch, it throws `Error("import-harbor: several jobs need --batch")`.
- **Per planned run:**
  1. No `statelogPath`: `no-trace`.
  2. The folder exists with a `run` row: `present` if it has a complete grading pass or plans no scores. Otherwise call only `recordGradingPass`: `scored`.
  3. Otherwise, take `traceId` from `readTracesOrThrow(statelogPath)`, which must hold exactly one trace. Call `recordCompletedRun` with:
     - `test: { id }`, `suite: null`, `ended`, `error`,
     - `flags: { harborJob: jobDir, harborTrial: trialName }`,
     - `batch`, `trial`, `benchmark`, `reasoning`.

     Then call `recordGradingPass` if there are scores. Result: `imported`.
  4. Any throw: `failed` with the message. The loop continues.

- [ ] **Step 1: Write the failing tests** (temp dirs via `tempDir`, trials via `writeHarborTrial`, traces via `statelogLine` / `agentStartLine` from `lib/runDirectory/testFixtures.ts`):
  - `"imports a trial as a run folder that runs list reads"`: `summarizeRunDirectory` of `<out>/<batch>/<test>/1` gives `testId`, `batch`, `trial: 1`, `score: 1` and `status: "ok"`. The `run` row also has `benchmark` and `reasoning`.
  - `"a second import changes nothing"`: snapshot every file's bytes under `<out>`, import again, and expect identical bytes and every outcome `present`.
  - `"a run cut off before its scores gets only its scores"`: call `recordCompletedRun` by hand for the folder, then import. Expect outcome `scored` and a single `run` row.
  - `"an infrastructure failure is written unscored and counted"`: `DaytonaError` with no reward gives `unscored: 1`, the summary's `score: null` and `status: "failed"`.
  - `"a trace with two trace ids fails that trial only"`: two trials, one with a two-trace statelog. Expect one `failed` and one `imported`.
  - `"re-importing with another --reasoning leaves the run alone"`: import with `reasoning: "low"`, then `"high"`. Expect `present`, and the `run` row still says `low`.
  - `"several jobs without a batch throw"`.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/eval/harbor/importHarbor.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `importHarborJobs`.**
- [ ] **Step 4: Run** `pnpm exec vitest run lib/eval/harbor`, then `pnpm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `Import Harbor trials as run folders`.

### Task 5: The CLI command

**Files:**
- Modify: `scripts/agency.ts` (beside `evalCmd.command("upload")`, around `:1350`)
- Create: `lib/eval/harbor/formatImport.ts`
- Test: `lib/eval/harbor/formatImport.test.ts`
- Modify: `docs/dev/evals/eval-tracking.md` (a short "Importing Harbor jobs" section: the command, the batch rule, rule C, and that trials without a trace are skipped)

**Interfaces:**
- Consumes: `importHarborJobs` and `ImportResult` (Task 4).
- Produces: `export function formatImportSummary(result: ImportResult): string[]`. It returns one line per `failed` outcome and per problem, then one counts line: `<n> imported · <n> present · <n> scored · <n> no trace · <n> unscored · <n> failed`. If there are unknown exceptions, it adds `unknown exception types (unscored): A, B`. The last line is `upload with: agency eval upload <out>/<batch>`.

- [ ] **Step 1: Write the failing test** `formatImportSummary` against a fixed `ImportResult`, with the exact lines asserted.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/eval/harbor/formatImport.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it, and register the command:**
  ```ts
  evalCmd.command("import-harbor")
    .argument("<jobs...>")
    .requiredOption("--out <dir>")
    .option("--batch <name>")
    .option("--reasoning <level>")
  ```
  It prints `formatImportSummary(...)` and sets `process.exitCode = 1` when any outcome is `failed`. A thrown `several jobs need --batch` exits 2 with that message.
- [ ] **Step 4: Run** `pnpm exec vitest run lib/eval/harbor` and `pnpm run typecheck`, then `make` and `node dist/scripts/agency.js eval import-harbor --help`. Expected: tests pass, and the help lists `--out`, `--batch` and `--reasoning`.
- [ ] **Step 5: Write the doc section, and commit** with the message `agency eval import-harbor`.

### Task 6: Check against real jobs

No code. This proves the ticket's "Done when".

- [ ] **Step 1: Import one real job.** `node dist/scripts/agency.js eval import-harbor ~/bench-agency/jobs/k1-agency-minimal --out $TMPDIR/harbor`. Expected: about 500 imported, with `failed` at 0 and `no trace` matching the job's trials that lack `agent/statelog.jsonl`.
- [ ] **Step 2: Check the runs.** `node dist/scripts/agency.js runs list $TMPDIR/harbor/k1-agency-minimal | head`. Expected: score, cost and model are filled in. Spot-check that 3 runs' scores match their `verifier/reward.txt`.
- [ ] **Step 3: Re-import.** Copy the folder, run the same command, then `diff -r` against the copy. Expected: no differences, and the counts line shows only `present`.
- [ ] **Step 4: Merge jobs.** `--batch k-agency-minimal ~/bench-agency/jobs/k1-agency-minimal ~/bench-agency/jobs/k2-agency-minimal`. Expected: each test has `1/` and `2/` folders.
- [ ] **Step 5: Upload.** Upload `$TMPDIR/harbor/k1-agency-minimal` to a local statelog: `docs/dev/eval-tracking.md` in statelog, "Testing an upload locally". Expected: everything uploads, and the batch page shows the batch with its accuracy.
