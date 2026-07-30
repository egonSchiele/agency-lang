# Graders for `agency eval` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `agency eval` score an agent run with the grader system that today only `agency optimize` can reach, by moving grading down into the eval layer and adding two entry points both commands share.

**Architecture:** The grading library moves from `lib/optimize/grading/` to `lib/eval/grading/` unchanged. One new module adds `gradeInput` (score one input) and `gradeRun` (loop plus aggregate). `agency eval run` grades inline; a new `agency eval grade` re-scores a finished run directory without re-running the agent. The optimizer keeps target discovery, source mutation, and its search loop, and calls the shared `gradeInput` instead of its own copy.

**Tech Stack:** TypeScript, Node, vitest, esbuild (for loading user grader modules), zod (grade validation), commander (CLI).

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-29-eval-graders-design.md`

## Global Constraints

- **Depends on PR #726.** This plan edits code that only exists on `adit/remove-pairwise-optimize-loop` (commit ee90c6880): Task 4 rewrites the current `BaseOptimizer.gradeInput`/`gradedOutput`, and Task 3's `buildAgentRun` assumes #726's extract semantics, where `evalOutputs` is the node's return value rather than the last LLM completion. On `main` today, an eval record's output is still the LLM completion and the whole design silently grades the wrong value.
- **Work on a branch.** Never commit to `main`. If #726 has merged, branch `adit/eval-graders` from `main`. If it has not, branch from `adit/remove-pairwise-optimize-loop` and rebase onto `main` once #726 lands.
- **Save test output to a file, then grep it.** Run tests as `npx vitest run <paths> > /tmp/out.txt 2>&1` and inspect with `grep -E "FAIL|Tests " /tmp/out.txt`. Never re-run a suite to rediscover which tests failed.
- **Scope test runs to the files you changed.** CI runs the full suite. Do not run `lib/` or whole-package suites.
- **This checkout has stale `worktree-*` directories** that vitest picks up, producing duplicate test files and unrelated failures. Ignore any failure whose path contains `worktree-`. Filter with `grep -v worktree`.
- **Do not run `make`.** Nothing in this plan changes stdlib `.agency` files, `lib/agents/**`, or templates.
- Run `pnpm run typecheck` and `pnpm run lint:structure` before each commit.
- Follow `docs/dev/coding-standards.md` and `docs/dev/anti-patterns.md`. Objects not Maps, arrays not Sets, types not interfaces, no dynamic imports (the existing esbuild loader in `gradingModule.ts` is a pre-existing exception with an eslint-disable comment — preserve it verbatim).
- **Out of scope, do not touch:** workdir copying/retention, `EvalCache` policy or key, the GEPA parent-scorecard filter, the optimizer's per-iteration artifact tree, any curated trace API, and `agency eval judge`.
- **The Agency-side `evalRun` stays ungraded, deliberately.** `lib/stdlib/agencyEval.ts` drives its own per-input loop and never reaches `evalRunLoadedInputs`, so an Agency program calling `evalRun(...)` from `std::agency/eval` gets no `grading` field. That is a decision, not an oversight: what optimize and eval expose to Agency code is being reconsidered separately (the same reason `std::agency`'s `optimize()` was removed in #726). Do not wire grading into the stdlib path in this plan.

---

## File Structure

**Moved (git mv, contents unchanged except import paths):**

| From | To |
|---|---|
| `lib/optimize/grading/**` | `lib/eval/grading/**` |
| `lib/optimize/goalJudgeFile.ts` (+ test) | `lib/eval/grading/goalJudgeFile.ts` |
| `lib/optimize/gradeBreakdown.ts` (+ test) | `lib/eval/grading/gradeBreakdown.ts` |
| `lib/optimize/gradingModule.ts` (+ test) | `lib/eval/grading/gradingModule.ts` |

**Created:**

| File | Responsibility |
|---|---|
| `lib/eval/grading/gradeRun.ts` | `gradeInput`, `gradeRun`, `GradingContext`. The one shared scoring step. |
| `lib/eval/grading/gradeRun.test.ts` | Tests for the above. |
| `lib/eval/public.ts` | The `agency-lang/eval` export surface for user grading modules. |
| `lib/cli/eval/grade.ts` | The `agency eval grade` command. |
| `lib/cli/eval/grade.test.ts` | Tests for the above. |

**Modified:**

| File | Change |
|---|---|
| `lib/optimize/public.ts` | Re-export grading names from `lib/eval/public.js`. |
| `lib/optimize/baseOptimizer.ts` | `RunInput` returns `EvalRunInputResult`; `evaluate` calls shared `gradeInput`; delete local `gradeInput` and `gradedOutput`. |
| `lib/optimize/evalCache.ts` | Stored value type becomes `EvalRunInputResult`. |
| `lib/optimize/reflectionFeedback.ts` | Read `entry.run.record` instead of re-reading from `recordPath`; handle `run === null`. |
| `lib/optimize/gradeBreakdown.ts` (at its new path) | Handle `run === null`. |
| `lib/cli/eval/run.ts` | Grade after running; resolve graders; return the scorecard. |
| `scripts/agency.ts` | `--graders` / `--no-grade` on `eval run`; register `eval grade`. |
| `package.json` | Add the `./eval` export. |
| `docs/dev/writing-optimizers.md` | `runInput` seam shape. |
| `docs/site/cli/eval.md` | Document grading, the two commands, exit codes. |

---

## Task 1: Move the grading library into the eval layer

A pure relocation. No behavior changes, no signature changes. Isolated so a reviewer can confirm "nothing changed" separately from "behavior added".

**Files:**
- Move: `lib/optimize/grading/**` → `lib/eval/grading/**`
- Move: `lib/optimize/{goalJudgeFile,gradeBreakdown,gradingModule}.ts` and their `.test.ts` → `lib/eval/grading/`
- Modify (import paths only) — **19 files**, not the handful you might expect. Source: `lib/cli/eval/optimize.ts`, `lib/optimize/{baseOptimizer,evalCache,gepaReflect,optimizer,public,reflectionFeedback,report,types}.ts`, `lib/optimize/optimizers/{example,gepa,greedyReflective}.ts`. Tests: `lib/optimize/{baseOptimizer,baseOptimizer.workdir,evalCache,gepaReflect,reflectionFeedback}.test.ts`, `lib/optimize/optimizers/{example,gepa,greedyReflective}.test.ts`. Step 4's grep is the authority — treat this list as a sanity check, not a limit.

**Interfaces:**
- Consumes: nothing.
- Produces: every grading symbol at its new path. Later tasks import `BaseGrader`, `Scorecard`, `InputGrades`, `GraderGrade`, `AgentRun`, `Grade`, `GraderOptions`, `GraderContext`, `JSON`, `inputObjective`, `breakdown`, `InputBreakdown`, `loadGradingModule`, `goalJudgeFile`, `asJudgeText`, `ScalarVerdict`, `LlmJudge`, `grader`, `toGrader` from `@/eval/grading/...`.

- [ ] **Step 1: Create the branch from the right base**

```bash
cd /Users/adityabhargava/agency-lang
# If PR #726 has merged:
git checkout main && git pull && git checkout -b adit/eval-graders
# If it has not (check with `gh pr view 726 --json state -q .state`):
git checkout adit/remove-pairwise-optimize-loop && git checkout -b adit/eval-graders
```

- [ ] **Step 2: Move the files with git mv**

```bash
cd /Users/adityabhargava/agency-lang/packages/agency-lang
mkdir -p lib/eval/grading
git mv lib/optimize/grading/* lib/eval/grading/
git mv lib/optimize/goalJudgeFile.ts lib/eval/grading/goalJudgeFile.ts
git mv lib/optimize/goalJudgeFile.test.ts lib/eval/grading/goalJudgeFile.test.ts
git mv lib/optimize/gradeBreakdown.ts lib/eval/grading/gradeBreakdown.ts
git mv lib/optimize/gradeBreakdown.test.ts lib/eval/grading/gradeBreakdown.test.ts
git mv lib/optimize/gradingModule.ts lib/eval/grading/gradingModule.ts
git mv lib/optimize/gradingModule.test.ts lib/eval/grading/gradingModule.test.ts
rmdir lib/optimize/grading
```

- [ ] **Step 3: Fix the relative imports inside the moved files**

`llmJudge.ts` and `humanGrader.ts` import `goalJudgeFile` as `"../../goalJudgeFile.js"`. It is now a sibling of `graders/`, so both become `"../goalJudgeFile.js"`:

```ts
// lib/eval/grading/graders/llmJudge.ts line 3
import { asJudgeText, goalJudgeFile, ScalarVerdict } from "../goalJudgeFile.js";
```

Apply the same edit to `lib/eval/grading/graders/humanGrader.ts`.

`gradeBreakdown.ts` imports `./grading/scorecard.js`; it is now a sibling:

```ts
// lib/eval/grading/gradeBreakdown.ts
import { inputObjective, type Scorecard } from "./scorecard.js";
```

`gradingModule.ts` imports `./grading/baseGrader.js` and `./grading/functionGrader.js`; both become `./baseGrader.js` and `./functionGrader.js`.

- [ ] **Step 4: Fix imports in the files that stayed behind**

Rewrite every `@/optimize/grading/...`, `./grading/...`, `../grading/...`, `./goalJudgeFile.js`, `./gradeBreakdown.js`, and `./gradingModule.js` reference in the seven files listed under **Files** to point at `@/eval/grading/...`. Find them all with:

```bash
grep -rn "optimize/grading\|\./grading/\|\.\./grading/\|goalJudgeFile\|gradeBreakdown\|gradingModule" --include=*.ts lib scripts | grep -v "^lib/eval/grading/"
```

Every hit outside `lib/eval/grading/` must be rewritten. Example:

```ts
// lib/optimize/baseOptimizer.ts — before
import { Scorecard, type GraderGrade, type InputGrades } from "./grading/scorecard.js";
// after
import { Scorecard, type GraderGrade, type InputGrades } from "@/eval/grading/scorecard.js";
```

- [ ] **Step 5: Typecheck**

Run: `pnpm run typecheck`
Expected: no errors. If any remain, they are import paths missed in Step 4.

- [ ] **Step 6: Run the moved tests and the optimizer tests**

```bash
npx vitest run lib/eval/grading lib/optimize lib/cli/eval > /tmp/t1.txt 2>&1
grep -E "FAIL|Tests " /tmp/t1.txt | grep -v worktree
```

Expected: all pass. This is the proof the move was behavior-preserving — no test body should have needed an edit, only import paths.

- [ ] **Step 7: Lint and commit**

```bash
pnpm run lint:structure
git add -A lib scripts
git commit -m "Move the grading library into the eval layer

Graders, Scorecard, the judge runner, and the grading-module loader are
general-purpose scoring code that happened to live under optimize/. Moving
them to lib/eval/grading/ lets eval reach them without importing upward into
optimize, which is the dependency direction we want.

Pure relocation: no signature or behavior changes, only import paths."
```

---

## Task 2: Add the `agency-lang/eval` public export

Small and independent. Doing it now means every later task can reference final import paths.

**Files:**
- Create: `lib/eval/public.ts`
- Modify: `lib/optimize/public.ts`, `package.json`
- Test: `lib/eval/public.test.ts`

**Interfaces:**
- Consumes: the moved modules from Task 1.
- Produces: `agency-lang/eval` as the import path for grader authors. `agency-lang/optimize` continues to export the same names.

- [ ] **Step 1: Write the failing test**

```ts
// lib/eval/public.test.ts
import { describe, expect, it } from "vitest";
import * as evalApi from "./public.js";
import * as optimizeApi from "../optimize/public.js";

describe("agency-lang/eval public surface", () => {
  it("exports the grader authoring API", () => {
    for (const name of [
      "grader", "toGrader", "BaseGrader", "scalar", "binary",
      "ExactMatch", "Contains", "Similarity", "LlmJudge",
      "goalJudgeFile", "Scorecard", "inputObjective", "breakdown",
    ]) {
      expect(evalApi, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("agency-lang/optimize still exports every grading name, for existing modules", () => {
    for (const name of [
      "grader", "toGrader", "BaseGrader", "scalar", "binary",
      "ExactMatch", "Contains", "Similarity", "LlmJudge",
      "goalJudgeFile", "Scorecard", "inputObjective", "breakdown",
    ]) {
      expect(optimizeApi, `missing re-export: ${name}`).toHaveProperty(name);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run lib/eval/public.test.ts > /tmp/t2.txt 2>&1
grep -E "FAIL|Tests |Cannot find" /tmp/t2.txt | grep -v worktree
```
Expected: FAIL — `Cannot find module './public.js'`.

- [ ] **Step 3: Create `lib/eval/public.ts`**

```ts
// The public surface users import when writing graders:
//   import { grader, ExactMatch, LlmJudge, type Grader } from "agency-lang/eval";
export { grader, FunctionGrader, toGrader } from "./grading/functionGrader.js";
export type { Grader, GraderFn, GraderContext } from "./grading/functionGrader.js";
export { scalar, binary } from "./grading/grade.js";
export { BaseGrader } from "./grading/baseGrader.js";
export {
  ExactMatchGrader as ExactMatch,
  ContainsGrader as Contains,
  SimilarityGrader as Similarity,
} from "./grading/graders/builtinGraders.js";
export { LlmJudge } from "./grading/graders/llmJudge.js";
export { goalJudgeFile } from "./grading/goalJudgeFile.js";
export type { Grade, GraderOptions, Input, JSON, JSONPath, Score, AgentRun } from "./grading/types.js";
export { Scorecard, inputObjective } from "./grading/scorecard.js";
export type { GraderGrade, InputGrades } from "./grading/scorecard.js";
export { breakdown } from "./grading/gradeBreakdown.js";
export type { InputBreakdown, GradeRow } from "./grading/gradeBreakdown.js";
```

- [ ] **Step 4: Replace the grading half of `lib/optimize/public.ts` with re-exports**

Delete the grading exports and re-export them from the eval surface, keeping the optimizer-only exports exactly as they are:

```ts
// Grading lives in the eval layer now. Re-exported so existing grading modules
// that import from "agency-lang/optimize" keep working with no edit.
export {
  grader, FunctionGrader, toGrader, scalar, binary, BaseGrader,
  ExactMatch, Contains, Similarity, LlmJudge, goalJudgeFile,
  Scorecard, inputObjective, breakdown,
} from "@/eval/public.js";
export type {
  Grader, GraderFn, GraderContext, Grade, GraderOptions, Input, JSON, JSONPath,
  Score, AgentRun, GraderGrade, InputGrades, InputBreakdown, GradeRow,
} from "@/eval/public.js";

// The surface users import in a custom optimizer module:
//   import { BaseOptimizer, type BaseOptimizerConfig } from "agency-lang/optimize";
export { BaseOptimizer } from "./baseOptimizer.js";
export type { BaseOptimizerDeps, RunInput, MutationOutcome } from "./baseOptimizer.js";
export type { Optimizer, OptimizerFactory, BaseOptimizerConfig, OptimizeTarget } from "./optimizer.js";
export type { OptimizeResult, MutationProposal } from "./types.js";
export { fileMap } from "./targets.js";
export type { OptimizeTargetSet, OptimizeTarget as OptimizeTargetDecl } from "./targets.js";
export { proposeMutation } from "./mutator.js";
export type { ProposeMutationArgs } from "./mutator.js";
export { defaultPreview } from "./sourceMutator.js";
export type { OptimizeMutationOperation, OptimizeMutationPreview, OptimizeMutationDiagnostic, OptimizeAppliedChange } from "./sourceMutator.js";
export { renderReflectionFeedback, renderInputFeedback } from "./reflectionFeedback.js";
export { splitInputs } from "./validationSplit.js";
```

- [ ] **Step 5: Add the `./eval` entry to `package.json`**

Insert immediately before the existing `"./optimize"` entry so the block stays alphabetical:

```json
    "./eval": {
      "types": "./dist/lib/eval/public.d.ts",
      "import": "./dist/lib/eval/public.js",
      "require": "./dist/lib/eval/public.js"
    },
```

- [ ] **Step 6: Run the tests**

```bash
npx vitest run lib/eval/public.test.ts lib/optimize/public.test.ts > /tmp/t2.txt 2>&1
grep -E "FAIL|Tests " /tmp/t2.txt | grep -v worktree
```
Expected: PASS.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm run typecheck && pnpm run lint:structure
git add -A lib package.json
git commit -m "Add agency-lang/eval as the import path for grader authors

Grading now lives in the eval layer, so a module writing graders for eval
should not have to import from optimize. agency-lang/optimize re-exports every
grading name, so existing grading modules keep working unchanged."
```

---

## Task 3: Add `gradeInput` and `gradeRun`

The core of the change. New code, no callers yet.

**Files:**
- Create: `lib/eval/grading/gradeRun.ts`, `lib/eval/grading/gradeRun.test.ts`
- Modify: `lib/eval/grading/types.ts` (grow `AgentRun`, `GraderInput`), `lib/eval/grading/functionGrader.ts` (grow `GraderContext`), `lib/eval/grading/scorecard.ts` (`run` nullable, add `ungradedReason`), `lib/eval/grading/gradeBreakdown.ts` and `lib/optimize/reflectionFeedback.ts` (handle null `run`)

**Interfaces:**
- Consumes: `BaseGrader`, `Scorecard`, `InputGrades`, `AgencyRunner` from Task 1.
- Produces:
  - `type GradingContext = { graders: BaseGrader[]; runAgency: AgencyRunner }`
  - `gradeInput(input: Input, result: EvalRunInputResult, ctx: GradingContext): Promise<InputGrades>`
  - `gradeRun(run: EvalRunResult | ReadEvalRunResult | string, ctx: GradingContext): Promise<Scorecard>`
  - `AgentRun = { output: JSON; recordPath: string; workdir: string; record: EvalRecord }`
  - `InputGrades.run` is now `AgentRun | null`; `InputGrades.ungradedReason?: string`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/eval/grading/gradeRun.test.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import type { EvalRunInputResult, Input } from "@/eval/runTypes.js";
import { AgencyRunner } from "./agencyRunner.js";
import { grader } from "./functionGrader.js";
import { gradeInput, gradeRun } from "./gradeRun.js";

const dirs: string[] = [];
afterEach(() => {
  // Raw rmSync, not safeDelete: these are mkdtemp paths outside any project
  // root, which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
  for (const tempDir of dirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

/** A run directory for one input, with the eval record and workdir on disk. */
function makeRun(args: { id: string; output?: unknown; status?: "success" | "error" }): {
  runDir: string; result: EvalRunInputResult; input: Input;
} {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "grade-run-"));
  dirs.push(runDir);
  const inputDir = path.join(runDir, "inputs", args.id);
  const workdir = path.join(inputDir, "workdir");
  fs.mkdirSync(workdir, { recursive: true });

  const recordPath = path.join(inputDir, "eval-record.json");
  const status = args.status ?? "success";
  if (status === "success") {
    fs.writeFileSync(recordPath, JSON.stringify({
      traceId: "t", recordVersion: 2, formatVersion: 1, durationMs: 1, source: "s",
      evalValues: [],
      evalOutputs: args.output === undefined ? [] : [{ value: args.output, threadId: "0", tMs: 1 }],
      threads: [], events: [], interrupts: [], errors: [], incomplete: [],
      metrics: { llmCalls: 1, toolStarts: 0, toolEnds: 0, models: [], tokensInTotal: 0, tokensOutTotal: 0, costUsdTotal: 0.01, toolCounts: {} },
      warnings: [],
    }));
  } else {
    fs.writeFileSync(path.join(inputDir, "error.txt"), "boom");
  }

  const input: Input = { id: args.id, goal: "g", args: {} };
  const result: EvalRunInputResult = {
    inputId: args.id, status,
    evalRecordPath: recordPath,
    statelogPath: path.join(inputDir, "statelog.jsonl"),
    workdirPath: workdir,
    errorMessage: status === "error" ? "boom" : undefined,
  };
  fs.writeFileSync(path.join(inputDir, "input.json"), JSON.stringify(input));
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({
    runId: "r", runDir, agent: "a:main", inputs: [result],
    okCount: status === "success" ? 1 : 0, errorCount: status === "error" ? 1 : 0,
  }));
  return { runDir, result, input };
}

const ctx = (graders: any[]) => ({ graders, runAgency: new AgencyRunner({}) });

describe("gradeInput", () => {
  it("gives a grader the output, workdir, and parsed record", async () => {
    const { result, input } = makeRun({ id: "a", output: "New Delhi" });
    let seen: any = null;
    const g = grader((c) => { seen = c; return 1; }, { name: "spy" });

    const graded = await gradeInput(input, result, ctx([g]));

    expect(seen.output).toBe("New Delhi");
    expect(fs.existsSync(seen.workdir)).toBe(true);
    expect(seen.record.metrics.costUsdTotal).toBe(0.01);
    expect(graded.gatesPassed).toBe(true);
  });

  it("runs mustPass gates before advisory graders and short-circuits on failure", async () => {
    const { result, input } = makeRun({ id: "a", output: "x" });
    const order: string[] = [];
    const gate = grader(() => { order.push("gate"); return false; }, { name: "gate", mustPass: true });
    const advisory = grader(() => { order.push("advisory"); return 1; }, { name: "advisory" });

    const graded = await gradeInput(input, result, ctx([advisory, gate]));

    expect(order).toEqual(["gate"]);
    expect(graded.gatesPassed).toBe(false);
  });

  it("scores an input with no output 0, without throwing", async () => {
    const { result, input } = makeRun({ id: "a" });   // no evalOutputs
    const g = grader(() => 1, { name: "never-runs" });

    const graded = await gradeInput(input, result, ctx([g]));

    expect(graded.grades).toEqual([]);
    expect(graded.gatesPassed).toBe(false);
    expect(graded.run).toBeNull();
    expect(graded.ungradedReason).toMatch(/no output/i);
  });
});

describe("gradeRun", () => {
  it("scores an errored input 0 and marks it gate-failed, with no eval record on disk", async () => {
    const { runDir } = makeRun({ id: "a", status: "error" });
    const g = grader(() => 1, { name: "never-runs" });

    const card = await gradeRun(runDir, ctx([g]));

    expect(card.objective()).toBe(0);
    expect(card.gatesPassed()).toBe(false);
    expect(card.perInput[0].ungradedReason).toMatch(/error/i);
  });

  it("reads the input spec from disk for an in-memory result, so goal and expected survive", async () => {
    const { runDir, result } = makeRun({ id: "a", output: "hello" });
    // The on-disk input.json carries the goal; the in-memory result does not.
    const inMemory = {
      runId: "r", runDir, agent: "a:main", inputs: [result], okCount: 1, errorCount: 0,
    };
    let seenGoal: unknown = "not-read";
    const g = grader(({ input }) => { seenGoal = input.goal; return 1; }, { name: "spy" });

    await gradeRun(inMemory, ctx([g]));

    expect(seenGoal).toBe("g");
  });

  it("produces the same scorecard from a directory path and from an in-memory result", async () => {
    const { runDir, result, input } = makeRun({ id: "a", output: "hello" });
    const g = grader(({ output }) => String(output).length / 10, { name: "len" });
    const inMemory = {
      runId: "r", runDir, agent: "a:main", inputs: [result], okCount: 1, errorCount: 0,
    };

    const fromPath = await gradeRun(runDir, ctx([g]));
    const fromMemory = await gradeRun(inMemory, ctx([g]));

    expect(fromPath.objective()).toBeCloseTo(0.5);
    expect(fromMemory.objective()).toBeCloseTo(0.5);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run lib/eval/grading/gradeRun.test.ts > /tmp/t3.txt 2>&1
grep -E "FAIL|Tests |Cannot find" /tmp/t3.txt | grep -v worktree
```
Expected: FAIL — `Cannot find module './gradeRun.js'`.

- [ ] **Step 3: Grow `AgentRun` and `GraderInput` in `lib/eval/grading/types.ts`**

```ts
import type { EvalRecord } from "@/eval/types.js";

/** The result of running the agent on one input. */
export type AgentRun = {
  output: JSON;         // the agent's return value
  recordPath: string;   // path to the full execution trace (eval record)
  workdir: string;      // the isolated directory the agent ran in
  record: EvalRecord;   // that trace, parsed
};
```

`GraderInput` is unchanged in shape — `{ input, run, runAgency }` — but `run` now carries the two new fields, so class-based graders gain them for free.

- [ ] **Step 4: Grow `GraderContext` in `lib/eval/grading/functionGrader.ts`**

Add the two fields to the type and pass them through in `FunctionGrader._run`:

```ts
export type GraderContext = {
  output: JSON;
  input: Input;
  /** The isolated directory the agent ran in. Read files the agent wrote. */
  workdir: string;
  /** The parsed eval record: events, metrics, tool counts, interrupts, cost. */
  record: EvalRecord;
  judge: (args: { goal: string; output?: JSON; expected?: JSON }) => Promise<{ score: number; reasoning: string }>;
};
```

```ts
// inside FunctionGrader._run, replace the final call:
const result = await this.fn({
  output: run.output, input, judge,
  workdir: run.workdir, record: run.record,
});
```

- [ ] **Step 5: Make `run` nullable and add `ungradedReason` in `lib/eval/grading/scorecard.ts`**

```ts
export type InputGrades = {
  input: Input;
  /** Null when the input was never graded — the run errored, or produced no output. */
  run: AgentRun | null;
  grades: GraderGrade[];
  gatesPassed: boolean;
  /** Why this input scored 0 without being graded. Set iff `run` is null. */
  ungradedReason?: string;
};
```

No other change is needed in this file: `inputObjective([])` already returns 0, and `inputScores()` already zeroes a gate-failed input.

- [ ] **Step 6: Handle a null `run` in the two places that read it**

```ts
// lib/eval/grading/gradeBreakdown.ts — line 30, inside the per-input map
output: i.run?.output ?? null,
ungradedReason: i.ungradedReason,
```

Add the matching optional field to `InputBreakdown` so the reason survives into `summary.json` and the printed output:

```ts
export type InputBreakdown = {
  inputId: string;
  output: JSON | null;
  objective: number;
  gatesPassed: boolean;
  grades: GradeRow[];
  /** Set when the input scored 0 without being graded. */
  ungradedReason?: string;
};
```

```ts
// lib/optimize/reflectionFeedback.ts — line 16 and 21
// The record is already parsed on the run, so the disk re-read goes away.
const record = entry.run?.record ?? null;
// ...
lines.push(`Output: ${preview(stringifyOutput(entry.run?.output ?? null), 600)}`);
```

Delete the now-unused `loadRecord` helper and its import in `reflectionFeedback.ts` if nothing else calls it. Confirm with:

```bash
grep -n "loadRecord" lib/optimize/reflectionFeedback.ts
```

- [ ] **Step 7: Write `lib/eval/grading/gradeRun.ts`**

```ts
import * as fs from "fs";
import * as path from "path";

import { readEvalRun, type ReadEvalRunResult } from "@/eval/readRun.js";
import type { EvalRecord } from "@/eval/types.js";
import type { EvalRunInputResult, EvalRunResult, Input } from "@/eval/runTypes.js";

import type { AgencyRunner } from "./agencyRunner.js";
import type { BaseGrader } from "./baseGrader.js";
import { Scorecard, type GraderGrade, type InputGrades } from "./scorecard.js";
import type { AgentRun, JSON as Json } from "./types.js";

/** What grading needs besides the run itself. */
export type GradingContext = {
  graders: BaseGrader[];
  /** Capability to execute a judge .agency file. Built from an AgencyConfig. */
  runAgency: AgencyRunner;
};

/**
 * Score one input. Gates run first and short-circuit the input on failure, so a
 * failing gate never pays for the advisory graders behind it.
 *
 * An input that produced nothing is scored 0 rather than throwing: a suite needs
 * mixed results, not an abort. The optimizer still refuses a baseline in this
 * state via `requireBaselineGatesPass`.
 */
export async function gradeInput(
  input: Input,
  result: EvalRunInputResult,
  ctx: GradingContext,
): Promise<InputGrades> {
  const run = buildAgentRun(result);
  if (run === null) {
    return ungraded(input, "the agent produced no output to grade");
  }

  const applicable = ctx.graders.filter((grader) => grader.gradesInput(input));
  const gates = applicable.filter((grader) => grader.mustPass());
  const advisory = applicable.filter((grader) => !grader.mustPass());

  const gateGrades: GraderGrade[] = [];
  for (const grader of gates) {
    const grade = await grader.run({ input, run, runAgency: ctx.runAgency });
    gateGrades.push({ grader, grade });
    if (!grader.passes(grade)) {
      return { input, run, grades: gateGrades, gatesPassed: false };
    }
  }

  const advisoryGrades = await Promise.all(
    advisory.map(async (grader) => ({
      grader,
      grade: await grader.run({ input, run, runAgency: ctx.runAgency }),
    })),
  );

  return { input, run, grades: [...gateGrades, ...advisoryGrades], gatesPassed: true };
}

/**
 * Score every input in a run. Accepts an in-memory result, an already-loaded
 * run, or a run directory path — the same union `judgeSuite` takes.
 *
 * An input whose agent run errored is scored 0 and marked gate-failed here
 * rather than in `gradeInput`: it is eval-side policy, and such an input may
 * have no eval record on disk at all. The optimizer never reaches this path
 * because its run step throws on a failed run first.
 */
export async function gradeRun(
  run: EvalRunResult | ReadEvalRunResult | string,
  ctx: GradingContext,
): Promise<Scorecard> {
  const perInput = await Promise.all(
    toEntries(run).map((entry) => gradeEntry(entry, ctx)),
  );
  return new Scorecard(perInput);
}

type Entry = {
  input: Input;
  result: EvalRunInputResult;
  /** Set when the input cannot be graded at all — skip straight to a scored zero. */
  ungradedReason?: string;
};

/** Grade one entry, or score it 0 when there is nothing gradable. */
async function gradeEntry(entry: Entry, ctx: GradingContext): Promise<InputGrades> {
  if (entry.ungradedReason !== undefined) {
    return ungraded(entry.input, entry.ungradedReason);
  }
  return gradeInput(entry.input, entry.result, ctx);
}

function toEntries(run: EvalRunResult | ReadEvalRunResult | string): Entry[] {
  const loaded = typeof run === "string" ? readEvalRun(run) : run;
  if ("inputsById" in loaded) {
    return Object.values(loaded.inputsById).map((input) => loadedEntry(loaded.runDir, input));
  }
  return loaded.inputs.map((result) => ({
    input: readInputSpec(result) ?? { id: result.inputId, args: {} },
    result,
    ungradedReason: result.status === "error" ? agentErrored(result.errorMessage) : undefined,
  }));
}

/**
 * One entry from a run read off disk. `readEvalRun` reports three statuses, and
 * they mean different things to a user: a run that failed, versus one that
 * succeeded but whose record is gone. Blaming the agent for the second would
 * point them at the wrong problem, so each status names its own reason.
 */
function loadedEntry(runDir: string, input: ReadEvalRunInput): Entry {
  const reasonByStatus: Record<ReadEvalRunInput["status"], string | undefined> = {
    ok: undefined,
    failed: agentErrored(input.errorMessage),
    missing: "no eval record found on disk for this input",
  };
  return {
    input: input.input ?? { id: input.inputId, args: {} },
    result: {
      inputId: input.inputId,
      status: input.status === "ok" ? "success" : "error",
      evalRecordPath: input.recordPath ?? "",
      statelogPath: "",
      workdirPath: workdirFor(runDir, input.inputId),
      errorMessage: input.errorMessage,
    },
    ungradedReason: reasonByStatus[input.status],
  };
}

function agentErrored(message: string | undefined): string {
  return `the agent run errored: ${message ?? "unknown error"}`;
}

function workdirFor(runDir: string, inputId: string): string {
  return path.join(runDir, "inputs", inputId, "workdir");
}

/**
 * The input spec `prepareInput` wrote next to the workdir. An in-memory
 * EvalRunResult carries only per-input *results*, not the specs, and graders
 * need the spec — `LlmJudge` reads `goal` and `ExactMatch` reads `expected`.
 * Both would silently score against nothing if we synthesized a bare input.
 */
function readInputSpec(result: EvalRunInputResult): Input | null {
  if (!result.workdirPath) {
    return null;
  }
  const file = path.join(path.dirname(result.workdirPath), "input.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  return globalThis.JSON.parse(fs.readFileSync(file, "utf8")) as Input;
}

/** An input that scored 0 without being graded. */
function ungraded(input: Input, reason: string): InputGrades {
  return { input, run: null, grades: [], gatesPassed: false, ungradedReason: reason };
}

/** Read the record and pull out the graded output. Null when there is none. */
function buildAgentRun(result: EvalRunInputResult): AgentRun | null {
  if (!result.evalRecordPath || !fs.existsSync(result.evalRecordPath)) {
    return null;
  }
  const record = globalThis.JSON.parse(fs.readFileSync(result.evalRecordPath, "utf8")) as EvalRecord;
  const outputs = record.evalOutputs ?? [];
  if (outputs.length === 0) {
    return null;
  }
  return {
    output: outputs[outputs.length - 1].value as Json,
    recordPath: result.evalRecordPath,
    workdir: result.workdirPath,
    record,
  };
}
```

- [ ] **Step 8: Run the tests**

```bash
npx vitest run lib/eval/grading > /tmp/t3.txt 2>&1
grep -E "FAIL|Tests " /tmp/t3.txt | grep -v worktree
```
Expected: PASS.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
pnpm run typecheck && pnpm run lint:structure
git add -A lib
git commit -m "Add gradeInput and gradeRun to the eval layer

gradeInput scores one input; gradeRun loops and aggregates. Graders now receive
the workdir and the parsed eval record alongside the output, so an agent that
writes files or one judged on what it did along the way is gradable.

An input that produced no output scores 0 instead of throwing, and gradeRun
scores an errored input 0 without needing an eval record on disk."
```

---

## Task 4: Rewire the optimizer onto the shared grading step

**Files:**
- Modify: `lib/optimize/baseOptimizer.ts`, `lib/optimize/evalCache.ts`, `docs/dev/writing-optimizers.md`
- Modify: the optimizer test files that inject the `runInput` seam

**Interfaces:**
- Consumes: `gradeInput`, `GradingContext` from Task 3.
- Produces: `RunInput` now returns `Promise<EvalRunInputResult>`. `BaseOptimizer.evaluate` keeps its signature `(ws, source, files, inputs) => Promise<Scorecard>`.

- [ ] **Step 1: Change the `EvalCache` value type**

```ts
// lib/optimize/evalCache.ts
import type { EvalRunInputResult } from "@/eval/runTypes.js";

/**
 * Memoizes one run per (workspaceKey, inputId). A nested store avoids any
 * separator-collision between the two components (a flat `${ws} ${id}` or
 * `${ws}-${id}` key can collide, e.g. workspace keys are themselves `ws-N`).
 * Null-prototype maps since both keys can derive from user input.
 */
export class EvalCache {
  private readonly runs: Record<string, Record<string, Promise<EvalRunInputResult>>> = Object.create(null);

  get(workspaceKey: string, inputId: string, produce: () => Promise<EvalRunInputResult>): Promise<EvalRunInputResult> {
    const byInput = (this.runs[workspaceKey] ??= Object.create(null));
    if (!Object.hasOwn(byInput, inputId)) {
      byInput[inputId] = produce();
    }
    return byInput[inputId];
  }
}
```

- [ ] **Step 2: Change the `RunInput` seam type in `lib/optimize/baseOptimizer.ts`**

```ts
/** A function that runs the agent for one input in a workspace and returns its
 *  run result. Receives the candidate's `source` (`baseDir`/`entryFile` live
 *  here) and `files` (the candidate's complete file map, used as the workdir
 *  overlay). */
export type RunInput = (
  ws: Workspace,
  source: OptimizeTargetSet,
  files: Record<string, string>,
  input: Input,
  id: string,
) => Promise<EvalRunInputResult>;
```

- [ ] **Step 3: Simplify `runInputViaEval` to return the result it already has**

Replace the final four lines of the method (everything from `const inputResult = result.inputs[0];`) with:

```ts
    const inputResult = result.inputs[0];
    if (!inputResult || inputResult.status !== "success") {
      throw new Error(`agent run failed for input ${input.id ?? "(no id)"}: ${inputResult?.errorMessage ?? "unknown error"}`);
    }
    return inputResult;
```

and change the method's return type to `Promise<EvalRunInputResult>`. The record read and `gradedOutput` call are deleted — that work now happens in `gradeInput`.

- [ ] **Step 4: Replace `evaluate` and delete the local `gradeInput` and `gradedOutput`**

```ts
  /** Run the agent once per input (cached by (workspace, input)), grade each, return a Scorecard.
   *  The candidate's `files` map is the overlay applied inside each per-input workdir. */
  protected async evaluate(
    ws: Workspace,
    source: OptimizeTargetSet,
    files: Record<string, string>,
    inputs: Input[],
  ): Promise<Scorecard> {
    const ctx: GradingContext = { graders: this.config.graders, runAgency: this.agencyRunner };
    const perInput = await Promise.all(
      inputs.map(async (input, index) => {
        const id = inputId(input, index);
        const result = await this.cache.get(ws.key, id, () => this.runInput(ws, source, files, input, id));
        return gradeInput(input, result, ctx);
      }),
    );
    return new Scorecard(perInput);
  }
```

Delete the private `gradeInput` method and the exported `gradedOutput` function entirely, along with the now-unused `fs` import if nothing else in the file uses it. Confirm with:

```bash
grep -n "gradedOutput\|from \"fs\"\|fs\." lib/optimize/baseOptimizer.ts
```

Add the import:

```ts
import { gradeInput, type GradingContext } from "@/eval/grading/gradeRun.js";
```

- [ ] **Step 5: Update every test that injects the `runInput` seam**

Find them:

```bash
grep -rn "runInput" --include=*.test.ts lib/optimize | grep -v worktree
```

Each returns `{ output, recordPath }` today. Each must return an `EvalRunInputResult` and write a real eval record, because `gradeInput` reads it. Use this helper, added once per test file that needs it:

```ts
/** A minimal on-disk eval record, and the run result pointing at it. */
function fakeRun(dir: string, inputId: string, output: unknown): EvalRunInputResult {
  const inputDir = path.join(dir, inputId);
  fs.mkdirSync(path.join(inputDir, "workdir"), { recursive: true });
  const recordPath = path.join(inputDir, "eval-record.json");
  fs.writeFileSync(recordPath, JSON.stringify({
    traceId: "t", recordVersion: 2, formatVersion: 1, durationMs: 1, source: "s",
    evalValues: [], evalOutputs: [{ value: output, threadId: "0", tMs: 1 }],
    threads: [], events: [], interrupts: [], errors: [], incomplete: [],
    metrics: { llmCalls: 0, toolStarts: 0, toolEnds: 0, models: [], tokensInTotal: 0, tokensOutTotal: 0, costUsdTotal: 0, toolCounts: {} },
    warnings: [],
  }));
  return {
    inputId, status: "success", evalRecordPath: recordPath,
    statelogPath: path.join(inputDir, "statelog.jsonl"),
    workdirPath: path.join(inputDir, "workdir"),
  };
}
```

Then a seam that used to read `runInput: async () => ({ output: "x", recordPath: "" })` becomes `runInput: async (_ws, _s, _f, input, id) => fakeRun(tmpDir, id, "x")`.

- [ ] **Step 6: Run the optimizer tests**

```bash
npx vitest run lib/optimize lib/eval/grading > /tmp/t4.txt 2>&1
grep -E "FAIL|Tests " /tmp/t4.txt | grep -v worktree
```
Expected: PASS. Assertions about accept/reject counts, objectives, and champion selection should be unchanged — only the seam's return shape moved.

- [ ] **Step 7: Update `docs/dev/writing-optimizers.md`**

In the Testing table (line ~245), change the `runInput` row:

```markdown
| `runInput` | Running the agent — return an `EvalRunInputResult` pointing at an eval record on disk. Grading reads that record, so the file must exist. |
```

- [ ] **Step 8: Typecheck, lint, commit**

```bash
pnpm run typecheck && pnpm run lint:structure
git add -A lib docs
git commit -m "Point the optimizer at the shared grading step

BaseOptimizer.evaluate now calls the eval layer's gradeInput instead of its own
copy. Reading the eval record and picking the graded output move out of the run
step and into grading, so the run step returns the EvalRunInputResult it already
had and the cache stores that.

Caching policy is unchanged: still one run per (workspace, input), still runs
rather than grades."
```

---

## Task 5: Grade during `agency eval run`

**Files:**
- Modify: `lib/cli/eval/run.ts`, `scripts/agency.ts`
- Test: `lib/cli/eval/run.test.ts`

**Interfaces:**
- Consumes: `gradeRun`, `GradingContext` from Task 3; `loadGradingModule` from Task 1.
- Produces: `EvalRunResult` gains an optional `grading` field; `evalRun` accepts `graders?: string` and `grade?: boolean`.

- [ ] **Step 1: Write the failing test**

`run.test.ts` has no shared `runner`/`extractor` fixtures — each existing test defines them inline. These do the same. The extractor matters: it must write a real eval record with an `evalOutputs` entry, because grading reads that file. An extractor that writes nothing produces a no-output input and a confusing gate failure instead of the objective being asserted.

```ts
// add to lib/cli/eval/run.test.ts
import { grader } from "@/eval/grading/functionGrader.js";
import type { EvalInputRunner, EvalRecordExtractor } from "@/eval/runEvalInput.js";

/** Pretends the agent ran; writes nothing. */
const okRunner: EvalInputRunner = async () => ({ ok: true });

/** Writes the eval record grading will read, with one output value. */
const recordExtractor = (output: unknown): EvalRecordExtractor => async ({ outPath }) => {
  fs.writeFileSync(outPath, JSON.stringify({
    traceId: "t", recordVersion: 2, formatVersion: 1, durationMs: 1, source: "s",
    evalValues: [], evalOutputs: [{ value: output, threadId: "0", tMs: 1 }],
    threads: [], events: [], interrupts: [], errors: [], incomplete: [],
    metrics: { llmCalls: 0, toolStarts: 0, toolEnds: 0, models: [], tokensInTotal: 0, tokensOutTotal: 0, costUsdTotal: 0, toolCounts: {} },
    warnings: [],
  }));
};

it("writes a grading block into summary.json and reports a failed gate", async () => {
  const result = await evalRunLoadedInputs({
    agent: agentPath,
    inputs: [{ id: "a", goal: "g", args: {} }],
    inputsSource: "test",
    runsDir: tmpDir,
    runId: "graded",
    graders: [grader(() => false, { name: "gate", mustPass: true })],
  }, { runner: okRunner, extractor: recordExtractor("hello") });

  expect(result.grading).toBeDefined();
  expect(result.grading!.gatesPassed).toBe(false);

  const summary = JSON.parse(fs.readFileSync(path.join(tmpDir, "graded", "summary.json"), "utf8"));
  expect(summary.grading.graders).toEqual(["gate"]);
});

it("counts a gate-failed input as a zero rather than zeroing the whole run", async () => {
  const result = await evalRunLoadedInputs({
    agent: agentPath,
    inputs: [{ id: "a", goal: "g", args: {} }, { id: "b", goal: "g", args: {} }],
    inputsSource: "test",
    runsDir: tmpDir,
    runId: "mixed",
    // Passes on input "a", fails the gate on input "b".
    graders: [grader(({ input }) => input.id === "a", { name: "gate", mustPass: true })],
  }, { runner: okRunner, extractor: recordExtractor("hello") });

  // One of two inputs scored 1, the other 0 — the mean is 0.5, not 0.
  expect(result.grading!.objective).toBeCloseTo(0.5);
  expect(result.grading!.gatesPassed).toBe(false);
});

it("skips grading entirely when no graders are supplied, so the optimizer path is unaffected", async () => {
  const result = await evalRunLoadedInputs({
    agent: agentPath,
    inputs: [{ id: "a", goal: "g", args: {} }],
    inputsSource: "test",
    runsDir: tmpDir,
    runId: "ungraded",
  }, { runner: okRunner, extractor: recordExtractor("hello") });

  expect(result.grading).toBeUndefined();
  const summary = JSON.parse(fs.readFileSync(path.join(tmpDir, "ungraded", "summary.json"), "utf8"));
  expect(summary).not.toHaveProperty("grading");
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run lib/cli/eval/run.test.ts > /tmp/t5.txt 2>&1
grep -E "FAIL|Tests " /tmp/t5.txt | grep -v worktree
```
Expected: FAIL — `result.grading` is undefined in the first test.

- [ ] **Step 3: Add the `grading` field to `EvalRunResult`**

```ts
// lib/eval/runTypes.ts
export type EvalRunGrading = {
  graders: string[];
  objective: number;
  gatesPassed: boolean;
  perInput: InputBreakdown[];
};

export type EvalRunResult = {
  runId: string;
  runDir: string;
  agent: string;
  inputs: EvalRunInputResult[];
  okCount: number;
  errorCount: number;
  /** Present unless grading was disabled. */
  grading?: EvalRunGrading;
};
```

Import `InputBreakdown` from `@/eval/grading/gradeBreakdown.js`.

- [ ] **Step 4: Grade at the end of `evalRunLoadedInputs` — but only when graders are handed in**

**This is the critical detail.** `evalRunLoadedInputs` is a library primitive with two callers, and the optimizer is one of them (`baseOptimizer.ts:289`, once per input per candidate). If grading defaulted on *here*, every optimizer candidate run would also fire a goal-judge LLM call whose result is thrown away, because the optimizer grades separately through `gradeInput`. Every existing test in `run.test.ts` would also start invoking a real judge subprocess. So the primitive stays inert: it grades only when a caller explicitly supplies graders. The "no `--graders` means the goal judge" default belongs at the command layer, in Step 5.

There is no `grade` flag on this function.

Add one field to `EvalRunLoadedInputsOptions`:

```ts
  /** Graders to score the finished run with. Omit to skip grading entirely.
   *  The optimizer never passes this — it grades separately via gradeInput. */
  graders?: BaseGrader[];
```

Replace the final `return writeEvalRunSummary(state, results);` with:

```ts
  const summary = writeEvalRunSummary(state, results);
  if (!opts.graders || opts.graders.length === 0) {
    return summary;
  }

  const scorecard = await gradeRun(summary, {
    graders: opts.graders,
    runAgency: new AgencyRunner(config),
  });
  summary.grading = {
    graders: opts.graders.map((grader) => grader.name()),
    // objective(), not gatedObjective(): a gate-failed input already contributes
    // 0 to this mean. gatedObjective() would zero the WHOLE run when any single
    // input fails, so one flaky timeout out of fifty would report 0.00 and make
    // the tracked number useless. gatesPassed drives the exit code instead.
    objective: scorecard.objective(),
    gatesPassed: scorecard.gatesPassed(),
    perInput: breakdown(scorecard),
  };
  fs.writeFileSync(path.join(summary.runDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
```

- [ ] **Step 5: Resolve the default at the command layer, in `evalRun`**

In `EvalRunCliOptions` add `graders?: string;` and `grade?: boolean;` — the boolean lives here, not in the library. In `evalRun`, before delegating:

```ts
  // The command decides what "no --graders" means; the library primitive does not.
  const gradersPath = opts.graders ?? opts.config?.eval?.graders;
  const graders = await resolveGraders(gradersPath, opts.grade, opts.config ?? {});
```

with the three cases named once, as a flat sequence of guards rather than a nested ternary:

```ts
/**
 * What "no --graders" means, decided here rather than in the library: the
 * bundled goal judge, so a suite with goals scores without a grading module.
 * `--no-grade` (grade === false) opts out of scoring entirely.
 */
async function resolveGraders(
  gradersPath: string | undefined,
  grade: boolean | undefined,
  config: AgencyConfig,
): Promise<BaseGrader[] | undefined> {
  if (grade === false) {
    return undefined;
  }
  if (gradersPath === undefined) {
    return [new LlmJudge({ name: "goal" })];
  }
  return loadGradingModule(gradersPath, config);
}
```

`evalGrade` in Task 6 makes the same decision; have it call this helper too rather than repeating the branch. Export it from `lib/cli/eval/run.ts`.

Pass `graders` into `evalRunLoadedInputs`. When a grading module is supplied, `goal` is no longer required on inputs:

```ts
      : loadInputs(path.resolve(opts.inputs ?? ""), nanoid, { requireGoal: !gradersPath });
```

- [ ] **Step 6: Add `eval.graders` to the config type**

```ts
// lib/config.ts, inside the eval block
    graders?: string;                              // path to a TS grading module
```

Add the matching `graders: z.string().optional(),` to the `eval` zod schema.

- [ ] **Step 7: Add the CLI flags in `scripts/agency.ts`**

On the `eval run` command, after `--goal`:

```ts
    .option("--graders <file>", "TypeScript grading module (default-exports graders)")
    .option("--no-grade", "Skip grading; only run the agent")
```

Add `graders?: string; grade?: boolean;` to the action's options type, and extend the action body:

```ts
      const result = await evalRun({ ...opts, config: getConfig() });
      console.log(`Run ${result.runId} completed: ${result.okCount}/${result.inputs.length} inputs ok`);
      if (result.grading) {
        for (const line of formatGrading(result.grading.objective, result.grading.perInput)) {
          console.log(line);
        }
      }
      console.log(path.join(result.runDir, "summary.json"));
      if (result.grading && !result.grading.gatesPassed) {
        process.exit(2);
      }
      if (result.errorCount > 0 && opts.continueOnError === false) {
        process.exit(2);
      }
```

Import it: `import { formatGrading } from "@/eval/grading/gradeBreakdown.js";`

- [ ] **Step 7b: Add `formatGrading` to `lib/eval/grading/gradeBreakdown.ts`**

One line per *grader*, aggregated across inputs — which is what tells you which aspect regressed. A per-input listing does not. Ungraded inputs get their own line naming the actual reason, rather than a misleading `(gate failed)` when no gate was even configured.

**Aggregation is separate from rendering.** `summarizeGraders` and `ungradedInputs` produce data — the "what". `formatGrading` turns data into strings — the "how". Keeping them apart means a future JSON or HTML renderer reuses the aggregation untouched, and each piece is testable without the other.

```ts
/** One grader's aggregate result across every input it graded. */
export type GraderSummary =
  | { grader: string; kind: "binary"; passed: number; total: number }
  | { grader: string; kind: "scalar"; mean: number };

/** Every grade row, grouped by grader name, order of first appearance preserved. */
function gradesByGrader(perInput: InputBreakdown[]): Record<string, GradeRow[]> {
  const rows = perInput.flatMap((input) => input.grades);
  const names = rows.map((row) => row.grader);
  const uniqueNames = names.filter((name, index) => names.indexOf(name) === index);
  return Object.fromEntries(
    uniqueNames.map((name) => [name, rows.filter((row) => row.grader === name)]),
  );
}

/**
 * Aggregate grades into one summary per grader: a pass count for binary graders,
 * a mean for scalar ones. A grader with any scalar row is summarized as scalar.
 */
export function summarizeGraders(perInput: InputBreakdown[]): GraderSummary[] {
  return Object.entries(gradesByGrader(perInput)).map(([grader, rows]) => {
    const scalars = rows.filter((row) => row.kind === "scalar");
    if (scalars.length === 0) {
      const binaries = rows.filter((row) => row.kind === "binary");
      return { grader, kind: "binary", passed: binaries.filter((row) => row.pass).length, total: binaries.length };
    }
    const sum = scalars.reduce((total, row) => total + row.value, 0);
    return { grader, kind: "scalar", mean: sum / scalars.length };
  });
}

/** Inputs that scored 0 without being graded, paired with the reason. */
export function ungradedInputs(perInput: InputBreakdown[]): { inputId: string; reason: string }[] {
  return perInput.flatMap((input) =>
    input.ungradedReason === undefined
      ? []
      : [{ inputId: input.inputId, reason: input.ungradedReason }],
  );
}

/**
 * Render a grading result for a terminal.
 *
 * Takes the parts rather than an EvalRunGrading to avoid a circular import —
 * runTypes.ts imports InputBreakdown from this file.
 */
export function formatGrading(objective: number, perInput: InputBreakdown[]): string[] {
  return [
    `objective  ${objective.toFixed(3)}`,
    ...summarizeGraders(perInput).map(formatGraderSummary),
    ...ungradedInputs(perInput).map((entry) => `  ${entry.inputId}  not graded — ${entry.reason}`),
  ];
}

function formatGraderSummary(summary: GraderSummary): string {
  if (summary.kind === "binary") {
    return `  ${summary.grader}  ${summary.passed}/${summary.total} pass`;
  }
  return `  ${summary.grader}  ${summary.mean.toFixed(3)}`;
}
```

- [ ] **Step 8: Run the tests**

```bash
npx vitest run lib/cli/eval > /tmp/t5.txt 2>&1
grep -E "FAIL|Tests " /tmp/t5.txt | grep -v worktree
```
Expected: PASS.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
pnpm run typecheck && pnpm run lint:structure
git add -A lib scripts
git commit -m "Score the suite during agency eval run

eval run now grades what it ran and reports an objective, defaulting to the
bundled goal judge so a suite with goals produces a number without any grading
module. --graders supplies your own; --no-grade skips scoring for the case
where you only want to know the agent executed.

A failing mustPass gate exits 2, which makes a gate the assertion mechanism."
```

---

## Task 6: Add `agency eval grade`

**Files:**
- Create: `lib/cli/eval/grade.ts`, `lib/cli/eval/grade.test.ts`
- Modify: `scripts/agency.ts`

**Interfaces:**
- Consumes: `gradeRun` from Task 3, `loadGradingModule` from Task 1.
- Produces: `evalGrade(runDir, opts): Promise<EvalRunGrading>`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/cli/eval/grade.test.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { evalGrade } from "./grade.js";

const dirs: string[] = [];
afterEach(() => {
  // Raw rmSync, not safeDelete: these are mkdtemp paths outside any project
  // root, which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
  for (const tempDir of dirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

/** A finished run directory with one successful input. */
function makeRunDir(output: string): string {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-grade-"));
  dirs.push(runDir);
  const inputDir = path.join(runDir, "inputs", "a");
  fs.mkdirSync(path.join(inputDir, "workdir"), { recursive: true });
  fs.writeFileSync(path.join(inputDir, "input.json"), JSON.stringify({ id: "a", goal: "g", args: {} }));
  fs.writeFileSync(path.join(inputDir, "eval-record.json"), JSON.stringify({
    traceId: "t", recordVersion: 2, formatVersion: 1, durationMs: 1, source: "s",
    evalValues: [], evalOutputs: [{ value: output, threadId: "0", tMs: 1 }],
    threads: [], events: [], interrupts: [], errors: [], incomplete: [],
    metrics: { llmCalls: 0, toolStarts: 0, toolEnds: 0, models: [], tokensInTotal: 0, tokensOutTotal: 0, costUsdTotal: 0, toolCounts: {} },
    warnings: [],
  }));
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({
    runId: "r", runDir, agent: "a:main", okCount: 1, errorCount: 0,
    inputs: [{
      inputId: "a", status: "success",
      evalRecordPath: path.join(inputDir, "eval-record.json"),
      statelogPath: path.join(inputDir, "statelog.jsonl"),
      workdirPath: path.join(inputDir, "workdir"),
    }],
  }));
  return runDir;
}

/** A grading module on disk that scores by output length. */
function makeGraders(dir: string): string {
  const file = path.join(dir, "graders.ts");
  fs.writeFileSync(file, `
    import { grader } from "agency-lang/eval";
    export default [grader(({ output }) => String(output).length / 10, { name: "len" })];
  `);
  return file;
}

describe("evalGrade", () => {
  it("scores a finished run and writes grading.json without touching summary.json", async () => {
    const runDir = makeRunDir("hello");
    const before = fs.readFileSync(path.join(runDir, "summary.json"), "utf8");

    const grading = await evalGrade(runDir, { graders: makeGraders(runDir), config: {} });

    expect(grading.objective).toBeCloseTo(0.5);
    expect(grading.graders).toEqual(["len"]);
    const written = JSON.parse(fs.readFileSync(path.join(runDir, "grading.json"), "utf8"));
    expect(written.objective).toBeCloseTo(0.5);
    expect(fs.readFileSync(path.join(runDir, "summary.json"), "utf8")).toBe(before);
  });

  it("honors -o and leaves grading.json absent", async () => {
    const runDir = makeRunDir("hello");
    const out = path.join(runDir, "custom.json");

    await evalGrade(runDir, { graders: makeGraders(runDir), out, config: {} });

    expect(fs.existsSync(out)).toBe(true);
    expect(fs.existsSync(path.join(runDir, "grading.json"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run lib/cli/eval/grade.test.ts > /tmp/t6.txt 2>&1
grep -E "FAIL|Tests |Cannot find" /tmp/t6.txt | grep -v worktree
```
Expected: FAIL — `Cannot find module './grade.js'`.

- [ ] **Step 3: Write `lib/cli/eval/grade.ts`**

```ts
import * as fs from "fs";
import * as path from "path";

import type { AgencyConfig } from "@/config.js";
import { AgencyRunner } from "@/eval/grading/agencyRunner.js";
import { breakdown } from "@/eval/grading/gradeBreakdown.js";
import { gradeRun } from "@/eval/grading/gradeRun.js";
import { loadGradingModule } from "@/eval/grading/gradingModule.js";
import { LlmJudge } from "@/eval/grading/graders/llmJudge.js";
import type { EvalRunGrading } from "@/eval/runTypes.js";

export type EvalGradeOptions = {
  /** Path to a TypeScript grading module. Defaults to the bundled goal judge. */
  graders?: string;
  /** Where to write the result. Defaults to `<runDir>/grading.json`. */
  out?: string;
  config?: AgencyConfig;
};

/**
 * Re-score a finished run directory. Never re-executes the agent, and never
 * rewrites summary.json — the run keeps the score it was born with and
 * re-grades sit beside it.
 */
export async function evalGrade(
  runDir: string,
  opts: EvalGradeOptions,
): Promise<EvalRunGrading> {
  const config = opts.config ?? {};
  const gradersPath = opts.graders ?? config.eval?.graders;
  const graders = gradersPath
    ? await loadGradingModule(gradersPath, config)
    : [new LlmJudge({ name: "goal" })];

  const scorecard = await gradeRun(path.resolve(runDir), {
    graders,
    runAgency: new AgencyRunner(config),
  });

  const grading: EvalRunGrading = {
    graders: graders.map((grader) => grader.name()),
    // objective(), not gatedObjective() — same reasoning as eval run: a
    // gate-failed input already contributes 0 to this mean, and zeroing the
    // whole run over one failure makes the number untrackable.
    objective: scorecard.objective(),
    gatesPassed: scorecard.gatesPassed(),
    perInput: breakdown(scorecard),
  };

  fs.writeFileSync(
    opts.out ?? path.join(path.resolve(runDir), "grading.json"),
    JSON.stringify(grading, null, 2),
  );
  return grading;
}
```

- [ ] **Step 4: Register the command in `scripts/agency.ts`**

Add after the `eval extract` registration:

```ts
  evalCmd
    .command("grade")
    .description("Score a finished eval run without re-running the agent")
    .argument("<runDir>", "Path to a run directory produced by `agency eval run`")
    .option("--graders <file>", "TypeScript grading module (default-exports graders)")
    .option("-o, --out <path>", "Output path (default: <runDir>/grading.json)")
    .action(async (runDir: string, opts: { graders?: string; out?: string }) => {
      const grading = await evalGrade(runDir, { ...opts, config: getConfig() });
      for (const line of formatGrading(grading.objective, grading.perInput)) {
        console.log(line);
      }
      if (!grading.gatesPassed) {
        process.exit(2);
      }
    });
```

Add the imports at the top: `import { evalGrade } from "@/cli/eval/grade.js";` and `import { formatGrading } from "@/eval/grading/gradeBreakdown.js";` (shared with the `eval run` action, so both commands print identically).

- [ ] **Step 5: Run the tests**

```bash
npx vitest run lib/cli/eval > /tmp/t6.txt 2>&1
grep -E "FAIL|Tests " /tmp/t6.txt | grep -v worktree
```
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm run typecheck && pnpm run lint:structure
git add -A lib scripts
git commit -m "Add agency eval grade for re-scoring a finished run

Developing a grader means iterating on the grader, not the agent. eval grade
reads a run directory and scores it again with different graders, never
re-executing the agent, so the thing being measured is held fixed.

Non-destructive: writes grading.json beside the run and leaves summary.json
alone."
```

---

## Task 7: Document grading in the eval guide

**Files:**
- Modify: `docs/site/cli/eval.md`

**Interfaces:**
- Consumes: the user-facing surface from Tasks 2, 5, and 6 — the `agency-lang/eval` import path, `--graders` / `--no-grade` on `eval run`, and the `eval grade` command.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Add the grading section**

Insert after the "Running an input suite" section, before "Optimizing marked declarations":

````markdown
## Scoring a run

`agency eval run` scores what it ran and prints an objective between 0 and 1:

```bash
agency eval run --agent agent.agency --inputs inputs.json
#   3/3 inputs ok
#   objective  0.71
```

With no `--graders`, it grades with the bundled goal judge against each input's
`goal` field — the same default `agency optimize` uses. Pass `--no-grade` to
skip scoring and only run the agent.

### Custom graders

A grading module default-exports one grader or a list of them:

```ts
// graders.ts
import { grader, ExactMatch, LlmJudge } from "agency-lang/eval";
import { existsSync } from "fs";
import { join } from "path";

export default [
  // the return value
  grader(({ output }) => String(output).length < 500, { name: "concise" }),

  // a file the agent wrote
  grader(({ workdir }) => existsSync(join(workdir, "analyze.py")), { name: "wrote-script" }),

  // what it did along the way
  grader(({ record }) => record.metrics.costUsdTotal < 0.05, { name: "cheap" }),

  // compare against the input's `expected` field
  new ExactMatch({ mustPass: true }),
];
```

```bash
agency eval run --agent agent.agency --inputs inputs.json --graders graders.ts
```

A grader function receives `{ output, input, workdir, record, judge }` and
returns a number from 0 to 1, a boolean, or a full `Grade`. Options control how
it counts: `mustPass` makes it a gate, `weight` sets its share of the objective,
`threshold` sets the passing bar for scalar scores, `samples` runs it k times,
and `inputScope` restricts it to a subset of inputs.

When a grading module is supplied, `goal` becomes optional on your inputs.

### Pass and fail

A `mustPass` grader is the assertion. If one fails, the input scores 0, the run
reports `gatesPassed: false`, and the command exits 2 — so a gate is what makes
`agency eval run` usable as a CI check. Every other grader is a measurement you
track over time. An input whose agent run errored, or which produced no output,
scores 0 and fails every gate.

### Re-scoring a finished run

Grading is also a separate command, so you can iterate on a grader without
re-running the agent:

```bash
agency eval grade runs/abc --graders graders.ts
#   objective  0.71
```

It reads the run directory, scores it again, and writes `grading.json` beside
the run. `summary.json` is never rewritten, so the original score survives. Use
`-o` to keep several gradings of the same run.

This costs nothing and is deterministic for `ExactMatch`, `Contains`,
`Similarity`, and function graders that do not call `judge`. An `LlmJudge`, or a
function grader calling `judge(...)`, still makes a live LLM call each time —
much cheaper than re-running agents, and the outputs being judged stay fixed.
````

- [ ] **Step 2: Update the command list at the top of the file**

```text
agency eval run --agent <file>[:<node>] (--inputs <file|dir> | --goal <text>) [--graders <file>] [--no-grade]
agency eval grade <runDir> [--graders <file>] [-o <path>]
agency eval optimize <file>[:<node>] [--inputs <file|dir>] [--goal <text>] [--graders <file>] [--validation-inputs <file|dir> | --validation-split <ratio>]
agency eval extract <file>
```

- [ ] **Step 3: Add `grading` to the documented run-directory layout**

In the "Each run writes" block, add `grading.json` as an optional sibling:

```text
runs/<run-id>/
  config.json
  inputs/<input-id>/
    input.json
    statelog.jsonl
    eval-record.json
    workdir/
    error.txt
  summary.json
  grading.json        only after `agency eval grade`
```

- [ ] **Step 4: Commit**

```bash
git add -A docs
git commit -m "Document grading in the eval CLI guide"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: the move table → Task 1 (including `gradingModule.ts`, the review's finding 1); `agency-lang/eval` and the re-export → Task 2; `gradeInput`/`gradeRun` with `GradingContext` carrying `runAgency` → Task 3 (finding 2); grader context growth → Task 3 Steps 3–4; errored-input policy living in `gradeRun` only, with gate semantics pinned → Task 3 Step 7 and its test (finding 5); the `RunInput`/`EvalCache` shape change with its test and doc knock-ons → Task 4 (finding 4); default goal judge and `--no-grade` → Task 5 (finding 6); `eval grade` non-destructive with `-o` → Task 6; the honest cost framing for LLM graders → Task 7 (finding 3).

**Not covered by design:** everything in the spec's "Not in scope" list. No task touches workdir copying or retention, the caching policy, the GEPA parent-scorecard filter, the optimizer artifact tree, a curated trace API, or `agency eval judge`.

**Type consistency.** `GradingContext` is `{ graders, runAgency }` in Tasks 3, 4, 5, 6. `AgentRun` is `{ output, recordPath, workdir, record }` in Task 3 and consumed with that shape in Task 4. `EvalRunGrading` is defined in Task 5 Step 3 and consumed in Task 6 Step 3. `RunInput` returns `EvalRunInputResult` in Task 4 Steps 2–3 and is produced by the test helper in Step 5. `InputGrades.run` is nullable from Task 3 Step 5 onward and every reader is patched in Step 6.

**Changes from plan review (2026-07-29).** Six findings, all applied:

1. **Default grading moved out of the library.** `evalRunLoadedInputs` now grades only when a caller hands it graders; the "no `--graders` means the goal judge" default lives in `evalRun` and `evalGrade`. The original placement would have fired a discarded goal-judge LLM call on every optimizer candidate run (once per input, per candidate, per iteration) and made every existing `run.test.ts` case invoke a real judge subprocess. The `grade` boolean left the library signature entirely.
2. **Reporting uses `objective()`, not `gatedObjective()`.** The latter collapses to 0 when *any* input gate-fails, so one crashed input out of fifty would report 0.00 for the whole run — contradicting the spec's own "counted, not skipped" rule and making the tracked number useless under flakiness. `gatedObjective()` stays what optimizers compare candidates on.
3. **Branch base corrected** to `adit/remove-pairwise-optimize-loop`, with the dependency on #726 stated as a Global Constraint. On `main` the extract semantics still yield the last LLM completion, so `buildAgentRun` would silently grade the wrong value.
4. **Task 1's Modify list corrected** from 7 files to the real 19.
5. **Task 5's tests rewritten** with inline `runner`/`extractor` definitions — the referenced `fakeRunner`/`fakeExtractor` did not exist — and an extractor that writes a real eval record, since grading reads it.
6. **`toEntries` distinguishes `missing` from `failed`.** `readEvalRun` reports both; calling a lost record "the agent errored" points the user at the wrong problem.

Minor: `workdirFor` uses `path.join`; the summary write uses `summary.runDir`; the stdlib `evalRun` exclusion is now an explicit scope note; and both commands print one line per grader via a shared `formatGrading`, matching the spec rather than the plan's original per-input listing.

**Anti-pattern audit against `docs/dev/anti-patterns.md` (2026-07-29).** Five violations found in the plan's own code and fixed:

1. **Imperative code everywhere / order-dependent mutable state — `formatGrading`.** The original mutated a `lines` accumulator across three phases, hand-rolled grouping with nested `for` loops and `push`, and used `continue`. Rewritten as `summarizeGraders` + `ungradedInputs` (pure data, the "what") and `formatGrading` (one array literal, the "how"). A future JSON or HTML renderer now reuses the aggregation untouched, and each half is testable alone.
2. **Nested ternary** resolving `--graders` / `--no-grade` / default. Replaced with a named `resolveGraders` helper using flat guard clauses, shared by `evalRun` and `evalGrade` so the three cases are stated once.
3. **"Ugly code" — `...(cond ? { x } : {})`.** Seven instances, a pattern the doc says never to use. All removed. `strict` is on without `exactOptionalPropertyTypes`, so an optional property accepts `undefined` directly; and `toEntries` now uses a `reasonByStatus` lookup table instead of branching per status.
4. **Single-character variable names** — `(g)`, `(r)`, `(s)`, `(i)`, `(d)`. All renamed to `grader`, `row`, `total`, `input`, `tempDir`.
5. **One-line `if` statements without braces** — eight guard clauses. All braced.

Checked and clean: no `try`/`catch` (so the swallowed-error rule cannot apply), no dynamic `require`/`import`, no inline-nested object types, no magic numbers beyond `toFixed(3)` formatting that matches `reporter.ts`, and no test whose failure is catastrophic — the tests only create and remove `mkdtemp` directories. Raw `fs.rmSync` on those is deliberate and now carries a comment: `safeDelete` refuses paths outside a project root by design, which is the same reasoning `runArtifacts.ts` already documents.

Two tensions worth naming rather than hiding. The existing codebase uses the conditional-spread pattern and unbraced guard clauses pervasively — `gradeBreakdown.ts:19` and `readRun.ts:34-38` both do the first, `extract.ts` the second — so the new code is now *stricter* than its neighbors. That is the right direction, but do not "fix" surrounding lines while implementing; keep the diff to this plan's scope. And `summarizeGraders` hand-rolls a group-by because the codebase has no `groupBy` utility; if one is added later, this is a caller to migrate.

**Bug caught during the first self-review:** the first draft of `toEntries` synthesized `{ id, args: {} }` for the in-memory branch, discarding `goal` and `expected`. `LlmJudge` reads `goal` and `ExactMatch` reads `expected`, so both would have scored against nothing on the inline `eval run` path — silently, since neither throws on a missing field. Fixed by reading the `input.json` that `prepareInput` already writes beside each workdir, with a test in Task 3 Step 1 that asserts `goal` reaches the grader.

**Known cost:** Task 4 Step 5 is the largest piece of unavoidable churn — every optimizer test injecting `runInput` must now write a real eval record. That is the price of moving record-reading into grading, and the plan supplies the helper rather than leaving it to invention.
