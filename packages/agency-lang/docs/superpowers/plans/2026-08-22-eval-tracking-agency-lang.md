# Eval tracking, PR 1 of 4: the agency-lang side

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make suite runs repeatable, summarizable, and safely uploadable to statelog: repeated trials, durable batch/trial identity, agent naming, complete statistics, and one declarative cross-package summary contract.

**Architecture:** The run directory remains the source of truth. `eval run` records batch/trial identity; one pure summary derivation handles both traced and silent runs; batch functions partition and validate complete trial grids; and `eval upload` owns the imperative upload workflow behind one command-level operation. Statelog supplies canonical event and annotation rows to `summarizeEvalRun` and receives a complete summary—it does not reconstruct `RunDirectorySnapshot` or repeat score, status, cost, or timestamp logic.

**Tech Stack:** TypeScript, Vitest, Zod, vendored Commander, Agency, and the `statelogRequest` transport core.

**Spec:** `docs/superpowers/specs/2026-08-22-eval-tracking-pipeline-design.md` (v2). This plan implements agency-lang parts 1.1–1.6. Statelog API/storage/UI and CI remain later PRs.

The plan sharpens three spec seams:

1. The public summary is `summarizeEvalRun(input)`, not explorer-oriented `summarizeRuns(snapshot)`. Its input is canonical rows, so statelog never learns filesystem snapshot internals. `summarizeRunDirectory(snapshot)` is the local adapter. Both use one derivation and include a harness run with no events.
2. API-key upload creates an empty trace by posting `events: []` to bulk ingest because `POST /api/traces` is session-only. PR 2 must make the bulk route create the trace for an empty request.
3. The upload-state endpoint returns a discriminated state rather than ambiguous `{ count, maxSequence }`. Only a server-proven contiguous bulk prefix is resumable. Partial live, mixed, and gapped traces are refused.

## Global constraints

- Work only in `/Users/adityabhargava/agency-lang/worktree-eval-tracking/packages/agency-lang` on `adit/eval-tracking`; never commit on `main`.
- Save each test command's output under `$SCRATCH`; do not rerun an expensive test merely to recover output.
- Run only focused tests until Task 10. Run `make` in Task 10 because `stdlib/statelog.agency` changes.
- Types, not interfaces. Objects, not maps. Arrays, not sets. No dynamic imports or requires. No one-line `if` statements, nested ternaries, conditional object spreads, or single-character names.
- Agency syntax uses `def`, braces, parenthesized control-flow conditions, and declared variables.
- `docs/site/**` is generated; update stdlib source/docstrings and let `make` regenerate reference pages.
- Commits use a message file: write `msg.txt`, then `git commit -F msg.txt`.
- Do not push or open a PR without fresh explicit approval. Task 10 prepares review material and stops.

## File map

| File | Responsibility |
|---|---|
| `lib/runDirectory/annotations.ts` | Optional `batch` and positive `trial` on harness run rows |
| `lib/runDirectory/list.ts` | Complete summary types and the one traced/silent summary derivation |
| `lib/runsExplorer/rows.ts` | Explorer adapter over the shared summary |
| `lib/runDirectory/findRuns.ts` | Bounded group → test → trial discovery |
| `lib/eval/run/runSuite.ts` | Trial jobs, layout, and run-row identity |
| `lib/eval/batchStatistics.ts` | Batch partitioning, complete-grid validation, mean and SE |
| `lib/cli/eval/grade.ts`, `formatGrade.ts` | Per-batch grade summaries |
| `lib/statelog/agentName.ts` | Path-safe agent-name rule |
| `lib/agents/agency-agent/lib/agentName.agency` | Agency agent identity by brain |
| `lib/cli/statelog/evalUploadClient.ts` | Sealed upload-state/events/annotations transport |
| `lib/cli/eval/upload.ts` | Declarative command operation and private upload orchestration |
| `lib/eval/public.ts` | Narrow statelog-facing summary, statistics, and validation exports |

---

### Task 1: Complete summaries for traced and silent runs

**Files:**
- Modify: `lib/runDirectory/annotations.ts`, `lib/runDirectory/annotations.test.ts`
- Modify: `lib/runDirectory/list.ts`, `lib/runDirectory/list.test.ts`
- Modify: `lib/runsExplorer/rows.ts`, `lib/runsExplorer/rows.test.ts`
- Modify: `lib/eval/runDirectoryFixture.ts`

**Interfaces:**

```ts
export type EvalRunInput = {
  traceId: string;
  events: readonly EventEnvelope[];
  annotations: readonly Annotation[];
  /** Diagnostic identity only; summary code never reads this path. */
  source: string;
  notes?: string | null;
};

export type RunStatus = "ok" | "partial" | "failed" | "killed" | "trace";

export type RunSummary = {
  traceId: string;
  testId: string | null;
  input: string | null;
  agentName: string | null;
  agentLabel: string | null;
  startedAt: string | null;
  startedAtMs: number | null;
  endedAt: string | null;
  durationMs: number;
  costUsd: number;
  llmCalls: number;
  toolCalls: number;
  eventCount: number;
  models: string[];
  ended: string;
  status: RunStatus;
  latestScore: number | null;
  gradingPasses: number;
  gatesPassed: boolean | null;
  hasNotes: boolean;
  labeled: boolean;
  codeHash: string | null;
  batch: string | null;
  trial: number | null;
  suiteSource: string | null;
  suiteSha: string | null;
};

export function summarizeEvalRun(input: EvalRunInput): RunSummary;
export function summarizeRunDirectory(snapshot: RunDirectorySnapshot): RunSummary | null;
export function summarizeRuns(snapshot: RunDirectorySnapshot): RunSummary[];
```

- [ ] **Step 1: Add failing run-row schema tests**

Use the existing valid harness run draft in `annotations.test.ts`. Assert that a legacy row without the fields parses, a row with `batch: "batch-1"` and `trial: 2` preserves both, and `trial` values `0`, `-1`, and `1.5` throw.

- [ ] **Step 2: Add failing summary tests**

In `list.test.ts`, cover these exact cases:

- A normal fixture run reports its batch/trial, event count, `status: "ok"`, and the run row's `createdAt` as `endedAt`.
- Passing the same trace id, trace events, annotation rows, source, and notes to `summarizeEvalRun` equals `summarizeRunDirectory(snapshot)`.
- A fixture with `wroteStatelog: false` and `ended: "error"` returns one failed summary with zero events/cost/calls/duration and preserves test id, effective score, batch, trial, and run-row completion time.
- `summarizeRuns` returns that silent summary rather than `[]`; `buildRunsListing` counts it once.
- An event-only ad-hoc trace reports `status: "trace"` and its last event timestamp as `endedAt`.
- Mismatched event or annotation trace ids are rejected with both ids in the diagnostic.

In `rows.test.ts`, prove the explorer builds one failed test row for a silent run instead of an empty run.

- [ ] **Step 3: Run the focused tests and confirm failure**

Run: `pnpm exec vitest run lib/runDirectory/annotations.test.ts lib/runDirectory/list.test.ts lib/runsExplorer/rows.test.ts > $SCRATCH/task1-red.log 2>&1; tail -25 $SCRATCH/task1-red.log`
Expected: missing summary APIs/fields and the silent-run assertion fail.

- [ ] **Step 4: Add schema and fixture fields**

Add to `RunPayload` and `RunAnnotationSchema`:

```ts
  /** One invocation of a suite; absent on pre-batch directories. */
  batch?: string;
  /** This test's 1-based repetition within the batch. */
  trial?: number;
```

```ts
    batch: z.string().min(1).optional(),
    trial: z.number().int().positive().optional(),
```

Add the same optional fields to `FakeRun`. Assign `batch: run.batch` and `trial: run.trial` directly in its run draft; optional properties accept `undefined`, so do not use conditional object spreads.

- [ ] **Step 5: Implement one private derivation**

In `list.ts`, add the types above and implement both public adapters over one private `summarizeOne`. `summarizeEvalRun` folds annotations internally. `summarizeRunDirectory` selects the trace id from its sole trace or, for a silent run, from the sole effective harness run. Return `null` only when neither exists; reject multiple silent run ids.

```ts
export function summarizeRuns(snapshot: RunDirectorySnapshot): RunSummary[] {
  const summary = summarizeRunDirectory(snapshot);
  return summary === null ? [] : [summary];
}
```

`summarizeOne` uses `extractEvalRecord` when events exist and zero metrics otherwise. It applies these rules:

- `endedAt` is the harness run row's `createdAt`, else the last event timestamp, else null.
- `status` is `trace` without a harness row, `ok` for `ended === "ok"`, `killed` for `timeout`, `cost-cap`, or `killed` when events exist, and `failed` otherwise. `partial` stays in the shared status type for aggregate compatibility but a one-run summary does not emit it.
- `batch`, `trial`, suite identity, scores, gates, and labeling all come from the effective annotation fold.
- Every supplied event and annotation must match `input.traceId`.

Update `buildRunsListing`: `runCount` is `summaries.length`, and `silentRunCount` counts summaries with `eventCount === 0` and a harness ending. Update `buildRunRowFromDirectory` to use summary status/suite/agent data for both traced and silent runs; remove the trace-only run-row lookup that duplicates those derivations.

- [ ] **Step 6: Run focused tests**

Run: `pnpm exec vitest run lib/runDirectory/annotations.test.ts lib/runDirectory/list.test.ts lib/runsExplorer > $SCRATCH/task1-green.log 2>&1; tail -20 $SCRATCH/task1-green.log`
Expected: pass; silent runs appear exactly once and both summary adapters agree.

- [ ] **Step 7: Commit**

```bash
git add lib/runDirectory/annotations.ts lib/runDirectory/annotations.test.ts lib/runDirectory/list.ts lib/runDirectory/list.test.ts lib/runsExplorer/rows.ts lib/runsExplorer/rows.test.ts lib/eval/runDirectoryFixture.ts
git commit -F msg.txt
```

Commit message: `Run summaries: one derivation for traced and silent eval runs`.

---

### Task 2: Discover group → test → trial directories

**Files:**
- Modify: `lib/runDirectory/findRuns.ts`, `lib/runDirectory/findRuns.test.ts`
- Modify: `docs/dev/run-directory.md`

**Interface:** `findRunDirectories(targets: string[]): string[]` accepts a run directory, its run-directory children, or `<group>/<test>/<trial>`; traversal stops after grandchildren.

- [ ] **Step 1: Add failing discovery tests**

Create a group containing `a/1`, `a/2`, and flat run `b`; expect sorted `[a/1, a/2, b]`. Create `group/a/deeper/1`; expect the existing “holds no run directories” error. Keep duplicate/canonicalization tests unchanged.

- [ ] **Step 2: Run and confirm the nested test fails**

Run: `pnpm exec vitest run lib/runDirectory/findRuns.test.ts > $SCRATCH/task2-red.log 2>&1; tail -15 $SCRATCH/task2-red.log`
Expected: only the flat child is found.

- [ ] **Step 3: Implement bounded two-level discovery**

Keep the current physical-identity and sorting behavior. For each direct child: include it if it is a run directory; otherwise include only its direct children that are run directories. Do not recurse further and do not add symlink machinery. Use arrays throughout.

- [ ] **Step 4: Document and verify**

Update the reader contract in `docs/dev/run-directory.md` to name the bounded trial layout. Run: `pnpm exec vitest run lib/runDirectory/findRuns.test.ts > $SCRATCH/task2-green.log 2>&1; tail -10 $SCRATCH/task2-green.log`.
Expected: pass.

- [ ] **Step 5: Commit**

Commit `lib/runDirectory/findRuns.ts`, its test, and `docs/dev/run-directory.md` with message `Run directories: discover per-test trial directories`.

---

### Task 3: Run each test for `--trials k`

**Files:**
- Modify: `lib/eval/run/runSuite.ts`, `lib/eval/run/runSuite.test.ts`
- Modify: `lib/eval/runTypes.ts`
- Modify: `lib/cli/eval/run.ts`, `lib/cli/eval/run.test.ts`, `scripts/agency.ts`

**Interfaces:** `RunSuiteOptions.trials?: number` defaults to 1 and must be a finite positive integer. `SuiteTestResult.trial: number`. One trial keeps `<out>/<testId>`; multiple trials use `<out>/<testId>/<trial>`.

- [ ] **Step 1: Add failing layout and validation tests**

For two trials, assert relative paths `fib/1` and `fib/2`, the same batch basename, trial indices 1 and 2, and distinct trace ids using `expect(traceIds[0]).not.toBe(traceIds[1])`. For one trial, assert the flat layout and `trial: 1`. Call `runSuite` with `0`, `-1`, `1.5`, and `NaN`; each must reject before creating a run directory.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run lib/eval/run/runSuite.test.ts lib/cli/eval/run.test.ts > $SCRATCH/task3-red.log 2>&1; tail -25 $SCRATCH/task3-red.log`
Expected: missing trial fields/layout and API validation failures.

- [ ] **Step 3: Validate options and construct jobs**

```ts
type RunJob = { test: Test; trial: number };

function trialCount(value: number | undefined): number {
  const count = value ?? 1;
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 1) {
    throw new Error("trials must be a positive integer");
  }
  return count;
}
```

Build jobs in trial-major order so a pool sees `a/1, b/1, a/2, b/2`. Scheduling functions consume `RunJob[]`; `executeTest` derives labels, staging paths, and final paths from the job. Record `batch`, `trial`, and `flags.trials` on every harness row, including failures. Create the test parent before renaming a multi-trial staging directory.

- [ ] **Step 4: Wire the CLI flag**

Use existing `parsePositiveInt` in `scripts/agency.ts`:

```ts
.option(
  "--trials <count>",
  "Run every test this many times (default 1)",
  parsePositiveInt,
)
```

Pass the parsed value through `EvalRunCliOptions` to `runSuite`; do not rely on CLI validation as the library's validation.

- [ ] **Step 5: Verify and commit**

Run: `pnpm exec vitest run lib/eval/run/runSuite.test.ts lib/cli/eval/run.test.ts > $SCRATCH/task3-green.log 2>&1; pnpm run typecheck > $SCRATCH/task3-typecheck.log 2>&1; tail -10 $SCRATCH/task3-green.log; tail -5 $SCRATCH/task3-typecheck.log`.
Expected: pass and clean typecheck. Commit the five files with message `eval run: repeat every test as an identified trial`.

---

### Task 4: Partition and validate batch statistics

**Files:**
- Create: `lib/eval/batchStatistics.ts`, `lib/eval/batchStatistics.test.ts`

**Interfaces:**

```ts
export type TestStatistics = {
  testId: string;
  trials: number;
  mean: number | null;
  standardError: number | null;
  meanCostUsd: number;
  meanDurationMs: number;
};

export type BatchStatistics = {
  batch: string | null;
  tests: TestStatistics[];
  trials: number;
  accuracy: number | null;
  standardError: number | null;
  totalCostUsd: number;
  totalDurationMs: number;
};

export function batchStatistics(runs: readonly RunSummary[]): BatchStatistics;
export function batchStatisticsByBatch(runs: readonly RunSummary[]): BatchStatistics[];
```

- [ ] **Step 1: Write failing arithmetic and invariant tests**

Cover: one trial/no SE; three hand-calculated scores; paired trial means `[0.5, 0.5]` produce batch SE 0; duplicate or gapped indices identify the test; `a/1..3` with `b/1..2` is rejected as an incomplete grid; mixed batch ids are rejected by `batchStatistics`; `batchStatisticsByBatch` returns two groups when two batches reuse the same test/trial ids; each null batch is its own one-run group; unscored runs are omitted from means but included in totals; a scored silent summary contributes its score and zero metrics.

- [ ] **Step 2: Run and confirm the module is missing**

Run: `pnpm exec vitest run lib/eval/batchStatistics.test.ts > $SCRATCH/task4-red.log 2>&1; tail -10 $SCRATCH/task4-red.log`
Expected: module-not-found failure.

- [ ] **Step 3: Implement pure partitioning and statistics**

Use arrays and records. `batchStatisticsByBatch` groups equal non-null batch ids; a null batch starts a new group keyed by that run's trace id. `batchStatistics` refuses empty input, different batch ids, more than one null-batch run, duplicate indices, local gaps, and unequal `1..k` sets across tests. Only after validation compute per-test means and paired per-trial batch means. Use `meanValue`, not a single-character variable, in the sample-SE helper.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run lib/eval/batchStatistics.test.ts > $SCRATCH/task4-green.log 2>&1; tail -12 $SCRATCH/task4-green.log`.
Expected: all cases pass. Commit both files with message `Batch statistics: partition batches and require a complete trial grid`.

---

### Task 5: Grade and format multiple selected batches correctly

**Files:**
- Modify: `lib/cli/eval/grade.ts`, `lib/cli/eval/grade.test.ts`
- Modify: `lib/cli/eval/formatGrade.ts`, `lib/cli/eval/formatGrade.test.ts`

**Interface:** `EvalGradeResult` gains required `batches: BatchStatistics[]`; it contains each selected batch with more than one trial. Existing `mean` remains the mean over every graded run.

- [ ] **Step 1: Add failing format and command tests**

Assert one three-trial batch prints per-test `mean ± SE` and its final accuracy. Assert selecting two batch groups with the same test/trial ids yields two separate summaries and does not throw or merge them. Add a silent failed trial, grade it to zero, and assert the batch result includes that zero.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run lib/cli/eval/grade.test.ts lib/cli/eval/formatGrade.test.ts > $SCRATCH/task5-red.log 2>&1; tail -20 $SCRATCH/task5-red.log`
Expected: missing `batches` and merged/omitted results.

- [ ] **Step 3: Compute before constructing the result**

After grading, read every directory and call `summarizeRunDirectory`; discard only `null` (an empty non-run directory). Partition with `batchStatisticsByBatch`, then retain groups with `trials > 1`. Compute this array before constructing `EvalGradeResult`; do not create `result` and mutate a `batch` field later.

```ts
const summaries = runDirs.flatMap((dir) => {
  const summary = summarizeRunDirectory(readRunDirectory(dir, quiet));
  return summary === null ? [] : [summary];
});
const batches = batchStatisticsByBatch(summaries).filter((batch) => batch.trials > 1);
const result: EvalGradeResult = { runs, mean, gatesPassed, batches };
```

Format one batch as today. For multiple batches, prefix each block with `batch <batch id>` and preserve input order. Use braces on all conditions.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run lib/cli/eval/grade.test.ts lib/cli/eval/formatGrade.test.ts > $SCRATCH/task5-green.log 2>&1; tail -15 $SCRATCH/task5-green.log`.
Expected: separate batches and the silent zero pass. Commit the four files with message `eval grade: report complete trial statistics per batch`.

---

### Task 6: Validate path-safe agent names and name the Agency agent

**Files:**
- Create: `lib/statelog/agentName.ts`, `lib/statelog/agentName.test.ts`
- Modify: `lib/stdlib/statelog.ts`, `lib/stdlib/statelog.test.ts`, `stdlib/statelog.agency`
- Create: `lib/agents/agency-agent/lib/agentName.agency`
- Create: `lib/agents/agency-agent/tests/agentName.agency`, `lib/agents/agency-agent/tests/agentName.test.json`
- Modify: `lib/agents/agency-agent/agent.agency`

**Interfaces:** `AGENT_NAME_PATTERN`, `AGENT_NAME_MAX_LENGTH = 200`, and `agentNameProblem(name): string | null`. Names use letters, digits, `.`, `_`, `-`, and `/`; slash-delimited segments must be non-empty and may not be `.` or `..`.

- [ ] **Step 1: Write failing validator and stdlib tests**

Accept `agency-agent/coordinator` and `gcode.v2_1`. Reject empty, embedded or trailing whitespace (including `"agent\n"`), colon, over 200 characters, `.`, `..`, `a/./b`, `a/../b`, `/a`, `a/`, and `a//b`. For each accepted fixture, construct the eventual batch URL and assert the encoded name remains one route parameter rather than normalizing path segments. Assert `_setAgentName` rejects before reading runtime context and forwards one valid name inside `agencyStore.run`.

- [ ] **Step 2: Implement the rule**

Test the full alphabet, then split on `/` and reject empty/dot segments. Use block `if` statements. `_setAgentName` calls the validator before obtaining the frame and forwards the original string only when valid. Update the Agency docstring with both alphabet and segment rules.

- [ ] **Step 3: Add the Agency helper with the real type**

```agency
import { AgentBrain } from "../brains/brain.agency"

/** The agent family and the brain that drove this trace. */
export def agentNameFor(brain: AgentBrain): string {
  return "agency-agent/" + brain.name
}
```

Call `setAgentName(agentNameFor(brain))` immediately after `setBrain(brain)`. The Agency test resolves `coordinator` with `brainByName`, checks null with braces, and returns `agentNameFor(brain)`; its exact expected output is `"agency-agent/coordinator"`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run lib/statelog/agentName.test.ts lib/stdlib/statelog.test.ts > $SCRATCH/task6-ts.log 2>&1; pnpm run agency test lib/agents/agency-agent/tests/agentName.test.json > $SCRATCH/task6-agency.log 2>&1; pnpm run agency typecheck lib/agents/agency-agent/agent.agency > $SCRATCH/task6-typecheck.log 2>&1; tail -8 $SCRATCH/task6-ts.log; tail -8 $SCRATCH/task6-agency.log; tail -5 $SCRATCH/task6-typecheck.log`.
Expected: all pass. Commit all Task 6 files with message `Agent names: validate URL-safe segments and identify Agency brains`.

---

### Task 7: Seal the upload transport around a discriminated remote state

**Files:**
- Create: `lib/cli/statelog/evalUploadClient.ts`, `lib/cli/statelog/evalUploadClient.test.ts`

**Interfaces:**

```ts
export type RemoteTraceState =
  | { kind: "missing" }
  | { kind: "empty" }
  | { kind: "live"; eventCount: number }
  | { kind: "bulk-prefix"; eventCount: number; nextSequence: number }
  | { kind: "invalid"; eventCount: number; reason: string };

export type SequencedEvent = { sequence: number; envelope: EventEnvelope };

export type EvalUploadClient = {
  traceUploadState(traceId: string): Promise<RemoteTraceState>;
  postEvents(traceId: string, events: readonly SequencedEvent[]): Promise<void>;
  postAnnotations(rows: readonly Annotation[]): Promise<void>;
};

export const EVENTS_PER_REQUEST = 500;
export function createEvalUploadClient(
  origin: string,
  projectSlug: string,
  apiKey: string,
): EvalUploadClient;
```

PR 2's `GET /api/projects/:slug/traces/:traceId/upload-state` owns classification. `bulk-prefix` means the server proved all rows are sequenced exactly `0..nextSequence-1` and `eventCount === nextSequence`. Unsequenced-only rows are `live`; no log rows on an existing trace are `empty`; mixed, duplicate, or gapped sequences are `invalid` with a safe reason.

- [ ] **Step 1: Write failing client tests without copying fetch helpers**

Mock `statelogRequest` statically with Vitest and assert its structured arguments. Test every state variant through the Zod response schema, route encoding, 500-event limit, sequence-bearing bulk body, annotation body, and every `StatelogFailure` mapping. Do not copy response/last-request helpers from another client test; transport mechanics already belong to `statelogRequest.test.ts`.

- [ ] **Step 2: Run and confirm module-not-found**

Run: `pnpm exec vitest run lib/cli/statelog/evalUploadClient.test.ts > $SCRATCH/task7-red.log 2>&1; tail -10 $SCRATCH/task7-red.log`
Expected: module-not-found failure.

- [ ] **Step 3: Implement the sealed client**

Use a Zod discriminated union matching `RemoteTraceState`. Keep path construction, request envelopes, body shapes, and plain error mapping private to this file. Encode every path segment. `postEvents` rejects more than 500 before transport; an empty array is valid and creates an empty trace in PR 2.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run lib/cli/statelog/evalUploadClient.test.ts > $SCRATCH/task7-green.log 2>&1; tail -12 $SCRATCH/task7-green.log`.
Expected: pass. Commit both files with message `Eval upload client: expose safe remote trace states`.

---

### Task 8: Upload run directories safely

**Files:**
- Create: `lib/cli/eval/upload.ts`, `lib/cli/eval/upload.test.ts`
- Modify: `scripts/agency.ts`, `scripts/agency.test.ts`

**Interfaces:**

```ts
export type EvalUploadTarget = { origin: string; projectSlug: string; apiKey: string };
export type EvalUploadDependencies = {
  client?: EvalUploadClient;
  reportWarning?: (message: string) => void;
};
export type UploadRunOutcome =
  | { dir: string; traceId: string; status: "uploaded"; events: number; annotations: number }
  | { dir: string; traceId: string; status: "present"; serverEvents: number; fileEvents: number; annotations: number }
  | { dir: string; traceId: string; status: "resumed"; from: number; events: number; annotations: number }
  | { dir: string; traceId: string | null; status: "failed"; error: string };
export type EvalUploadResult = { runs: UploadRunOutcome[]; batchUrl: string | null };
export function evalUpload(
  targets: string[],
  target: EvalUploadTarget,
  dependencies?: EvalUploadDependencies,
): Promise<EvalUploadResult>;
export function formatUploadResult(result: EvalUploadResult): string[];
```

The private pure decision is:

```ts
type EventPlan =
  | { kind: "create-empty" }
  | { kind: "upload-all" }
  | { kind: "skip"; serverEvents: number }
  | { kind: "resume"; from: number }
  | { kind: "refuse"; reason: string };

function eventPlan(state: RemoteTraceState, fileEvents: number): EventPlan;
```

- [ ] **Step 1: Write exhaustive event-plan tests**

Assert: missing+empty file creates empty; missing+events uploads all; existing empty+empty skips; existing empty+events uploads all; equal live/file counts skip; partial or excess live counts refuse; equal bulk prefix skips; shorter bulk prefix resumes from `nextSequence`; longer bulk prefix refuses; every invalid state refuses and includes the server reason.

- [ ] **Step 2: Write orchestration tests**

Use a named fake `EvalUploadClient`. Cover 603 events as chunks 500/103 with sequences 0..602; resume from a proven bulk prefix; empty silent run posts `events: []` then its run/score annotations; partial live and invalid sequence states post neither events nor annotations and report failure; annotation failure does not stop the next directory; a second upload skips events but upserts annotations; batch URL appears only when all successful rows share one non-null batch and one valid agent name.

Keep one internal array of `{ snapshot, outcome }` records while processing. Do not pass parallel `outcomes` and `snapshots` arrays whose indices must remain aligned.

- [ ] **Step 3: Run and confirm failure**

Run: `pnpm exec vitest run lib/cli/eval/upload.test.ts > $SCRATCH/task8-red.log 2>&1; tail -15 $SCRATCH/task8-red.log`
Expected: module-not-found failure.

- [ ] **Step 4: Implement orchestration behind `evalUpload`**

Resolve paths with `uniqueRunDirectories(findRunDirectories(targets))`. Read each snapshot once. Resolve its trace id from the trace or effective harness row; reject a directory with neither. Ask for remote state, apply `eventPlan`, post selected chunks, then post all annotations. An error returns a failed outcome and processing continues. Annotations are never posted after a refused event state because that could summarize an incomplete remote trace.

Use `summarizeRunDirectory(snapshot)` for batch URL identity; do not reproduce agent/batch derivation. Before building a URL, call `agentNameProblem` because an older persisted trace may predate validation; return no batch URL for an invalid name. Encode both route values. Add a test with agent name `..` proving no misleading normalized URL is emitted.

- [ ] **Step 5: Register only the linked-project command**

```ts
evalCmd
  .command("upload")
  .description("Upload finished runs and grades to the linked statelog project")
  .argument("<paths...>", "Run directories, or directories of run directories")
  .action(async (paths: string[]) => {
    const target = resolveProjectTarget(getConfigContext(), {});
    const result = await evalUpload(paths, target);
    for (const line of formatUploadResult(result)) {
      console.log(line);
    }
    if (result.runs.some((run) => run.status === "failed")) {
      process.exitCode = 1;
    }
  });
```

Do not add `--host`, `--project`, or `--api-key-env`; linking and existing key resolution own target selection. Add a command-shape test proving those flags are unknown.

- [ ] **Step 6: Verify and commit**

Run: `pnpm exec vitest run lib/cli/eval/upload.test.ts scripts/agency.test.ts > $SCRATCH/task8-green.log 2>&1; pnpm run typecheck > $SCRATCH/task8-typecheck.log 2>&1; tail -15 $SCRATCH/task8-green.log; tail -5 $SCRATCH/task8-typecheck.log`.
Expected: pass and clean typecheck. Commit the three files with message `agency eval upload: safely upload complete run directories`.

---

### Task 9: Export a narrow declarative eval contract

**Files:**
- Modify: `lib/eval/public.ts`, `lib/eval/public.test.ts`

**Exports:** `summarizeEvalRun`, `RunSummary`, `RunStatus`, `EvalRunInput`; `batchStatistics`, `batchStatisticsByBatch`, statistics types; `AnnotationSchema`, `annotationId`, annotation types; `EventEnvelope`; agent-name constants and validator.

Do not export `RunDirectorySnapshot`, `readRunDirectory`, `readTraces`, `tracesFromText`, or `foldAnnotations` for statelog. Those are implementation details hidden by `summarizeEvalRun`. Existing exports for grader authors remain unchanged.

- [ ] **Step 1: Add a failing static export test**

At file scope use `import * as publicEval from "./public.js"`. Assert the runtime exports with `toHaveProperty`; use `expectTypeOf` for types. Never use `await import()`.

- [ ] **Step 2: Run and confirm missing exports**

Run: `pnpm exec vitest run lib/eval/public.test.ts > $SCRATCH/task9-red.log 2>&1; tail -10 $SCRATCH/task9-red.log`
Expected: missing summary/statistics exports.

- [ ] **Step 3: Add explicit static exports**

Use relative paths, matching the existing file. Export only the surface listed above. Keep the summary function as the sole path from canonical rows to derived eval values.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run lib/eval/public.test.ts > $SCRATCH/task9-green.log 2>&1; tail -10 $SCRATCH/task9-green.log`.
Expected: pass. Commit both files with message `agency-lang/eval: export the declarative eval tracking contract`.

---

### Task 10: Documentation, formatting, full build, and review handoff

**Files:**
- Create: `docs/dev/eval-tracking.md`
- Modify: `docs/dev/statelog-clients.md`, `docs/dev/eval-grading.md`, `CLAUDE.md`
- Generated by `make`: `docs/site/stdlib/statelog.md`

- [ ] **Step 1: Write developer documentation**

Document batch/trial rows and layout; complete trial grids and paired SE; the traced/silent summary invariant; `summarizeEvalRun` as the cross-package boundary; upload-state variants and why partial live/mixed/gapped traces are refused; events-before-annotations; empty trace creation; path-safe agent-name segments; and the narrow `agency-lang/eval` exports. State that statelog must not reconstruct `RunDirectorySnapshot` or reimplement summary arithmetic.

- [ ] **Step 2: Update pointers and client ledger**

Add the eval-tracking pointer to `CLAUDE.md`, add the seventh sealed client to `docs/dev/statelog-clients.md`, and describe trial output in `docs/dev/eval-grading.md`.

- [ ] **Step 3: Run formatter before the build**

Run: `pnpm run fmt:ts > $SCRATCH/fmt.log 2>&1; tail -5 $SCRATCH/fmt.log`.
Expected: formatter completes. This precedes `make` so the final build verifies formatted sources.

- [ ] **Step 4: Run structure checks, full build, and focused suites**

```bash
pnpm run lint:structure > $SCRATCH/lint.log 2>&1
make > $SCRATCH/make.log 2>&1
pnpm exec vitest run \
  lib/sourceIsText.test.ts \
  lib/runDirectory \
  lib/eval/batchStatistics.test.ts \
  lib/eval/run/runSuite.test.ts \
  lib/cli/eval \
  lib/cli/statelog/evalUploadClient.test.ts \
  lib/statelog/agentName.test.ts \
  lib/stdlib/statelog.test.ts \
  lib/runsExplorer \
  > $SCRATCH/final-tests.log 2>&1
tail -5 $SCRATCH/lint.log
tail -20 $SCRATCH/make.log
tail -20 $SCRATCH/final-tests.log
```

Expected: every command exits 0. Do not run the full Agency execution suite.

- [ ] **Step 5: Run plan-specific guards**

Inspect every changed/new source against `docs/dev/anti-patterns.md`. Specifically confirm: no copied transport derivation, parallel state arrays, conditional spreads, one-line `if`, nested inline boundary types, `Map`, `Set`, dynamic import, or duplicated summary/status arithmetic. Run:

```bash
git diff --check
pnpm exec vitest run lib/sourceIsText.test.ts > $SCRATCH/text-guard.log 2>&1
git diff --numstat main > $SCRATCH/numstat.log
if awk '$1 == "-" && $2 == "-" { found = 1 } END { exit found ? 0 : 1 }' $SCRATCH/numstat.log; then
  echo "binary files found in diff" >&2
  exit 1
fi
```

Expected: diff check and text guard pass; the guard finds no binary row.

- [ ] **Step 6: Commit docs and prepare—but do not publish—the review handoff**

Commit docs and generated stdlib reference with message `Docs: eval tracking boundaries and upload invariants`. Write `pr.md` describing behavior, the three clarified spec seams, tests, and PR 2 requirements. Show `git status --short` and stop. Do not push or invoke `gh pr create` until the user explicitly requests those external actions.

## Self-review against the spec and review findings

- Trials, layout, batch/trial rows, and API validation: Tasks 1–3.
- Complete per-batch means/SE, uneven-grid refusal, multi-batch grade selection, and silent-zero inclusion: Tasks 1, 4, and 5.
- Path-safe names and the real `AgentBrain` type: Task 6.
- Live-vs-bulk discrimination, contiguous resume, empty traces, idempotent annotations, and no extra target flags: Tasks 7 and 8.
- Complete status/timestamps and a non-leaky canonical-row summary API: Tasks 1 and 9.
- Static imports, named boundary types, immutable result construction, no copied helpers, and the catalog's concrete style rules: enforced in the relevant tasks and rechecked in Task 10.
- `suite.sha` remains unchanged and is surfaced through the shared summary.
- Package publication remains the owner's post-merge release; this plan neither publishes nor changes shared state.
