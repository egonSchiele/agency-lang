# Eval tracking, PR 1 of 4: the agency-lang side

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a suite run uploadable to statelog: repeated trials per test, a batch id and trial index on every run row, the agency agent naming itself with its brain, an `agency eval upload` command, and the public exports statelog will import.

**Architecture:** Everything sits on the run directory (`docs/dev/run-directory.md`): `eval run` writes more into the `run` row, `eval upload` reads directories through the existing reader and posts them through one new sealed statelog client, and the per-trace summary statelog needs already exists (`summarizeRuns` in `lib/runDirectory/list.ts`) and only gains two fields. No new concept gets a second definition: score, cost, and agent identity come from `RunSummary`; batch statistics are one pure function exported beside it.

**Tech Stack:** TypeScript, vitest, zod, commander (vendored), the `statelogRequest` transport core in `lib/cli/statelog/`.

**Spec:** `docs/superpowers/specs/2026-08-22-eval-tracking-pipeline-design.md` (v2). This plan covers its part 1 (1.1 through 1.6) plus the delivery step "publish a new package version". Parts 2 to 4 are separate PRs in statelog and a CI PR here.

Two places this plan deviates from the spec's wording, both because the code already had the thing under another name:

- The spec's `summarizeRun` "= `buildRunRowFromDirectory` under a new name" is really `summarizeRuns(snapshot): RunSummary[]` in `lib/runDirectory/list.ts`, which `buildRunRowFromDirectory` already calls. It is exported as is and gains `batch` and `trial`. No rename.
- The spec has the upload create an empty trace with `POST /api/traces`. That route is session-only (`isLoggedIn`), so an API key cannot use it. Instead the upload posts the bulk-logs request with `events: []`, and PR 2 makes the bulk route create the trace when it does not exist (log ingest already does this for single lines via `resolveLogTrace`). The client here sends exactly that.

## Global constraints

- Never commit on `main`; the branch is `adit/eval-tracking` in the worktree `/Users/adityabhargava/agency-lang/worktree-eval-tracking`. Work in `packages/agency-lang` there.
- Run only the tests named in each task, and save their output to a file under the scratchpad: `export SCRATCH=/private/tmp/claude-501/-Users-adityabhargava-agency-lang-packages-agency-lang/2b21e9d6-455c-4765-b6cd-8768684d9f8b/scratchpad` once, then `> $SCRATCH/<task>.log 2>&1` on every run. Do not run `make` until the end (Task 10), and `pnpm run typecheck` rather than a bare `tsc`.
- Commit messages go through a file (`git commit -F msg.txt`); apostrophes on the command line break.
- Types, not interfaces. Objects, not maps. Arrays, not sets. No dynamic imports. One concept per file. Comments short; none that restate the code.
- Agency syntax: `def name(params): Type { }`, `if (cond) { }`, `let`/`const` before assignment.
- `docs/site/**` is generated: never hand-edit it. `make` at the end regenerates stdlib docs because `stdlib/statelog.agency` changes.
- Before pushing: `pnpm run lint:structure`, `pnpm run fmt:ts`, the repo-wide text guard `pnpm exec vitest run lib/sourceIsText.test.ts`, and `git diff --numstat main | grep -- "-\s-"` must print nothing (no binary files).

## File map

| file | change |
|---|---|
| `lib/runDirectory/annotations.ts` | `RunPayload` gains `batch?: string`, `trial?: number`; schema accepts them |
| `lib/runDirectory/list.ts` | `RunSummary` gains `batch: string \| null`, `trial: number \| null` |
| `lib/runDirectory/findRuns.ts` | a group may be two levels deep (group → test → trial) |
| `lib/eval/run/runSuite.ts` | `trials` option; trial subdirectories; `batch`/`trial` on the run row |
| `lib/cli/eval/run.ts`, `scripts/agency.ts` | `--trials <k>` flag |
| `lib/eval/batchStatistics.ts` (new) | `batchStatistics(summaries)`: per-test and batch mean ± SE, trial-index checks |
| `lib/cli/eval/formatGrade.ts`, `lib/cli/eval/grade.ts` | print `mean ± se (k trials)` per test and for the batch when trials > 1 |
| `lib/statelog/agentName.ts` (new) | `AGENT_NAME_PATTERN`, `agentNameProblem(name)` |
| `lib/stdlib/statelog.ts`, `stdlib/statelog.agency` | `_setAgentName` validates; docstring states the rule |
| `lib/agents/agency-agent/lib/agentName.agency` (new), `agent.agency` | `agentNameFor(brain)`; called after `setBrain` |
| `lib/cli/statelog/evalUploadClient.ts` (new) | sealed client: events-count, bulk logs, annotations |
| `lib/cli/eval/upload.ts` (new), `scripts/agency.ts` | `agency eval upload <paths…>` |
| `lib/eval/public.ts` | exports `summarizeRuns`, `batchStatistics`, readers, `annotationId`, `AnnotationSchema`, `AGENT_NAME_PATTERN` |
| `docs/dev/eval-tracking.md` (new), `docs/dev/statelog-clients.md`, `CLAUDE.md` | dev notes |

---

### Task 1: `batch` and `trial` on the `run` row and in `RunSummary`

**Files:**
- Modify: `lib/runDirectory/annotations.ts` (the `RunPayload` type near line 86 and `RunAnnotationSchema` near line 179)
- Modify: `lib/runDirectory/list.ts` (`RunSummary` and `summarizeTrace`)
- Test: `lib/runDirectory/annotations.test.ts`, `lib/runDirectory/list.test.ts`

**Interfaces:**
- Produces: `RunPayload.batch?: string`, `RunPayload.trial?: number` (positive integer); `RunSummary.batch: string | null`, `RunSummary.trial: number | null`.

- [ ] **Step 1: Write the failing schema tests**

In `lib/runDirectory/annotations.test.ts`, find the existing `describe` for run rows (search for `kind: "run"`) and add, reusing whatever helper the file already uses to build a valid run draft (if there is none, build one inline as below):

```ts
describe("run row batch and trial", () => {
  const runDraft = {
    traceId: "t1",
    annotator: { kind: "harness" as const, id: "agency-eval@1" },
    kind: "run" as const,
    test: { id: "fib" },
    suite: null,
    ended: "ok" as const,
    flags: {},
  };

  it("accepts a row without batch or trial (older directories)", () => {
    const row = completeAnnotation(runDraft, "2026-08-22T00:00:00.000Z");
    expect(row.kind).toBe("run");
  });

  it("keeps batch and trial when present", () => {
    const row = completeAnnotation(
      { ...runDraft, batch: "2026-08-22-191537-1M1cHC", trial: 2 },
      "2026-08-22T00:00:00.000Z",
    );
    expect(row.kind === "run" && row.batch).toBe("2026-08-22-191537-1M1cHC");
    expect(row.kind === "run" && row.trial).toBe(2);
  });

  it("rejects trial 0 and a non-integer trial", () => {
    expect(() => completeAnnotation({ ...runDraft, trial: 0 }, "2026-08-22T00:00:00.000Z")).toThrow();
    expect(() => completeAnnotation({ ...runDraft, trial: 1.5 }, "2026-08-22T00:00:00.000Z")).toThrow();
  });
});
```

In `lib/runDirectory/list.test.ts` (create it if absent, next to `list.ts`), using `writeRunDirectory` from `lib/eval/runDirectoryFixture.ts` and `readRunDirectory`:

```ts
import { describe, expect, it } from "vitest";
import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";
import { readRunDirectory } from "./runDir.js";
import { summarizeRuns } from "./list.js";

const quiet = { reportWarning: () => {} };

describe("summarizeRuns batch and trial", () => {
  it("reports null batch and trial for a run row without them", () => {
    const dir = writeRunDirectory({ test: { id: "fib", input: "x" }, output: "ok" });
    const [summary] = summarizeRuns(readRunDirectory(dir, quiet));
    expect(summary.batch).toBeNull();
    expect(summary.trial).toBeNull();
  });

  it("reports batch and trial from the run row", () => {
    const dir = writeRunDirectory({
      test: { id: "fib", input: "x" },
      output: "ok",
      batch: "b-1",
      trial: 3,
    });
    const [summary] = summarizeRuns(readRunDirectory(dir, quiet));
    expect(summary.batch).toBe("b-1");
    expect(summary.trial).toBe(3);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run lib/runDirectory/annotations.test.ts lib/runDirectory/list.test.ts > $SCRATCH/task1-red.log 2>&1; tail -30 $SCRATCH/task1-red.log`
Expected: the `trial: 0` test fails (the strict schema rejects unknown keys, so the "keeps batch and trial" test fails too), and the list tests fail on `batch` being `undefined` / the fixture not accepting `batch`.

- [ ] **Step 3: Extend the payload type, the schema, the summary, and the fixture**

`lib/runDirectory/annotations.ts`, in `RunPayload` after `flags`:

```ts
  /** The `eval run` invocation this run belongs to (the group directory's
   *  basename). Absent on directories written before batches existed. */
  batch?: string;
  /** Which repetition of the test this run is, from 1. Absent means 1. */
  trial?: number;
```

In `RunAnnotationSchema`, after `error: z.string().optional(),`:

```ts
    batch: z.string().min(1).optional(),
    trial: z.number().int().positive().optional(),
```

`lib/runDirectory/list.ts`, in `RunSummary` after `codeHash`:

```ts
  /** From the run row; null for a directory written before batches existed. */
  batch: string | null;
  trial: number | null;
```

and in `summarizeTrace`'s returned object:

```ts
    batch: runRow?.batch ?? null,
    trial: runRow?.trial ?? null,
```

`lib/eval/runDirectoryFixture.ts`: add to `FakeRun`:

```ts
  batch?: string;
  trial?: number;
```

and pass them into the run payload in `writeRunDirectory` where the `run` row is built (search for `kind: "run"` in that file):

```ts
        ...(run.batch === undefined ? {} : { batch: run.batch }),
        ...(run.trial === undefined ? {} : { trial: run.trial }),
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm exec vitest run lib/runDirectory/annotations.test.ts lib/runDirectory/list.test.ts lib/runsExplorer > $SCRATCH/task1-green.log 2>&1; tail -15 $SCRATCH/task1-green.log`
Expected: all pass (the explorer suite is included because `RunSummary` gained fields; a snapshot-style assertion there would surface here).

- [ ] **Step 5: Commit**

```bash
git add lib/runDirectory/annotations.ts lib/runDirectory/annotations.test.ts lib/runDirectory/list.ts lib/runDirectory/list.test.ts lib/eval/runDirectoryFixture.ts
git commit -F msg.txt   # "Run row: optional batch id and trial index"
```

---

### Task 2: `findRunDirectories` walks group → test → trial

**Files:**
- Modify: `lib/runDirectory/findRuns.ts`
- Test: `lib/runDirectory/findRuns.test.ts`

**Interfaces:**
- Consumes nothing new. Produces: `findRunDirectories(paths)` returns trial run directories two levels under a group; a directory three levels deep is still an error.

Background: today a group yields its direct children that are run directories. With trials, `<group>/<test>/` holds no `statelog.jsonl`; its children `<group>/<test>/1/`, `/2/` do. The rule becomes: a directory that is not a run directory yields its run-directory children, plus the run-directory grandchildren of any child that is itself neither a run directory nor empty of them. Depth stops there.

- [ ] **Step 1: Write the failing tests**

In `lib/runDirectory/findRuns.test.ts`, add (the file already has `tempDir`/mkdir helpers; reuse them, else use `tempDir` from `./testFixtures.js`):

```ts
describe("findRunDirectories with trial subdirectories", () => {
  function runDirAt(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "statelog.jsonl"), "");
    return dir;
  }

  it("yields a group's trial directories two levels down, sorted", () => {
    const group = tempDir("group-");
    const a1 = runDirAt(path.join(group, "a", "1"));
    const a2 = runDirAt(path.join(group, "a", "2"));
    const b = runDirAt(path.join(group, "b")); // a flat k=1 test beside a trial test
    expect(findRunDirectories([group])).toEqual([a1, a2, b]);
  });

  it("does not descend three levels", () => {
    const group = tempDir("group-");
    runDirAt(path.join(group, "a", "1", "deep"));
    expect(() => findRunDirectories([group])).toThrow(/holds no run directories/);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run lib/runDirectory/findRuns.test.ts > $SCRATCH/task2-red.log 2>&1; tail -20 $SCRATCH/task2-red.log`
Expected: the first test fails (only `b` found, then "holds no run directories" is not thrown for the group... actually `b` is found so no throw; the array mismatches). The second passes already; keep it as the depth pin.

- [ ] **Step 3: Implement**

Replace `childRunDirectories` and the group branch in `findRunDirectories`:

```ts
/** A group's runs: run-directory children, and for a child that is not a
 *  run directory, its run-directory children (a test's trials). Two levels,
 *  never more: `runs/` must not mean every run ever. */
export function childRunDirectories(dir: string): string[] {
  const found: string[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const child = path.join(dir, name);
    if (isRunDirectory(child)) {
      found.push(child);
      continue;
    }
    if (!fs.statSync(child).isDirectory() || name === ".staging") continue;
    for (const grandName of fs.readdirSync(child).sort()) {
      const grand = path.join(child, grandName);
      if (isRunDirectory(grand)) found.push(grand);
    }
  }
  return found;
}
```

Update the file's top comment: "yields those children, sorted, ONE level down" becomes "yields run directories one level down, and a test's trial directories two levels down (`<group>/<testId>/<trial>/`)". Also update `docs/dev/run-directory.md`'s sentence "a directory of run directories yields its children (one level, sorted)" to say two levels for trials.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run lib/runDirectory/findRuns.test.ts lib/cli/eval/grade.test.ts lib/runsExplorer/sources.test.ts > $SCRATCH/task2-green.log 2>&1; tail -15 $SCRATCH/task2-green.log`
Expected: pass. (`grade` and the explorer's `discoverSources` both go through this walk.)

- [ ] **Step 5: Commit**

```bash
git add lib/runDirectory/findRuns.ts lib/runDirectory/findRuns.test.ts docs/dev/run-directory.md
git commit -F msg.txt   # "findRunDirectories: a test's trial directories are two levels down"
```

---

### Task 3: `eval run --trials k`

**Files:**
- Modify: `lib/eval/run/runSuite.ts` (`RunSuiteOptions`, `executeTest`, `runSequential`/`runPool` inputs, `foldIntoRunDirectory`, `printLiveStatelogPaths`)
- Modify: `lib/cli/eval/run.ts` (`EvalRunCliOptions.trials`, pass through), `scripts/agency.ts` (the `eval run` command, near line 860)
- Test: `lib/eval/run/runSuite.test.ts`

**Interfaces:**
- Produces: `RunSuiteOptions.trials?: number` (default 1). Run directories at `<out>/<testId>/` for 1 trial, `<out>/<testId>/<n>/` for more. Every run row carries `batch` (the group basename) and `trial`. `SuiteTestResult` gains `trial: number`.

Design inside `runSuite`: the scheduling functions take a list of **jobs**, not tests. A job is `{ test, trial }`; for k = 1 the list is the tests; for k > 1 it is every test repeated k times, trial-major order (`a/1, b/1, a/2, b/2`) so a parallel pool spreads trials over time instead of running the same test three times back to back. `executeTest(job, …)` derives the run directory from the job.

- [ ] **Step 1: Write the failing test**

In `lib/eval/run/runSuite.test.ts`, after the first test, add:

```ts
  it("--trials 2 writes <out>/<test>/1 and /2 with the same batch and distinct trace ids", async () => {
    const out = path.join(proj, "runs", "batch-x");
    const runner = traceWritingRunner("done");
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "fib", input: "go" }],
        out,
        trials: 2,
        progress: false,
        perRun: { pipeOutput: false },
      },
      { runner },
    );
    expect(result.tests.map((t) => [t.testId, t.trial, path.relative(out, t.runDir)])).toEqual([
      ["fib", 1, path.join("fib", "1")],
      ["fib", 2, path.join("fib", "2")],
    ]);
    const rows = result.tests.map((t) => {
      const snapshot = readRunDirectory(t.runDir, quiet);
      const run = snapshot.effectiveAnnotations[t.traceId]?.run;
      return run !== null && run !== undefined && run.kind === "run" ? run : null;
    });
    expect(rows.map((r) => r?.batch)).toEqual(["batch-x", "batch-x"]);
    expect(rows.map((r) => r?.trial)).toEqual([1, 2]);
    expect(new Set(result.tests.map((t) => t.traceId)).size).toBe(2);
  });

  it("one trial keeps the flat layout and still records batch and trial 1", async () => {
    const out = path.join(proj, "runs", "batch-y");
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "fib", input: "go" }],
        out,
        progress: false,
        perRun: { pipeOutput: false },
      },
      { runner: traceWritingRunner("done") },
    );
    expect(path.relative(out, result.tests[0].runDir)).toBe("fib");
    const snapshot = readRunDirectory(result.tests[0].runDir, quiet);
    const run = snapshot.effectiveAnnotations[result.tests[0].traceId]?.run;
    expect(run !== null && run !== undefined && run.kind === "run" && run.batch).toBe("batch-y");
    expect(run !== null && run !== undefined && run.kind === "run" && run.trial).toBe(1);
  });
```

(`new Set` is fine inside a test; the "arrays not sets" rule is for library code.)

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run lib/eval/run/runSuite.test.ts > $SCRATCH/task3-red.log 2>&1; tail -30 $SCRATCH/task3-red.log`
Expected: type error on `trials` / `trial`, or the layout assertion fails.

- [ ] **Step 3: Implement in `runSuite.ts`**

Add to `RunSuiteOptions`:

```ts
  /** Run every test this many times (default 1). Above 1, each trial's run
   *  directory is `<out>/<testId>/<trial>/`. */
  trials?: number;
```

Add to `SuiteTestResult` in `lib/eval/runTypes.ts`:

```ts
  /** Which repetition this was, from 1. */
  trial: number;
```

In `runSuite`, after `parallel` is computed:

```ts
  const trials = Math.max(1, Math.floor(opts.trials ?? 1));
  const batch = path.basename(groupDir);
  const jobs: RunJob[] = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    for (const test of opts.inputs) jobs.push({ test, trial });
  }
```

with, at module level:

```ts
/** One execution: a test and which repetition of it. */
type RunJob = { test: Test; trial: number };

/** Where a job's run directory lives: flat for a single trial, so nothing
 *  that reads `<group>/<testId>/` changes; nested per trial otherwise. */
function runDirFor(groupDir: string, testId: string, trial: number, trials: number): string {
  return trials === 1
    ? path.join(groupDir, testId)
    : path.join(groupDir, testId, String(trial));
}
```

Change `executeTest` to take `(job: RunJob, pipeOutput, onStarted?)`: `const { test, trial } = job;`, `runDir = runDirFor(groupDir, testId, trial, trials)`, staging dir and assembled dir names get a trial suffix when `trials > 1` (`${testId}-${trial}`) so two trials of one test never share staging; the "already exists" check stays on `runDir`; `testIdProblem` keeps validating `testId` against `path.join(groupDir, testId)` (the test's slot, not the trial's). For `trials > 1`, `fs.mkdirSync(path.dirname(runDir), { recursive: true })` before `renameSync`. Pass `batch` and `trial` into `foldIntoRunDirectory` and from there into the payload:

```ts
        batch: args.batch,
        trial: args.trial,
```

Return `trial` in every `SuiteTestResult` (including the error results).

`runSequential` and `runPool` take `jobs: RunJob[]` instead of `tests`; their labels become `labelFor(job)` = `test.id` for one trial, `${test.id}/${trial}` otherwise; the status board is started with those labels; `printLiveStatelogPaths` iterates jobs the same way. `flags` gains `trials`. Update the doc comment on `runSuite` to mention trials.

- [ ] **Step 4: Wire the flag**

`lib/cli/eval/run.ts`: add `trials?: number;` to `EvalRunCliOptions` with the doc comment `/** --trials: run every test this many times (default 1). */`, and pass `trials: opts.trials` into `runSuite`. `scripts/agency.ts`, the `eval run` command, after the `-n, --parallel` option:

```ts
    .option(
      "--trials <count>",
      "Run every test this many times (default 1); each trial is its own run directory at <out>/<test>/<n>/",
      parsePositiveInt,
    )
```

and add `trials?: number;` to the action's `opts` type.

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run lib/eval/run/runSuite.test.ts lib/cli/eval/run.test.ts > $SCRATCH/task3-green.log 2>&1; tail -15 $SCRATCH/task3-green.log; pnpm run typecheck > $SCRATCH/task3-tc.log 2>&1; tail -5 $SCRATCH/task3-tc.log`
Expected: pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add lib/eval/run/runSuite.ts lib/eval/run/runSuite.test.ts lib/eval/runTypes.ts lib/cli/eval/run.ts scripts/agency.ts
git commit -F msg.txt   # "eval run --trials: repeat every test, one run directory per trial"
```

---

### Task 4: `batchStatistics`

**Files:**
- Create: `lib/eval/batchStatistics.ts`, `lib/eval/batchStatistics.test.ts`

**Interfaces:**
- Consumes: `RunSummary` from `lib/runDirectory/list.ts` (`testId`, `trial`, `latestScore`, `costUsd`, `durationMs`).
- Produces:

```ts
export type TestStatistics = {
  testId: string;
  trials: number;
  /** Mean of the trials' scores; null when no trial has a score. */
  mean: number | null;
  /** Standard error of the mean; null with fewer than 2 scored trials. */
  standardError: number | null;
  meanCostUsd: number;
  meanDurationMs: number;
};
export type BatchStatistics = {
  tests: TestStatistics[];
  trials: number;
  /** Mean over tests of the per-test means. */
  accuracy: number | null;
  /** SE over the per-trial batch means (trial 1's mean over tests, trial 2's, …). */
  standardError: number | null;
  totalCostUsd: number;
  totalDurationMs: number;
};
export function batchStatistics(runs: readonly RunSummary[]): BatchStatistics;
```

Rules: a run without `testId` is skipped. `trial` null means 1. For each test, the trial indices must be exactly `1..n` with no repeats; otherwise throw `Error("test <id>: trial indices <list> are not 1..n")`. `trials` is the largest n over tests; a test with fewer trials than the batch is fine (its missing trials just do not contribute to that trial's batch mean). Sample standard deviation (n − 1) divided by √n; `null` when n < 2. An unscored run (`latestScore === null`) is excluded from means but still counted in cost and time.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import type { RunSummary } from "@/runDirectory/list.js";
import { batchStatistics } from "./batchStatistics.js";

function run(testId: string, trial: number, score: number | null, costUsd = 1): RunSummary {
  return {
    traceId: `${testId}-${trial}`,
    testId,
    input: null,
    agentName: "a",
    agentLabel: null,
    startedAt: null,
    startedAtMs: null,
    durationMs: 1000,
    costUsd,
    llmCalls: 1,
    toolCalls: 0,
    models: [],
    ended: "ok",
    latestScore: score,
    gradingPasses: 1,
    gatesPassed: null,
    hasNotes: false,
    labeled: false,
    codeHash: null,
    batch: "b",
    trial,
  };
}

describe("batchStatistics", () => {
  it("one trial: means, no standard error", () => {
    const stats = batchStatistics([run("a", 1, 1), run("b", 1, 0)]);
    expect(stats.trials).toBe(1);
    expect(stats.accuracy).toBe(0.5);
    expect(stats.standardError).toBeNull();
    expect(stats.tests.map((t) => [t.testId, t.mean, t.standardError])).toEqual([
      ["a", 1, null],
      ["b", 0, null],
    ]);
    expect(stats.totalCostUsd).toBe(2);
  });

  it("three trials: per-test mean and SE by hand", () => {
    // a: 1, 0, 1 → mean 2/3, sd = sqrt(((1/3)^2*2 + (2/3)^2)/2) = 0.57735, se = 0.33333
    const stats = batchStatistics([run("a", 1, 1), run("a", 2, 0), run("a", 3, 1)]);
    expect(stats.tests[0].mean).toBeCloseTo(2 / 3, 6);
    expect(stats.tests[0].standardError).toBeCloseTo(1 / 3, 6);
  });

  it("batch SE pairs runs by trial index: [1,0] and [0,1] give SE 0", () => {
    const stats = batchStatistics([run("a", 1, 1), run("a", 2, 0), run("b", 1, 0), run("b", 2, 1)]);
    expect(stats.accuracy).toBe(0.5);
    expect(stats.standardError).toBe(0);
  });

  it("refuses a duplicated trial index and a gap, naming the test", () => {
    expect(() => batchStatistics([run("a", 1, 1), run("a", 1, 0)])).toThrow(/test a: trial indices 1, 1/);
    expect(() => batchStatistics([run("a", 1, 1), run("a", 3, 0)])).toThrow(/test a: trial indices 1, 3/);
  });

  it("treats a null trial as 1 and skips unscored runs in the means", () => {
    const stats = batchStatistics([{ ...run("a", 1, null), trial: null }, run("b", 1, 1)]);
    expect(stats.tests[0].mean).toBeNull();
    expect(stats.accuracy).toBe(1);
    expect(stats.totalCostUsd).toBe(2);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run lib/eval/batchStatistics.test.ts > $SCRATCH/task4-red.log 2>&1; tail -5 $SCRATCH/task4-red.log`
Expected: module not found.

- [ ] **Step 3: Implement**

```ts
// Mean and standard error over a batch's runs, computed from RunSummary rows
// and never stored. The batch SE pairs runs by trial index (spec 1.1), so
// the index is validated first rather than trusted.
import type { RunSummary } from "@/runDirectory/list.js";

export type TestStatistics = { /* as in Interfaces */ };
export type BatchStatistics = { /* as in Interfaces */ };

export function batchStatistics(runs: readonly RunSummary[]): BatchStatistics {
  const byTest: Record<string, RunSummary[]> = Object.create(null);
  const order: string[] = [];
  for (const run of runs) {
    if (run.testId === null) continue;
    if (byTest[run.testId] === undefined) {
      byTest[run.testId] = [];
      order.push(run.testId);
    }
    byTest[run.testId].push(run);
  }
  const tests = order.map((testId) => testStatistics(testId, byTest[testId]));
  const trials = Math.max(0, ...tests.map((test) => test.trials));
  const perTrialMeans: number[] = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    const scores = order.flatMap((testId) => {
      const run = byTest[testId].find((entry) => trialOf(entry) === trial);
      return run === undefined || run.latestScore === null ? [] : [run.latestScore];
    });
    if (scores.length > 0) perTrialMeans.push(mean(scores));
  }
  const testMeans = tests.flatMap((test) => (test.mean === null ? [] : [test.mean]));
  return {
    tests,
    trials,
    accuracy: testMeans.length === 0 ? null : mean(testMeans),
    standardError: standardError(perTrialMeans),
    totalCostUsd: runs.reduce((sum, run) => sum + run.costUsd, 0),
    totalDurationMs: runs.reduce((sum, run) => sum + run.durationMs, 0),
  };
}

function testStatistics(testId: string, runs: RunSummary[]): TestStatistics {
  const indices = runs.map(trialOf).sort((a, b) => a - b);
  const expected = indices.map((_, i) => i + 1);
  if (indices.some((index, i) => index !== expected[i])) {
    throw new Error(`test ${testId}: trial indices ${indices.join(", ")} are not 1..${indices.length}`);
  }
  const scores = runs.flatMap((run) => (run.latestScore === null ? [] : [run.latestScore]));
  return {
    testId,
    trials: runs.length,
    mean: scores.length === 0 ? null : mean(scores),
    standardError: standardError(scores),
    meanCostUsd: mean(runs.map((run) => run.costUsd)),
    meanDurationMs: mean(runs.map((run) => run.durationMs)),
  };
}

function trialOf(run: RunSummary): number {
  return run.trial ?? 1;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample standard deviation over √n; null below two values. */
function standardError(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) / Math.sqrt(values.length);
}
```

(Write the two type declarations out in full in the file; the comment placeholders above only avoid repeating the Interfaces block.)

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run lib/eval/batchStatistics.test.ts > $SCRATCH/task4-green.log 2>&1; tail -8 $SCRATCH/task4-green.log`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/eval/batchStatistics.ts lib/eval/batchStatistics.test.ts
git commit -F msg.txt   # "batchStatistics: mean and standard error over a batch, paired by trial"
```

---

### Task 5: `eval grade` prints `mean ± se (k trials)`

**Files:**
- Modify: `lib/cli/eval/grade.ts` (`EvalGradeResult` gains `batch?: BatchStatistics`), `lib/cli/eval/formatGrade.ts`
- Test: `lib/cli/eval/formatGrade.test.ts`, `lib/cli/eval/grade.test.ts`

**Interfaces:**
- Consumes: `batchStatistics`, `summarizeRuns`, `readRunDirectory`.
- Produces: `EvalGradeResult.batch?: BatchStatistics`, present when any graded run has `trial > 1`. Output lines when present: per test `fib  score 0.667 ± 0.333 (3 trials)` replacing the per-run blocks' repetition, and a final `accuracy 0.833 ± 0.167 over 2 tests × 3 trials, $21.40`.

Behaviour: `evalGrade` grades every run directory as today (per-run blocks still print, each labelled `fib/2` when trials > 1, using the run row's `trial`). After grading, it reads each directory's snapshot, collects `summarizeRuns`, and if any summary has `trial !== null && trial > 1`, sets `result.batch = batchStatistics(summaries)`. `formatGradeResult` appends, when `result.batch` is present, one line per test and the accuracy line in place of the `mean … over N runs` line.

- [ ] **Step 1: Write the failing tests**

In `lib/cli/eval/formatGrade.test.ts` (create if absent), build an `EvalGradeResult` with a `batch` field and assert the lines:

```ts
import { describe, expect, it } from "vitest";
import { formatGradeResult } from "./formatGrade.js";
import type { EvalGradeResult } from "./grade.js";

describe("formatGradeResult with trials", () => {
  it("prints per-test mean ± se and the batch accuracy", () => {
    const result: EvalGradeResult = {
      runs: [],
      mean: 0.5,
      gatesPassed: true,
      batch: {
        trials: 3,
        accuracy: 0.8333,
        standardError: 0.1667,
        totalCostUsd: 21.4,
        totalDurationMs: 60_000,
        tests: [
          { testId: "fib", trials: 3, mean: 0.6667, standardError: 0.3333, meanCostUsd: 2, meanDurationMs: 1 },
          { testId: "news", trials: 3, mean: 1, standardError: 0, meanCostUsd: 5, meanDurationMs: 1 },
        ],
      },
    };
    const lines = formatGradeResult(result).map((line) => line.replace(/\[[0-9;]*m/g, ""));
    expect(lines).toContain("fib   score 0.667 ± 0.333 (3 trials)");
    expect(lines).toContain("news  score 1.000 ± 0.000 (3 trials)");
    expect(lines.at(-1)).toBe("accuracy 0.833 ± 0.167 over 2 tests × 3 trials, $21.40");
  });
});
```

In `lib/cli/eval/grade.test.ts`, add a test that writes a group with `writeRunGroup` of two trials (`trial: 1`, `trial: 2` under `<group>/fib/1` and `/2`; use `writeRunDirectory(run, path.join(group, "fib", "1"))` twice since `writeRunGroup` lays out flat) with a grading module the file already uses, then asserts `result.batch?.trials === 2` and `result.batch?.tests[0].testId === "fib"`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run lib/cli/eval/formatGrade.test.ts lib/cli/eval/grade.test.ts > $SCRATCH/task5-red.log 2>&1; tail -20 $SCRATCH/task5-red.log`
Expected: type error on `batch`.

- [ ] **Step 3: Implement**

`grade.ts`: import `batchStatistics`, `BatchStatistics`, `summarizeRuns`, `readRunDirectory`. Add `batch?: BatchStatistics;` to `EvalGradeResult` with the doc comment `/** Present when the runs include more than one trial of a test. */`. After the grading loop:

```ts
  const summaries = runDirs.flatMap((dir) =>
    summarizeRuns(readRunDirectory(dir, { reportWarning: () => {} })),
  );
  if (summaries.some((summary) => summary.trial !== null && summary.trial > 1)) {
    result.batch = batchStatistics(summaries);
  }
```

(build `result` as a `let`/object first, then attach). `formatGrade.ts`: in `formatGroupSummary`, when `result.batch` is present return `formatBatch(result.batch)` instead:

```ts
function formatBatch(batch: BatchStatistics): string[] {
  const width = Math.max(...batch.tests.map((test) => test.testId.length));
  const lines = batch.tests.map(
    (test) =>
      `${ttyColor.green(test.testId.padEnd(width))}  score ${meanWithError(test.mean, test.standardError)} (${test.trials} trials)`,
  );
  lines.push(
    `accuracy ${meanWithError(batch.accuracy, batch.standardError)} over ${batch.tests.length} tests × ${batch.trials} trials, $${batch.totalCostUsd.toFixed(2)}`,
  );
  return lines;
}

function meanWithError(mean: number | null, se: number | null): string {
  if (mean === null) return "not graded";
  return se === null ? formatScore(mean) : `${formatScore(mean)} ± ${se.toFixed(3)}`;
}
```

Check what `formatScore` produces (`lib/eval/grading/gradeBreakdown.ts:110`); the test above assumes three decimals with colour, which the regex strips. Adjust the expected strings to `formatScore`'s real format if it differs, not the other way round.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run lib/cli/eval/formatGrade.test.ts lib/cli/eval/grade.test.ts > $SCRATCH/task5-green.log 2>&1; tail -10 $SCRATCH/task5-green.log`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add lib/cli/eval/grade.ts lib/cli/eval/formatGrade.ts lib/cli/eval/formatGrade.test.ts lib/cli/eval/grade.test.ts
git commit -F msg.txt   # "eval grade: mean ± standard error per test when a batch has trials"
```

---

### Task 6: agent names are validated; the agency agent names itself

**Files:**
- Create: `lib/statelog/agentName.ts`, `lib/statelog/agentName.test.ts`
- Modify: `lib/stdlib/statelog.ts` (`_setAgentName`), `stdlib/statelog.agency` (the `setAgentName` docstring)
- Create: `lib/agents/agency-agent/lib/agentName.agency`, `lib/agents/agency-agent/tests/agentName.agency`, `lib/agents/agency-agent/tests/agentName.test.json`
- Modify: `lib/agents/agency-agent/agent.agency` (after `setBrain(brain)`, line ~103)
- Test: `lib/stdlib/statelog.test.ts` (create if absent)

**Interfaces:**
- Produces: `AGENT_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/`, `AGENT_NAME_MAX_LENGTH = 200`, `agentNameProblem(name: string): string | null` (null when valid, else the message). `_setAgentName` throws `Error(agentNameProblem(name))` before touching the frame. Agency: `agentNameFor(brain: Brain): string` returns `"agency-agent/" + brain.name`.

- [ ] **Step 1: Write the failing tests**

`lib/statelog/agentName.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { agentNameProblem } from "./agentName.js";

describe("agentNameProblem", () => {
  it("accepts hierarchical names", () => {
    expect(agentNameProblem("agency-agent/coordinator")).toBeNull();
    expect(agentNameProblem("gcode.v2_1")).toBeNull();
  });
  it("rejects whitespace, empty, other characters, and over-long names", () => {
    expect(agentNameProblem("my agent")).toMatch(/letters, digits/);
    expect(agentNameProblem("")).toMatch(/empty/);
    expect(agentNameProblem("a:b")).toMatch(/letters, digits/);
    expect(agentNameProblem("a".repeat(201))).toMatch(/200/);
  });
});
```

`lib/stdlib/statelog.test.ts`: a test that `_setAgentName("bad name")` rejects (it is async) with the rule, and that `_setAgentName("ok/name")` inside a frame calls the client. For the frame, follow how other `lib/stdlib/*.test.ts` files enter `agencyStore` (search for `agencyStore.run(`); the minimum is:

```ts
const agentName = vi.fn(async () => {});
const frame = { ctx: { statelogClient: { agentName } }, threads: { activeId: () => null } } as unknown as AgencyStore;
await agencyStore.run(frame, () => _setAgentName("agency-agent/simple"));
expect(agentName).toHaveBeenCalledWith({ name: "agency-agent/simple" });
await expect(_setAgentName("bad name")).rejects.toThrow(/letters, digits/);
```

Agency test `lib/agents/agency-agent/tests/agentName.agency`:

```
import { agentNameFor } from "../lib/agentName.agency"
import { brainByName } from "../brains/registry.agency"

node coordinatorName() {
  const brain = brainByName("coordinator")
  if (brain == null) {
    return "no brain"
  }
  return agentNameFor(brain)
}
```

`agentName.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "coordinatorName",
      "input": "",
      "expectedOutput": "\"agency-agent/coordinator\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

Check `brainByName`'s return type in `brains/registry.agency` and `Brain` in `brains/brain.agency` before writing the import; the `null` check mirrors `agent.agency:97`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run lib/statelog/agentName.test.ts lib/stdlib/statelog.test.ts > $SCRATCH/task6-red.log 2>&1; tail -10 $SCRATCH/task6-red.log`
Expected: module not found / no rejection.

- [ ] **Step 3: Implement**

`lib/statelog/agentName.ts`:

```ts
// The rule for agent names. Statelog puts a name in a URL path segment and
// in a filter, so the alphabet is small and whitespace is out. Exported to
// statelog through agency-lang/eval so both sides reject the same names.
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;
export const AGENT_NAME_MAX_LENGTH = 200;

/** Null when the name is allowed, else why not. */
export function agentNameProblem(name: string): string | null {
  if (name === "") return "agent name is empty";
  if (name.length > AGENT_NAME_MAX_LENGTH) {
    return `agent name is longer than ${AGENT_NAME_MAX_LENGTH} characters`;
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    return `agent name "${name}" may only use letters, digits, ".", "_", "-" and "/"`;
  }
  return null;
}
```

`lib/stdlib/statelog.ts`, `_setAgentName`:

```ts
export async function _setAgentName(name: string): Promise<void> {
  const problem = agentNameProblem(String(name));
  if (problem !== null) throw new Error(problem);
  const frame = agencyStore.getStore();
  if (!frame) return;
  await frame.ctx.statelogClient.agentName({ name: String(name) });
}
```

`stdlib/statelog.agency`, the `setAgentName` docstring: add one line, `Letters, digits, ".", "_", "-" and "/" only, no spaces, at most 200 characters; anything else throws.`

`lib/agents/agency-agent/lib/agentName.agency`:

```
import { Brain } from "../brains/brain.agency"

/** The name a trace records for this agent: the agent, then the brain that
 *  drove it, so runs of two brains group separately. */
export def agentNameFor(brain: Brain): string {
  return "agency-agent/" + brain.name
}
```

(Confirm `Brain` is exported from `brains/brain.agency` and that `brain.name` exists; adjust the import path if the type lives elsewhere.)

`agent.agency`: add `import { setAgentName } from "std::statelog"` and `import { agentNameFor } from "./lib/agentName.agency"`, and after `setBrain(brain)`:

```
  setAgentName(agentNameFor(brain))
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run lib/statelog/agentName.test.ts lib/stdlib/statelog.test.ts > $SCRATCH/task6-green.log 2>&1; tail -8 $SCRATCH/task6-green.log; pnpm run agency test lib/agents/agency-agent/tests/agentName.test.json > $SCRATCH/task6-agency.log 2>&1; tail -8 $SCRATCH/task6-agency.log; pnpm run agency typecheck lib/agents/agency-agent/agent.agency > $SCRATCH/task6-tc.log 2>&1; tail -5 $SCRATCH/task6-tc.log`
Expected: all pass; typecheck reports no new diagnostics (pre-existing ones in other agent files are not yours).

- [ ] **Step 5: Commit**

```bash
git add lib/statelog/agentName.ts lib/statelog/agentName.test.ts lib/stdlib/statelog.ts lib/stdlib/statelog.test.ts stdlib/statelog.agency lib/agents/agency-agent/lib/agentName.agency lib/agents/agency-agent/tests/agentName.agency lib/agents/agency-agent/tests/agentName.test.json lib/agents/agency-agent/agent.agency
git commit -F msg.txt   # "Agent names: validated at setAgentName; the agency agent names itself by brain"
```

---

### Task 7: the sealed upload client

**Files:**
- Create: `lib/cli/statelog/evalUploadClient.ts`, `lib/cli/statelog/evalUploadClient.test.ts`

**Interfaces:**
- Consumes: `statelogRequest` and `StatelogFailure` from `./statelogRequest.js`; `EventEnvelope` from `@/statelog/wireTypes.js`; `Annotation` from `@/runDirectory/annotations.js`.
- Produces:

```ts
export type TraceEvents = { count: number; maxSequence: number | null };
export class EvalUploadError extends Error { readonly status: number | undefined; }
export type EvalUploadClient = {
  /** `{ count: 0, maxSequence: null }` for a trace the project does not have. */
  traceEvents(traceId: string): Promise<TraceEvents>;
  /** Posts one chunk; `events` may be empty (creates the trace). */
  postEvents(traceId: string, events: { sequence: number; envelope: EventEnvelope }[]): Promise<void>;
  postAnnotations(rows: Annotation[]): Promise<void>;
};
export const EVENTS_PER_REQUEST = 500;
export function createEvalUploadClient(origin: string, projectSlug: string, apiKey: string): EvalUploadClient;
```

Routes (the spec's 2.3, which PR 2 implements): `GET /api/projects/:slug/traces/:traceId/events` → envelope `{ success, value: { count, maxSequence } }`; `POST /api/projects/:slug/logs/bulk` with body `{ trace_id, events: [{ sequence, ...envelope }] }`; `POST /api/projects/:slug/annotations` with body `{ rows }`. Path segments are `encodeURIComponent`-ed, like `secretsClient.routeUrl`. Failures map to `EvalUploadError` with plain messages: `unreachable` → `Could not reach <origin> (<cause>).`; `http` with `serverError` → that text, else `HTTP <status>`; `non-json` → its diagnostic; `bad-envelope` → `Unexpected response from statelog (HTTP <status>).`; `envelope-error` → the server's error text. `postEvents` throws if given more than `EVENTS_PER_REQUEST` events (a programmer error; the command chunks).

- [ ] **Step 1: Write the failing tests**

Model on `secretsClient.test.ts` (its `response`, `nonJsonResponse`, `lastRequest`, `vi.stubGlobal("fetch", …)` helpers; copy them into this file, they are ten lines):

```ts
describe("evalUploadClient", () => {
  it("traceEvents GETs the events route and returns the counts", async () => {
    fetchMock.mockResolvedValueOnce(response(200, { success: true, value: { count: 12, maxSequence: 11 } }));
    await expect(client().traceEvents("t/1")).resolves.toEqual({ count: 12, maxSequence: 11 });
    expect(lastRequest().url).toBe("https://h/api/projects/proj/traces/t%2F1/events");
    expect(lastRequest().init.method).toBe("GET");
  });

  it("postEvents POSTs the bulk route with sequence on every event", async () => {
    fetchMock.mockResolvedValueOnce(response(200, { success: true, value: { inserted: 2 } }));
    await client().postEvents("t1", [
      { sequence: 0, envelope: envelopeFor("t1", "agentStart") },
      { sequence: 1, envelope: envelopeFor("t1", "agentEnd") },
    ]);
    const body = JSON.parse(String(lastRequest().init.body));
    expect(lastRequest().url).toBe("https://h/api/projects/proj/logs/bulk");
    expect(body.trace_id).toBe("t1");
    expect(body.events.map((e: { sequence: number }) => e.sequence)).toEqual([0, 1]);
    expect(body.events[0].data.type).toBe("agentStart");
  });

  it("postEvents refuses more than 500 events", async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ sequence: i, envelope: envelopeFor("t1", "x") }));
    await expect(client().postEvents("t1", many)).rejects.toThrow(/500/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("postAnnotations POSTs the rows and maps a server error to EvalUploadError", async () => {
    fetchMock.mockResolvedValueOnce(response(200, { success: false, error: "annotation id does not match its content" }));
    const failure = await failureOf(client().postAnnotations([]));
    expect(failure.message).toBe("annotation id does not match its content");
    expect(lastRequest().url).toBe("https://h/api/projects/proj/annotations");
  });

  it("maps unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const failure = await failureOf(client().traceEvents("t1"));
    expect(failure.message).toBe("Could not reach https://h (ECONNREFUSED).");
  });
});
```

with `envelopeFor(traceId, type): EventEnvelope` = `{ format_version: 1, trace_id: traceId, project_id: "proj", span_id: null, parent_span_id: null, data: { type, timestamp: "2026-08-22T00:00:00.000Z" } }` and `client()` = `createEvalUploadClient("https://h", "proj", API_KEY)`. Check the exact `cause` text `statelogRequest` puts in an `unreachable` failure (read `statelogRequest.ts` around the fetch `catch`) and match it.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run lib/cli/statelog/evalUploadClient.test.ts > $SCRATCH/task7-red.log 2>&1; tail -5 $SCRATCH/task7-red.log`
Expected: module not found.

- [ ] **Step 3: Implement**

```ts
// The statelog eval-upload API, sealed here: the events-count read, the bulk
// log ingest, and the annotations write (spec 2.3). Route paths, body shapes
// and failure wording live in this file and nowhere else.
import { z } from "zod";
import type { Annotation } from "@/runDirectory/annotations.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";
import { statelogRequest } from "./statelogRequest.js";
import type { StatelogFailure } from "./statelogRequest.js";

export const EVENTS_PER_REQUEST = 500;

export type TraceEvents = { count: number; maxSequence: number | null };

export class EvalUploadError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export type EvalUploadClient = { /* as in Interfaces */ };

const traceEventsSchema: z.ZodType<TraceEvents> = z.object({
  count: z.number().int().nonnegative(),
  maxSequence: z.number().int().nonnegative().nullable(),
});

export function createEvalUploadClient(origin: string, projectSlug: string, apiKey: string): EvalUploadClient {
  function routeUrl(segments: string[]): string {
    const path = ["api", "projects", projectSlug, ...segments].map(encodeURIComponent).join("/");
    return new URL(`/${path}`, origin).toString();
  }
  async function request(method: "GET" | "POST", segments: string[], body?: unknown): Promise<unknown> {
    const result = await statelogRequest({ method, url: routeUrl(segments), apiKey, body });
    if (!result.ok) throw failureError(result.failure, origin);
    return result.value;
  }
  return {
    async traceEvents(traceId) {
      const value = await request("GET", ["traces", traceId, "events"]);
      const parsed = traceEventsSchema.safeParse(value);
      if (!parsed.success) throw new EvalUploadError("Unexpected events response from statelog.");
      return parsed.data;
    },
    async postEvents(traceId, events) {
      if (events.length > EVENTS_PER_REQUEST) {
        throw new Error(`postEvents takes at most ${EVENTS_PER_REQUEST} events per request`);
      }
      await request("POST", ["logs", "bulk"], {
        trace_id: traceId,
        events: events.map((event) => ({ sequence: event.sequence, ...event.envelope })),
      });
    },
    async postAnnotations(rows) {
      await request("POST", ["annotations"], { rows });
    },
  };
}

function failureError(failure: StatelogFailure, origin: string): EvalUploadError {
  switch (failure.kind) {
    case "unreachable":
      return new EvalUploadError(`Could not reach ${origin} (${failure.cause}).`);
    case "non-json":
      return new EvalUploadError(failure.diagnostic, failure.status);
    case "http":
      return new EvalUploadError(failure.serverError ?? `HTTP ${failure.status}`, failure.status);
    case "bad-envelope":
      return new EvalUploadError(`Unexpected response from statelog (HTTP ${failure.status}).`, failure.status);
    case "envelope-error":
      return new EvalUploadError(failure.serverError ?? `HTTP ${failure.status}`, failure.status);
  }
}
```

Write the `EvalUploadClient` type out in full.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run lib/cli/statelog/evalUploadClient.test.ts > $SCRATCH/task7-green.log 2>&1; tail -8 $SCRATCH/task7-green.log`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/cli/statelog/evalUploadClient.ts lib/cli/statelog/evalUploadClient.test.ts
git commit -F msg.txt   # "evalUploadClient: sealed client for the statelog eval upload routes"
```

---

### Task 8: `agency eval upload <paths…>`

**Files:**
- Create: `lib/cli/eval/upload.ts`, `lib/cli/eval/upload.test.ts`
- Modify: `scripts/agency.ts` (register after `grade`, near line 975)

**Interfaces:**
- Consumes: `createEvalUploadClient`, `EvalUploadError`, `EVENTS_PER_REQUEST`; `findRunDirectories`, `uniqueRunDirectories`; `readRunDirectory`; `resolveProjectTarget` and `RemoteCommandContext`, `ProjectCommandOptions` from `lib/cli/remote/commands/util.ts`.
- Produces:

```ts
export type UploadRunOutcome =
  | { dir: string; traceId: string; status: "uploaded"; events: number; annotations: number }
  | { dir: string; traceId: string; status: "present"; serverEvents: number; fileEvents: number; annotations: number }
  | { dir: string; traceId: string; status: "resumed"; from: number; events: number; annotations: number }
  | { dir: string; traceId: string | null; status: "failed"; error: string };
export type EvalUploadResult = { runs: UploadRunOutcome[]; batchUrl: string | null };
export async function evalUpload(
  targets: string[],
  target: { origin: string; projectSlug: string; apiKey: string },
  deps?: { client?: EvalUploadClient; reportWarning?: (message: string) => void },
): Promise<EvalUploadResult>;
export function formatUploadResult(result: EvalUploadResult): string[];
```

Per run directory, in order:
1. `readRunDirectory`. A directory with no trace and no `run` annotation is `failed` ("nothing to upload"). The trace id is the single trace's id, or when the statelog is empty, the `run` row's `traceId` (there is at most one `run` row; `annotationRows.find(r => r.kind === "run")`).
2. `traceEvents(traceId)` → `{count, maxSequence}`. Let `fileEvents = trace?.events.length ?? 0`.
   - `fileEvents === 0`: `postEvents(traceId, [])` (creates the trace), then annotations. Outcome `uploaded` with `events: 0`.
   - `count === 0`: post every chunk of `EVENTS_PER_REQUEST` with `sequence` = index in `trace.events`. Outcome `uploaded`.
   - `count === fileEvents`: skip events. Outcome `present`.
   - `0 < count < fileEvents`: post from `sequence = (maxSequence ?? -1) + 1` onward. Outcome `resumed` with `from`.
   - `count > fileEvents`: `failed` ("server has more events (N) than the file (M); refusing to guess").
3. `postAnnotations(snapshot.annotationRows)` (all rows, including `run`; the server upserts). An error here makes the run `failed` even if events went up.
4. Any `EvalUploadError` (or other error) → `failed` with its message; the loop continues with the next directory.

`batchUrl`: when every non-failed run's `run` row shares one `batch` and an `agentName` can be read from the trace (`summarizeRuns(snapshot)[0].agentName`), `${origin}/projects/${slug}/evals/agents/${encodeURIComponent(agentName)}/batches/${encodeURIComponent(batch)}`; else null. (Matches the page routes PR 3 adds.)

`formatUploadResult`: one line per run, `<relative dir>  uploaded 640 events, 4 annotations` / `…  trace already on server (640 events, 640 in file), uploaded 4 annotations` / `…  resumed from event 301: 339 events, 4 annotations` / red `…  failed: <error>`; then `batch: <url>` when present; then `N of M runs failed` in red when any did. Relative dir = `path.relative(process.cwd(), dir)`.

- [ ] **Step 1: Write the failing tests**

`lib/cli/eval/upload.test.ts`, with a fake client (`{ traceEvents: vi.fn(), postEvents: vi.fn(), postAnnotations: vi.fn() }`) injected through `deps.client`, directories written with `writeRunDirectory` / `writeRunGroup` (`lib/eval/runDirectoryFixture.ts`), and a trace of more than 500 events for the chunk test (write the statelog yourself: `finishedTraceLines` plus 600 `statelogLine(traceId, "toolStart", {...})` lines before `agentEnd`, via `fs.writeFileSync(runDirPaths(dir).statelog, …)` after `writeRunDirectory`):

```ts
describe("evalUpload", () => {
  it("uploads a fresh trace in 500-event chunks with sequences, then the annotations", async () => {
    // 603 events → chunks of 500 and 103; sequences 0..602
    ...
    expect(client.postEvents).toHaveBeenCalledTimes(2);
    expect(client.postEvents.mock.calls[0][1].map((e) => e.sequence).slice(0, 2)).toEqual([0, 1]);
    expect(client.postEvents.mock.calls[1][1].at(-1).sequence).toBe(602);
    expect(client.postAnnotations).toHaveBeenCalledTimes(1);
    expect(result.runs[0]).toMatchObject({ status: "uploaded", events: 603 });
  });

  it("skips the events when the server already has them all", async () => {
    client.traceEvents.mockResolvedValue({ count: 4, maxSequence: 3 });
    ...
    expect(client.postEvents).not.toHaveBeenCalled();
    expect(result.runs[0]).toMatchObject({ status: "present", serverEvents: 4, fileEvents: 4 });
    expect(client.postAnnotations).toHaveBeenCalledTimes(1);
  });

  it("resumes after the last stored sequence", async () => {
    client.traceEvents.mockResolvedValue({ count: 2, maxSequence: 1 });
    ...  // a 4-event trace
    expect(client.postEvents.mock.calls[0][1].map((e) => e.sequence)).toEqual([2, 3]);
    expect(result.runs[0]).toMatchObject({ status: "resumed", from: 2, events: 2 });
  });

  it("creates the trace for an empty statelog and uploads the run row", async () => {
    const dir = writeRunDirectory({ test: { id: "dead", input: "x" }, wroteStatelog: false, ended: "error", errorMessage: "died" });
    client.traceEvents.mockResolvedValue({ count: 0, maxSequence: null });
    ...
    expect(client.postEvents).toHaveBeenCalledWith("trace-1", []);
    expect(result.runs[0]).toMatchObject({ status: "uploaded", events: 0, annotations: 1 });
  });

  it("an annotation failure marks the run failed and the other runs still upload", async () => {
    client.postAnnotations.mockRejectedValueOnce(new EvalUploadError("nope")).mockResolvedValue(undefined);
    ...  // a group of two runs
    expect(result.runs.map((r) => r.status)).toEqual(["failed", "uploaded"]);
  });

  it("formats the outcomes and the batch url", () => {
    const lines = formatUploadResult({
      runs: [{ dir: "/g/fib/1", traceId: "t", status: "uploaded", events: 640, annotations: 4 }],
      batchUrl: "https://h/projects/p/evals/agents/agency-agent%2Fcoordinator/batches/b",
    }).map(stripAnsi);
    expect(lines[0]).toMatch(/fib\/1\s+uploaded 640 events, 4 annotations/);
    expect(lines.at(-1)).toBe("batch: https://h/projects/p/evals/agents/agency-agent%2Fcoordinator/batches/b");
  });
});
```

Fill in the `...` with the directory setup and the `evalUpload([dir], target, { client })` call; `target` is `{ origin: "https://h", projectSlug: "p", apiKey: "k" }`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run lib/cli/eval/upload.test.ts > $SCRATCH/task8-red.log 2>&1; tail -5 $SCRATCH/task8-red.log`
Expected: module not found.

- [ ] **Step 3: Implement `upload.ts`**

Structure: `evalUpload` resolves directories with `uniqueRunDirectories(findRunDirectories(targets))`, builds the client (`deps.client ?? createEvalUploadClient(target.origin, target.projectSlug, target.apiKey)`), and maps each directory through `uploadOne(dir, client, reportWarning)`, which implements the per-run rules above and never throws (it returns a `failed` outcome). Keep `uploadOne`, `eventPlan(count, maxSequence, fileEvents)` (a pure function returning `{ kind: "all" } | { kind: "skip" } | { kind: "resume"; from: number } | { kind: "refuse"; reason: string }`), `chunks(events, from)` and `batchUrlFor(outcomes, snapshots, origin, slug)` as separate small functions in the file. Write `eventPlan`'s four cases as a unit test block too (`describe("eventPlan")`), since it is the whole dedupe policy.

- [ ] **Step 4: Register the command**

`scripts/agency.ts`, after the `grade` command:

```ts
  evalCmd
    .command("upload")
    .description("Upload finished runs (traces and their grades) to the linked statelog project")
    .argument("<paths...>", "Run directories, or directories of run directories")
    .option("--host <origin>", "Statelog origin (default: log.host or the linked project)")
    .option("--project <slug>", "Project slug (default: the linked project)")
    .option("--api-key-env <name>", "Environment variable holding the API key (default STATELOG_API_KEY)")
    .action(async (paths: string[], opts: { host?: string; project?: string; apiKeyEnv?: string }) => {
      const target = resolveProjectTarget(getConfigContext(), opts);
      const result = await evalUpload(paths, target);
      for (const line of formatUploadResult(result)) console.log(line);
      if (result.runs.some((run) => run.status === "failed")) process.exit(1);
    });
```

Import `evalUpload`, `formatUploadResult` from `../lib/cli/eval/upload.js` and `resolveProjectTarget` from wherever `remote spend` imports it in this file (search `resolveProjectTarget` in `scripts/agency.ts`; if only the remote recipes import it, import from `../lib/cli/remote/commands/util.js`).

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm exec vitest run lib/cli/eval/upload.test.ts > $SCRATCH/task8-green.log 2>&1; tail -10 $SCRATCH/task8-green.log; pnpm run typecheck > $SCRATCH/task8-tc.log 2>&1; tail -5 $SCRATCH/task8-tc.log`
Expected: pass, clean.

- [ ] **Step 6: Commit**

```bash
git add lib/cli/eval/upload.ts lib/cli/eval/upload.test.ts scripts/agency.ts
git commit -F msg.txt   # "agency eval upload: post run directories to the linked statelog project"
```

---

### Task 9: public exports for statelog

**Files:**
- Modify: `lib/eval/public.ts`
- Test: `lib/eval/public.test.ts` (exists; extend)

**Interfaces:**
- Produces, from `agency-lang/eval`: `summarizeRuns`, type `RunSummary`; `batchStatistics`, types `BatchStatistics`, `TestStatistics`; `readRunDirectory`, type `RunDirectorySnapshot`; `readTraces`, `tracesFromText`, type `Trace`; `foldAnnotations`, `annotationId`, `AnnotationSchema`, types `Annotation`, `AnnotationDraft`, `RunPayload`; `AGENT_NAME_PATTERN`, `AGENT_NAME_MAX_LENGTH`, `agentNameProblem`.

- [ ] **Step 1: Write the failing test**

In `lib/eval/public.test.ts` add:

```ts
it("exports what statelog imports for eval tracking", async () => {
  const pub = await import("./public.js");
  for (const name of [
    "summarizeRuns", "batchStatistics", "readRunDirectory", "readTraces", "tracesFromText",
    "foldAnnotations", "annotationId", "AnnotationSchema", "AGENT_NAME_PATTERN", "agentNameProblem",
  ]) {
    expect(pub, name).toHaveProperty(name);
  }
});
```

(A test-only `await import` of a static path is how the existing file checks the surface, if it does; otherwise use a static `import * as pub from "./public.js"` at the top. Never a dynamic import in library code.)

- [ ] **Step 2: Run to see it fail**

Run: `pnpm exec vitest run lib/eval/public.test.ts > $SCRATCH/task9-red.log 2>&1; tail -8 $SCRATCH/task9-red.log`
Expected: fails on `summarizeRuns`.

- [ ] **Step 3: Add the exports**

Append to `lib/eval/public.ts`:

```ts
// What statelog imports to store and chart eval runs (docs/dev/eval-tracking.md).
export { summarizeRuns } from "@/runDirectory/list.js";
export type { RunSummary } from "@/runDirectory/list.js";
export { batchStatistics } from "./batchStatistics.js";
export type { BatchStatistics, TestStatistics } from "./batchStatistics.js";
export { readRunDirectory } from "@/runDirectory/runDir.js";
export type { RunDirectorySnapshot } from "@/runDirectory/runDir.js";
export { readTraces, tracesFromText } from "@/runDirectory/traces.js";
export type { Trace } from "@/runDirectory/traces.js";
export { foldAnnotations, annotationId, AnnotationSchema } from "@/runDirectory/annotations.js";
export type { Annotation, AnnotationDraft, RunPayload } from "@/runDirectory/annotations.js";
export { AGENT_NAME_PATTERN, AGENT_NAME_MAX_LENGTH, agentNameProblem } from "@/statelog/agentName.js";
```

Check whether `public.ts` uses `@/` aliases or relative paths today and follow it (the file shown uses relative `./grading/...`; for files outside `lib/eval/` use whatever the build resolves, which is `@/` elsewhere in `lib/`).

- [ ] **Step 4: Run the test and the build's export check**

Run: `pnpm exec vitest run lib/eval/public.test.ts > $SCRATCH/task9-green.log 2>&1; tail -5 $SCRATCH/task9-green.log`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add lib/eval/public.ts lib/eval/public.test.ts
git commit -F msg.txt   # "agency-lang/eval: export the run summary, batch statistics, readers, and the agent-name rule"
```

---

### Task 10: dev notes, full build, guards, PR

**Files:**
- Create: `docs/dev/eval-tracking.md`
- Modify: `docs/dev/statelog-clients.md` (the client list: seven clients now), `docs/dev/eval-grading.md` (one paragraph: trials and the batch line), `CLAUDE.md` (pointer line)

- [ ] **Step 1: Write `docs/dev/eval-tracking.md`**

Plain prose, background first, about a page: what a batch and a trial are; the `batch`/`trial` fields on the run row and why the index (not nesting) is what survives an upload; the two-level directory walk; `batchStatistics` and the pairing rule with the `[1,0]`/`[0,1]` example; `eval upload`'s per-trace dedupe (`eventPlan`'s four cases), the empty-trace rule (post `events: []`), and why annotations go last; the agent-name rule and where it is enforced; what `agency-lang/eval` exports for statelog and the rule that statelog never reimplements score or cost. Point to the spec for the statelog side.

- [ ] **Step 2: CLAUDE.md pointer**

Add under "Pipeline and architecture", after the `eval-grading.md` line:

```
- `docs/dev/eval-tracking.md` — Trials and batches on the run row (`batch`, `trial`), the two-level group walk, `batchStatistics` and its pair-by-trial rule, `eval upload`'s per-trace dedupe/resume/empty-trace rules, the agent-name rule, and what `agency-lang/eval` exports for statelog
```

- [ ] **Step 3: Full build and the pre-push guards**

Run, saving each to the scratchpad:

```
make > $SCRATCH/make.log 2>&1; tail -20 $SCRATCH/make.log
pnpm run lint:structure > $SCRATCH/lint.log 2>&1; tail -5 $SCRATCH/lint.log
pnpm run fmt:ts > $SCRATCH/fmt.log 2>&1; tail -3 $SCRATCH/fmt.log
pnpm exec vitest run lib/sourceIsText.test.ts lib/runDirectory lib/eval/batchStatistics.test.ts lib/eval/run/runSuite.test.ts lib/cli/eval lib/cli/statelog/evalUploadClient.test.ts lib/statelog/agentName.test.ts lib/stdlib/statelog.test.ts lib/runsExplorer > $SCRATCH/final-tests.log 2>&1; tail -15 $SCRATCH/final-tests.log
git diff --numstat main | grep -P "^-\t-" ; echo "(no binary files above)"
git status --short
```

`make` regenerates `docs/site/stdlib/statelog.md` from the docstring change; stage that generated file too. If `fmt:ts` changed files, re-run the affected tests once and commit the formatting with the docs.

- [ ] **Step 4: Anti-pattern pass**

Read `docs/dev/anti-patterns.md` and check the diff (`git diff main --stat` then each new file) for: a second definition of anything `RunSummary` already carries; comments that restate code; a helper that exists only once it could be inlined; `Map`/`Set`/`interface` in library code.

- [ ] **Step 5: Commit docs, push, open the PR**

```bash
git add docs/dev/eval-tracking.md docs/dev/statelog-clients.md docs/dev/eval-grading.md CLAUDE.md docs/site/stdlib/statelog.md
git commit -F msg.txt   # "Docs: eval tracking (trials, batches, upload, agent names)"
git push -u origin adit/eval-tracking
gh pr create --base main --title "Eval tracking, part 1: trials, batch ids, eval upload, agent names" --body-file pr.md
```

`pr.md` states: what shipped (the file map above, in prose), the two spec deviations, that PR 2 (statelog API) must make the bulk route create a missing trace and accept `events: []`, that a package release follows this merge because statelog imports `agency-lang/eval`, and which tests cover what. Open the PR and stop; the owner merges.

## Self-review against the spec

- 1.1 trials: Task 3 (layout, batch/trial on rows, `-n` across jobs) and Task 5 (`eval grade` output). The `findRunDirectories` depth rule: Task 2.
- 1.2 batch and trial fields: Task 1.
- 1.3 agent name, validation, `setAgentName` after `setBrain`: Task 6.
- 1.4 upload command, order of posts, already-on-server skip with both counts, empty-trace creation, resume via `maxSequence`, idempotence, exit code, batch URL: Tasks 7 and 8.
- 1.5 exports (with `summarizeRuns` in place of the spec's `summarizeRun`): Task 9.
- 1.6 `suite.sha` unchanged: no task, by design.
- Delivery step "publish a new package version": the owner's release, noted in the PR body.
- Tests listed in spec part 4 for agency-lang: every bullet maps to a task test above.
