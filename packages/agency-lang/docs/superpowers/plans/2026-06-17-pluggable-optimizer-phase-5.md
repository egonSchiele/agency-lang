# Pluggable Optimizer Framework — Phase 5 (GEPA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Per repo convention, do implementation directly in the main session — do not fan out to subagents.)

**Goal:** Add the GEPA optimizer — *reflective prompt evolution* with a Pareto candidate pool and minibatched promotion — as a registered `--optimizer gepa`.

**What makes this GEPA (read first):** GEPA's whole thesis (Agrawal et al., *GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning*, ICLR 2026) is that you learn faster from **natural-language reflection on execution traces** than from scalar scores. Two things therefore make-or-break this phase:

1. **Traces must reach the reflector.** The agent's full trajectory — inputs, output, errors, tool calls, and grader feedback — has to be rendered into the reflection prompt. The plumbing already exists: `AgentRun.recordPath` (`grading/types.ts:20`) points at the on-disk `EvalRecord` (`lib/eval/types.ts`), and `Grade.feedback` (`grading/types.ts:29`) already carries per-grader natural-language feedback (`LlmJudge` returns the judge's reasoning at `llmJudge.ts:39,42`). **Task 4** turns a graded input into that feedback block.
2. **The reflection prompt must be GEPA's prompt.** We port the meta-prompt from the paper's Appendix C ("infer the task, harvest domain-specific facts that won't be available later, capture the generalizable strategy"), not a clone of the mechanical `mutatePrompt.agency` instructions. **Task 5** carries that prompt.

**Architecture:** GEPA keeps a pool of candidates, each scored on a *fixed* Pareto input set (so their per-input score vectors are comparable). Each iteration: sample a parent from the Pareto frontier (candidates best on at least one input, weighted by wins), select one optimize target round-robin (`SelectModule`), reflectively mutate it from the parent's weakest minibatch inputs *and their traces*, score the child on that random minibatch, and only if it beats the parent on the batch pay for a full Pareto-set evaluation and admit it. Pure pieces (RNG, frontier, pool, trace rendering) are unit-tested; the loop is tested with injected `propose`/`runInput`/`preview`/`discover`.

**Tech Stack:** TypeScript (ESM, `@/` alias), Vitest; one new `.agency` proposer agent.

**Source spec:** `docs/superpowers/specs/2026-06-17-pluggable-optimizer-framework-design.md` (see "Built-in optimizer: GEPA", "Minibatching", and "The Pareto frontier, worked").

## Prerequisites (assumed merged: Phases 1–4)

From the merged framework (verified against current `main`):

- `BaseOptimizer` (`lib/optimize/baseOptimizer.ts`): `protected evaluate(ws, entryFile, inputs): Promise<Scorecard>` (runs each input via a `(ws.key, inputId)`-keyed `EvalCache`, then grades), `protected fork(dir): Workspace`, `protected eachIteration(fn)`, `this.agencyRunner: AgencyRunner`, `this.workspace: WorkspaceManager`, `this.cache: EvalCache`. Override seam: `BaseOptimizerDeps.runInput`.
- `Scorecard` (`grading/scorecard.ts`): `inputScores(): number[]`, `objective(): number`, `gatesPassed(): boolean`, `perInput: InputGrades[]`. `InputGrades = { input, run, grades, gatesPassed }`. `inputObjective(grades): number` (exported).
- `AgentRun = { output: JSON; recordPath: string }` (`grading/types.ts`).
- `Grade = { score; feedback? }` (`grading/types.ts`).
- Registry: `registerOptimizer`/`getOptimizer`/`listOptimizers` (`registry.ts`); `Optimizer`/`OptimizerFactory`/`BaseOptimizerConfig`/`OptimizeTarget` (`optimizer.ts`). `BaseOptimizerConfig` already carries `seed?: number`.
- Proposer pattern: `lib/agents/mutatePrompt.agency` owns the LLM call + structured output; `mutator.ts` renders deterministic data sections and validates with `MutationProposalSchema` (currently **not** exported — Task 5 exports it). `buildMutatorSections` (`mutator.ts`) renders the targets/goals/history/diagnostics sections.
- `OptimizeSourceMutator.preview(operations) → { files, targetSet, diagnostics }` (`sourceMutator.ts`); `discoverOptimizeTargets(entryFile) → OptimizeTargetSet` with `{ baseDir, entryFile, targets: OptimizeTarget[], files }` (`targets.ts`); `resolveEvalRunTarget(agent).agentFile` (`cli/eval/run.js`).
- `WorkspaceManager` (`workspace.ts`): `fork(dir)`, `applyFiles(ws, files)`, `writeBack(source, championFiles)`.
- `AgencyRunner.runStructured(file, node, args: JSON[], zodSchema)` (`grading/agencyRunner.ts`) — positional args, validated.
- `OptimizeResult`/`IterationResult`/`OptimizeDecision` (`types.ts`); `EvalRecord`/`NormalizedEvent`/`ErrorEntry` (`lib/eval/types.ts`).

If any signature differs from the above, adjust the GEPA code to match the merged surface rather than the snippets here.

## Before you start

- Fresh worktree/branch from updated `main`; `pnpm install && pnpm run build && pnpm run agency compile stdlib/` once.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- These tests don't require LLM calls — every LLM/agent interaction is injected. Don't add real LLM calls except the optional Task 8 smoke. These are Vitest TS tests, so run them with `pnpm test:run <path>`.

## File Structure

- Modify: `lib/optimize/baseOptimizer.ts` — hoist `requireBaselineGatesPass` + `buildPointwiseResult` (Task 0).
- Modify: `lib/optimize/targets.ts` — export shared `fileMap` (Task 0).
- Modify: `lib/optimize/sourceMutator.ts` — export shared `defaultPreview` (Task 0).
- Modify: `lib/optimize/mutator.ts` — export `renderTargetsSection` and `MutationProposalSchema` (Tasks 0, 5).
- Modify: `lib/optimize/greedyReflective.ts` — consume the hoisted helpers (Task 0).
- Create: `lib/optimize/rng.ts` (Task 1), `lib/optimize/pareto.ts` (Task 2), `lib/optimize/candidatePool.ts` (Task 3), `lib/optimize/gepaFeedback.ts` (Task 4), `lib/optimize/gepaReflect.ts` (Task 5), `lib/optimize/gepa.ts` (Task 6).
- Create: `lib/agents/gepaReflect.agency` — reflective proposer carrying the Appendix-C meta-prompt (Task 5).
- Modify: `lib/optimize/registry.ts` — register `gepa` (Task 7).
- Modify: `lib/cli/eval/optimize.ts`, `scripts/agency.ts` — `--minibatch`, `--seed` (Task 7).
- Tests: co-located.

---

### Task 0: Hoist shared helpers (de-duplicate before GEPA reuses them)

GEPA and greedy share the baseline-gate check, the result builder, the preview wrapper, the target-set file map, and the targets-section renderer. Hoist each to one home and have **greedy** consume it, so GEPA reuses rather than duplicates.

**Files:**
- Modify: `lib/optimize/baseOptimizer.ts`, `lib/optimize/targets.ts`, `lib/optimize/sourceMutator.ts`, `lib/optimize/mutator.ts`, `lib/optimize/greedyReflective.ts`
- Tests: existing `baseOptimizer.test.ts` / `greedyReflective.test.ts` / `mutator.test.ts` stay green; add base tests for the two new base methods.

- [ ] **Step 1 (test first):** In `baseOptimizer.test.ts`, via a tiny concrete subclass: (a) `requireBaselineGatesPass` throws naming the failing must-pass grader when a gate fails, and does not throw when gates pass; (b) `buildPointwiseResult({ championIter, championFiles, attempts })` returns an `OptimizeResult` with a leading `baseline` iteration, one entry per attempt, and correct `acceptedCount`/`rejectedCount`/`validationFailedCount`.

- [ ] **Step 2: `baseOptimizer.ts`** — add two protected members + a module-level helper:

```ts
import type { IterationResult, OptimizeDecision, OptimizeResult } from "./types.js";
import { Scorecard } from "./grading/scorecard.js";

// inside BaseOptimizer:
/** Refuse to optimize a program whose baseline already fails a must-pass grader. */
protected requireBaselineGatesPass(scorecard: Scorecard): void {
  if (scorecard.gatesPassed()) return;
  const failed = failingGraders(scorecard);
  throw new Error(
    `Baseline fails must-pass grader(s) [${failed.join(", ")}] — fix the program or those graders before optimizing.`,
  );
}

/** Build the pointwise OptimizeResult shared by greedy and GEPA. winsA/winsB/ties are
 *  pairwise-judge artifacts that pointwise optimizers leave at 0. */
protected buildPointwiseResult(args: {
  championIter: number | "baseline";
  championFiles: Record<string, string>;
  attempts: { iter: number; decision: OptimizeDecision }[];
}): OptimizeResult {
  const count = (d: OptimizeDecision): number => args.attempts.filter((a) => a.decision === d).length;
  const baselineIteration: IterationResult = { iter: 0, decision: "baseline", winsA: 0, winsB: 0, ties: 0 };
  return {
    runId: this.config.runId,
    runDir: path.join(this.config.runsDir, this.config.runId),
    championIter: args.championIter,
    championFiles: args.championFiles,
    acceptedCount: count("accepted"),
    rejectedCount: count("rejected"),
    validationFailedCount: count("validation-failed"),
    iterations: [baselineIteration, ...args.attempts.map((a) => ({ iter: a.iter, decision: a.decision, winsA: 0, winsB: 0, ties: 0 }))],
  };
}

// module-level:
function failingGraders(scorecard: Scorecard): string[] {
  const names = scorecard.perInput.flatMap((input) =>
    input.grades.filter((g) => g.grader.mustPass() && !g.grader.passes(g.grade)).map((g) => g.grader.name()),
  );
  return names.filter((name, i) => names.indexOf(name) === i);
}
```

- [ ] **Step 3: `targets.ts`** — export the file-map helper (greedy currently has a private copy):

```ts
/** A relpath→source map for a target set (e.g. the unchanged baseline file set). */
export function fileMap(source: OptimizeTargetSet): Record<string, string> {
  return Object.fromEntries(Object.entries(source.files).map(([rel, sf]) => [rel, sf.source]));
}
```

- [ ] **Step 4: `sourceMutator.ts`** — export the preview wrapper (greedy currently has a private copy):

```ts
export function defaultPreview(targetSet: OptimizeTargetSet, operations: OptimizeMutationOperation[]): OptimizeMutationPreview {
  return new OptimizeSourceMutator({ targetSet }).preview(operations);
}
```

  (Import `OptimizeTargetSet` from `./targets.js` if not already in scope.)

- [ ] **Step 5: `mutator.ts`** — extract the targets-section renderer so `buildMutatorSections` and GEPA share it, and export the proposal schema:

```ts
import type { OptimizeTarget } from "./targets.js";

/** Render a list of optimize targets as the prompt's TARGETS section. */
export function renderTargetsSection(targets: OptimizeTarget[]): string {
  return [...targets]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((target) => [`- id: ${target.id}`, `  kind: ${target.kind}`, `  current value: ${JSON.stringify(target.value)}`].join("\n"))
    .join("\n");
}

export const MutationProposalSchema = /* existing schema, now exported */;
```

  Change `buildMutatorSections` to call `renderTargetsSection(inputs.targets)` for its `targets` field instead of the inline `.map`.

- [ ] **Step 6: `greedyReflective.ts`** — delete its private `requireBaselineGatesPass`, `failingGraders`, `buildResult`, `defaultPreview`, and `fileMap`; import the shared ones (`fileMap` from `./targets.js`, `defaultPreview` from `./sourceMutator.js`), and replace `this.requireBaselineGatesPass(baseline)`/`this.buildResult(champion, attempts)` with the base versions: `this.requireBaselineGatesPass(baseline.scorecard)` and `this.buildPointwiseResult({ championIter: champion.iter, championFiles: champion.files, attempts })`.

- [ ] **Step 7: Run** `pnpm test:run lib/optimize/baseOptimizer.test.ts lib/optimize/greedyReflective.test.ts lib/optimize/mutator.test.ts` — all green.

- [ ] **Step 8: Commit** `refactor(optimize): hoist shared baseline/result/preview/target helpers into base`.

---

### Task 1: Seeded RNG + sampling helpers

**Files:** Create `lib/optimize/rng.ts`; test `lib/optimize/rng.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { makeRng, sampleWithoutReplacement, weightedPick } from "./rng.js";

describe("rng", () => {
  it("is deterministic for a given seed", () => {
    const a = makeRng(42); const b = makeRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("sampleWithoutReplacement returns k distinct items from the source", () => {
    const picked = sampleWithoutReplacement([1, 2, 3, 4, 5], 3, makeRng(1));
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
    expect(picked.every((x) => [1, 2, 3, 4, 5].includes(x))).toBe(true);
  });

  it("sampleWithoutReplacement returns all items when k exceeds the source size", () => {
    expect(sampleWithoutReplacement([1, 2], 5, makeRng(1)).sort()).toEqual([1, 2]);
  });

  it("weightedPick never selects a zero-weight item", () => {
    const rng = makeRng(7);
    for (let i = 0; i < 50; i += 1) {
      const pick = weightedPick([{ item: "a", weight: 0 }, { item: "b", weight: 1 }], rng);
      expect(pick).toBe("b");
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm test:run lib/optimize/rng.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
export type Rng = () => number;   // returns a float in [0, 1)

/** mulberry32 — small, fast, deterministic PRNG. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleWithoutReplacement<T>(items: T[], k: number, rng: Rng): T[] {
  const pool = [...items];
  const out: T[] = [];
  const take = Math.min(k, pool.length);
  for (let i = 0; i < take; i += 1) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

export function weightedPick<T>(weighted: { item: T; weight: number }[], rng: Rng): T {
  const total = weighted.reduce((sum, w) => sum + Math.max(0, w.weight), 0);
  if (total <= 0) throw new Error("weightedPick: no positive-weight items");
  let r = rng() * total;
  for (const w of weighted) {
    r -= Math.max(0, w.weight);
    if (r < 0) return w.item;
  }
  return weighted[weighted.length - 1].item;
}
```

- [ ] **Step 4: Run to verify it passes** — PASS (4).

- [ ] **Step 5: Commit** `feat(optimize): add seeded RNG and sampling helpers`.

---

### Task 2: Pareto frontier

**Files:** Create `lib/optimize/pareto.ts`; test `lib/optimize/pareto.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { paretoFrontier, sampleFrontier } from "./pareto.js";
import { makeRng } from "./rng.js";

describe("paretoFrontier", () => {
  it("keeps candidates that are best on at least one input and excludes the dominated", () => {
    const pool = [
      { item: "A", scores: [0.9, 0.2, 0.5] },
      { item: "B", scores: [0.3, 0.8, 0.5] },
      { item: "C", scores: [0.4, 0.4, 0.4] },
    ];
    const members = paretoFrontier(pool);
    expect(members.map((m) => m.item).sort()).toEqual(["A", "B"]);
    expect(members.find((m) => m.item === "A")!.wins).toBe(2);
    expect(members.find((m) => m.item === "B")!.wins).toBe(2);
  });

  it("sampleFrontier only ever returns a frontier member", () => {
    const pool = [
      { item: "A", scores: [1, 0] },
      { item: "B", scores: [0, 1] },
      { item: "C", scores: [0.1, 0.1] },
    ];
    const rng = makeRng(3);
    for (let i = 0; i < 50; i += 1) {
      expect(["A", "B"]).toContain(sampleFrontier(pool, rng));
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

```ts
import { weightedPick, type Rng } from "./rng.js";

export type Scored<T> = { item: T; scores: number[] };

/** Candidates that achieve the best score on at least one input, with their win counts.
 *  GEPA's "best on ≥1 input" frontier — NOT full multi-objective dominance. */
export function paretoFrontier<T>(pool: Scored<T>[]): { item: T; wins: number }[] {
  if (pool.length === 0) return [];
  const inputCount = pool[0].scores.length;
  const best = Array.from({ length: inputCount }, (_unused, i) => Math.max(...pool.map((c) => c.scores[i])));
  return pool
    .map((c) => ({ item: c.item, wins: best.filter((b, i) => c.scores[i] >= b).length }))
    .filter((m) => m.wins > 0);
}

/** Sample a frontier member weighted by how many inputs it wins. */
export function sampleFrontier<T>(pool: Scored<T>[], rng: Rng): T {
  const members = paretoFrontier(pool);
  return weightedPick(members.map((m) => ({ item: m.item, weight: m.wins })), rng);
}
```

- [ ] **Step 4: Run to verify it passes** — PASS (2).

- [ ] **Step 5: Commit** `feat(optimize): add Pareto frontier over per-input score vectors`.

---

### Task 3: `CandidatePool`

`PoolCandidate<T>` is generic. **In GEPA, `T` is the full `Candidate`** so reflection reaches the parent's `perInput` grades and traces. The string-payload test exercises pool mechanics in isolation; don't narrow the type.

**Files:** Create `lib/optimize/candidatePool.ts`; test `lib/optimize/candidatePool.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { CandidatePool, type PoolCandidate } from "./candidatePool.js";
import { makeRng } from "./rng.js";

const cand = (id: string, scores: number[], objective: number): PoolCandidate<string> => ({
  value: id, inputScores: scores, objective,
});

describe("CandidatePool", () => {
  it("returns the best candidate by objective", () => {
    const pool = new CandidatePool([cand("a", [1, 0], 0.5), cand("b", [0.9, 0.9], 0.9)]);
    expect(pool.best().value).toBe("b");
  });

  it("samples a parent from the Pareto frontier", () => {
    const pool = new CandidatePool([cand("a", [1, 0], 0.5), cand("b", [0, 1], 0.5), cand("c", [0.1, 0.1], 0.1)]);
    const rng = makeRng(5);
    for (let i = 0; i < 30; i += 1) expect(["a", "b"]).toContain(pool.sampleParent(rng).value);
  });

  it("grows when a candidate is added", () => {
    const pool = new CandidatePool([cand("a", [1], 1)]);
    pool.add(cand("b", [0.5], 0.5));
    expect(pool.size()).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

```ts
import { sampleFrontier, type Scored } from "./pareto.js";
import type { Rng } from "./rng.js";

/** A pool member: a payload plus the score vector/objective the frontier reasons over.
 *  In GEPA, `value` is the full Candidate (ws + scorecard + files). */
export type PoolCandidate<T> = { value: T; inputScores: number[]; objective: number };

export class CandidatePool<T> {
  constructor(private readonly candidates: PoolCandidate<T>[]) {}
  add(candidate: PoolCandidate<T>): void { this.candidates.push(candidate); }
  size(): number { return this.candidates.length; }
  best(): PoolCandidate<T> { return this.candidates.reduce((top, c) => (c.objective > top.objective ? c : top)); }
  sampleParent(rng: Rng): PoolCandidate<T> {
    const scored: Scored<PoolCandidate<T>>[] = this.candidates.map((c) => ({ item: c, scores: c.inputScores }));
    return sampleFrontier(scored, rng);
  }
}
```

- [ ] **Step 4: Run to verify it passes** — PASS (3).

- [ ] **Step 5: Commit** `feat(optimize): add CandidatePool (best + Pareto parent sampling)`.

---

### Task 4: Reflection feedback rendering (trace → prompt block) — the GEPA learning signal

Turns one graded input into the natural-language block GEPA shows the reflector: input args, output, errors, a compact tool-call trace, and grader feedback — bounded. Loads the `EvalRecord` from `run.recordPath`; **degrades to grades-only feedback (logging a warning, never throwing)** if the trace is missing/corrupt, so a bad trace can't crash the loop.

**Files:** Create `lib/optimize/gepaFeedback.ts`; test `lib/optimize/gepaFeedback.test.ts`.

- [ ] **Step 1: Write the failing test** (writes a temp eval-record JSON; no LLM):

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { renderInputFeedback, renderReflectionFeedback } from "./gepaFeedback.js";
import type { InputGrades } from "./grading/scorecard.js";

function writeRecord(record: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gepa-fb-"));
  const file = path.join(dir, "eval-record.json");
  fs.writeFileSync(file, JSON.stringify(record));
  return file;
}

const fakeGrader = (name: string) => ({ name: () => name } as unknown as InputGrades["grades"][number]["grader"]);

function entry(recordPath: string): InputGrades {
  return {
    input: { id: "q1", args: { question: "capital of France?" } },
    run: { output: "Paris", recordPath },
    gatesPassed: true,
    grades: [{ grader: fakeGrader("goal"), grade: { score: { kind: "scalar", value: 0.4 }, feedback: "too terse" } }],
  };
}

describe("renderInputFeedback", () => {
  it("renders input, output, errors, tool calls, and grader feedback", () => {
    const recordPath = writeRecord({
      errors: [{ tMs: 1, errorType: "validationError", message: "missing field x", spanId: null }],
      events: [
        { kind: "tool_start", tool: "search", argsPreview: "{q:France}", model: null, tMs: 1, threadId: null, spanId: null, parentSpanId: null },
        { kind: "tool_end", tool: "search", outputPreview: "Paris is the capital", durationMs: 5, tMs: 2, threadId: null, spanId: null, parentSpanId: null },
      ],
    });
    const text = renderInputFeedback(entry(recordPath));
    expect(text).toContain("q1");
    expect(text).toContain("Paris");
    expect(text).toContain("missing field x");
    expect(text).toContain("search");
    expect(text).toContain("too terse");
  });

  it("degrades to grades-only feedback when the trace is missing (never throws)", () => {
    const text = renderInputFeedback(entry("/no/such/record.json"));
    expect(text).toContain("too terse");
    expect(text).not.toContain("Tool calls:");
  });

  it("clamps output to the char budget", () => {
    const recordPath = writeRecord({ errors: [], events: [] });
    const e = entry(recordPath);
    e.run.output = "x".repeat(5000);
    expect(renderInputFeedback(e, { maxChars: 500 }).length).toBeLessThanOrEqual(540);
  });

  it("renderReflectionFeedback concatenates focus entries as given", () => {
    const recordPath = writeRecord({ errors: [], events: [] });
    const text = renderReflectionFeedback([entry(recordPath), entry(recordPath)]);
    expect(text.match(/### Input/g)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement.** Note the `formatScore` helper — extracted so the scalar-vs-binary formatting is not a nested ternary and is reusable.

```ts
import * as fs from "fs";

import type { EvalRecord, NormalizedEvent } from "@/eval/types.js";

import { inputObjective, type InputGrades } from "./grading/scorecard.js";
import type { Score } from "./grading/types.js";

export type ReflectionRenderOptions = { maxChars?: number };

const DEFAULT_MAX_CHARS = 2000;

/** One graded input rendered as a GEPA feedback block. Bounded. */
export function renderInputFeedback(entry: InputGrades, opts: ReflectionRenderOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const record = loadRecord(entry.run.recordPath);
  const lines: string[] = [];
  const objective = inputObjective(entry.grades).toFixed(3);
  lines.push(`### Input ${entry.input.id ?? "(no id)"} — objective ${objective}${entry.gatesPassed ? "" : " (GATE FAILED)"}`);
  lines.push(`Args: ${preview(JSON.stringify(entry.input.args), 400)}`);
  lines.push(`Output: ${preview(stringifyOutput(entry.run.output), 600)}`);

  const errors = record?.errors ?? [];
  if (errors.length > 0) {
    lines.push("Errors:");
    for (const e of errors) lines.push(`  - [${e.errorType}] ${preview(e.message, 300)}`);
  }
  const toolLines = renderTools(record?.events ?? []);
  if (toolLines.length > 0) {
    lines.push("Tool calls:");
    lines.push(...toolLines.map((l) => `  ${l}`));
  }
  lines.push("Feedback:");
  for (const g of entry.grades) {
    lines.push(`  - ${g.grader.name()} = ${formatScore(g.grade.score)}${g.grade.feedback ? `: ${preview(g.grade.feedback, 400)}` : ""}`);
  }
  return clamp(lines.join("\n"), maxChars);
}

/** Render an already-sorted (weakest-first) set of focus inputs as one feedback section. */
export function renderReflectionFeedback(focus: InputGrades[], opts: ReflectionRenderOptions = {}): string {
  return focus.map((entry) => renderInputFeedback(entry, opts)).join("\n\n");
}

function formatScore(score: Score): string {
  if (score.kind === "scalar") return score.value.toFixed(3);
  return score.pass ? "pass" : "fail";
}

function renderTools(events: NormalizedEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind === "tool_start") out.push(`→ ${e.tool}(${preview(e.argsPreview, 200)})`);
    else if (e.kind === "tool_end") out.push(`← ${e.tool}: ${preview(e.outputPreview, 200)}`);
  }
  return out;
}

/** A missing/corrupt trace degrades to grades-only feedback — log and continue, never crash. */
function loadRecord(recordPath: string): EvalRecord | null {
  try {
    return JSON.parse(fs.readFileSync(recordPath, "utf8")) as EvalRecord;
  } catch (e) {
    console.warn(`gepa: could not read trace ${recordPath}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function stringifyOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function preview(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function clamp(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n…[trace truncated]`;
}
```

- [ ] **Step 4: Run to verify it passes** — PASS (4).

- [ ] **Step 5: Commit** `feat(optimize): render execution traces into GEPA reflection feedback`.

---

### Task 5: Reflective proposer (`.agency` agent with the GEPA meta-prompt + TS wrapper)

The agent carries the paper's Appendix-C meta-prompt, adapted only to emit the existing operation schema so `OptimizeSourceMutator.preview` consumes it unchanged.

**Files:** Modify `lib/optimize/mutator.ts` (schema export done in Task 0); create `lib/agents/gepaReflect.agency`, `lib/optimize/gepaReflect.ts`; test `lib/optimize/gepaReflect.test.ts`.

- [ ] **Step 1: Author the agent.** Read `lib/agents/mutatePrompt.agency` first for house syntax, then create `lib/agents/gepaReflect.agency`. Keep the `OptimizeMutationOperation`/`OptimizeMutationProposal` types and the operation contract identical to `mutatePrompt.agency` (`op: "replaceInitializer"`, `value` is Agency source text *including surrounding quotes*, preserve every interpolation placeholder). Replace the prompt body with the GEPA meta-prompt:

```text
type OptimizeMutationOperation = {
  target: string;
  kind: string;
  op: string;
  value: string;
  rationale: string
}

type OptimizeMutationProposal = {
  operations: OptimizeMutationOperation[];
  rationale: string
}

node gepaReflect(
  targets: string,
  feedback: string,
  history: string,
): OptimizeMutationProposal {
  const prompt = """
  I provided an assistant with the following instructions to perform a task for me.
  Each OPTIMIZE TARGET below is one current instruction you may rewrite:

  OPTIMIZE TARGETS:
  ${targets}

  The following are examples of task inputs given to the assistant, the assistant's
  response for each, its execution trace (errors and tool calls), and feedback on how
  the response could be better:

  ${feedback}

  ${history}

  YOUR TASK:
  Write new instructions for the optimize target(s) above so the assistant performs better.

  Read the inputs carefully and identify the input format and infer a detailed task
  description for what the assistant must do. Read all the assistant responses, traces, and
  feedback. Identify all niche and domain-specific factual information about the task and
  include it in the instruction — a lot of it may not be available to the assistant in the
  future. If the assistant used a generalizable strategy to solve the task, include that too.

  Return JSON with:
  - "operations": one record per target you change. Each record needs "target" and "kind"
    copied exactly from the list above, "op" set to "replaceInitializer", "value" with the
    rewritten instruction as Agency source text including the surrounding quotes, and
    "rationale" with one sentence on what you changed. The replacement MUST preserve every
    interpolation placeholder the current value uses (no drops, no additions).
  - "rationale": 2-4 sentences explaining the overall change.
  """
  const proposal: OptimizeMutationProposal = llm(prompt)
  return proposal
}
```

- [ ] **Step 2: Write the failing test** for the wrapper (stubbed runner — no LLM):

```ts
import { describe, expect, it } from "vitest";

import { AgencyRunner } from "./grading/agencyRunner.js";
import { proposeReflective } from "./gepaReflect.js";

describe("proposeReflective", () => {
  it("returns a validated mutation proposal from the reflective agent", async () => {
    const runner = new AgencyRunner({}, async () => ({
      data: {
        rationale: "tighten the prompt",
        operations: [{ target: "agent.agency:global:prompt", kind: "variable", op: "replaceInitializer", value: "\"Be concise.\"", rationale: "shorter" }],
      },
    }));
    const proposal = await proposeReflective(runner, { targets: "id: prompt", feedback: "[q1] too verbose", history: "" });
    expect(proposal.rationale).toBe("tighten the prompt");
    expect(proposal.operations).toHaveLength(1);
  });

  it("throws on a malformed reflective response", async () => {
    const runner = new AgencyRunner({}, async () => ({ data: { rationale: "" } }));
    await expect(proposeReflective(runner, { targets: "", feedback: "", history: "" })).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify it fails** — FAIL.

- [ ] **Step 4: Implement** `lib/optimize/gepaReflect.ts`:

```ts
import * as path from "path";
import { fileURLToPath } from "url";

import type { AgencyRunner } from "./grading/agencyRunner.js";
import type { JSON } from "./grading/types.js";
import { MutationProposalSchema } from "./mutator.js";
import type { MutationProposal } from "./types.js";

export type ReflectionSections = { targets: string; feedback: string; history: string };

/** Run the GEPA reflective proposer and validate its structured proposal. */
export async function proposeReflective(runAgency: AgencyRunner, sections: ReflectionSections): Promise<MutationProposal> {
  const agentFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../agents/gepaReflect.agency");
  const args: JSON[] = [sections.targets, sections.feedback, sections.history];
  return runAgency.runStructured(agentFile, "gepaReflect", args, MutationProposalSchema) as Promise<MutationProposal>;
}
```

- [ ] **Step 5: Run to verify it passes** — PASS (2).

- [ ] **Step 6: Commit** `feat(optimize): add GEPA reflective proposer (Appendix-C meta-prompt) + wrapper`.

---

### Task 6: `Gepa` optimizer (full implementation, declaratively decomposed)

`Gepa extends BaseOptimizer`. Structure mirrors `GreedyReflective`: `optimize()` orchestrates (the *what*), `evolve()` runs the loop + pool threading (like `hillClimb`), `attempt()` is one iteration (propose → validate → minibatch filter → maybe full eval), and small helpers carry the *how*. No imperative mega-loop, no duplicated helpers (reuses the Task-0 hoisted ones).

Design points: **SelectModule** round-robins one target per iteration (clean credit attribution; `moduleSelection: "all"` opts out). **Two input sets** — the seeded minibatch is the cheap filter; the fixed Pareto set (`config.paretoSet ?? target.inputs`) is what admitted candidates are scored on so their `inputScores` vectors are comparable. The parent's minibatch re-grade hits the `EvalCache` (parent was already scored on the full set) — load-bearing for sample-efficiency, asserted in the test.

**Files:** Create `lib/optimize/gepa.ts`; test `lib/optimize/gepa.test.ts`.

- [ ] **Step 1: Write the failing test.** Drive `Gepa` through injected services (no LLM/agent), 3 inputs, ~3 iterations, seeded rng. Inject via deps: `discover` (fixed `OptimizeTargetSet`), `preview` (returns `{ files, targetSet, diagnostics: [] }`), `propose` (fixed `MutationProposal`, and spy the `targets` section it receives), and `runInput` (fake `AgentRun`, score controlled per workspace; spy call count). Assert:
  - (a) baseline admitted (pool starts at size 1);
  - (b) a child that beats its parent on the minibatch is scored on the full Pareto set and admitted (`pool.size()` grows);
  - (c) a child that loses on the minibatch is not admitted, and **no full-set eval runs for it** (rejected child triggers only `minibatch`-many fresh runs);
  - (d) re-grading the parent on the minibatch triggers **zero** new `runInput` calls (cache hits);
  - (e) `optimize()` returns `best()` and a well-formed `OptimizeResult` (baseline + one entry per attempt; counts correct);
  - (f) with `moduleSelection: "round-robin"`, the `targets` section passed to `propose` names a single target, rotating across iterations.

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement** `lib/optimize/gepa.ts`:

```ts
import { resolveEvalRunTarget } from "@/cli/eval/run.js";

import { BaseOptimizer, type BaseOptimizerDeps } from "./baseOptimizer.js";
import { CandidatePool, type PoolCandidate } from "./candidatePool.js";
import { renderReflectionFeedback } from "./gepaFeedback.js";
import { proposeReflective, type ReflectionSections } from "./gepaReflect.js";
import type { AgencyRunner } from "./grading/agencyRunner.js";
import { inputObjective, type Scorecard } from "./grading/scorecard.js";
import type { Input } from "./grading/types.js";
import { renderTargetsSection } from "./mutator.js";
import type { BaseOptimizerConfig, OptimizeTarget } from "./optimizer.js";
import { makeRng, sampleWithoutReplacement } from "./rng.js";
import { defaultPreview, type OptimizeMutationOperation, type OptimizeMutationPreview } from "./sourceMutator.js";
import { discoverOptimizeTargets, fileMap, type OptimizeTarget as OptimizeTargetDecl, type OptimizeTargetSet } from "./targets.js";
import type { MutationProposal, OptimizeDecision, OptimizeResult } from "./types.js";
import type { Workspace } from "./workspace.js";

export type GepaConfig = BaseOptimizerConfig & {
  minibatch: number;
  paretoSet?: Input[];
  moduleSelection?: "round-robin" | "all";
};

export type GepaDeps = BaseOptimizerDeps & {
  discover?: (agentFile: string) => OptimizeTargetSet;
  propose?: (runAgency: AgencyRunner, sections: ReflectionSections) => Promise<MutationProposal>;
  preview?: (targetSet: OptimizeTargetSet, operations: OptimizeMutationOperation[]) => OptimizeMutationPreview;
};

/** A fully-evaluated point in the search. */
type Candidate = {
  iter: number | "baseline";
  ws: Workspace;
  scorecard: Scorecard;
  targetSet: OptimizeTargetSet;
  files: Record<string, string>;
};

/** The immutable record of one iteration. */
type Attempt = { iter: number; decision: Exclude<OptimizeDecision, "baseline">; rationale: string; candidate?: Candidate };

/** GEPA: reflective evolution with a Pareto candidate pool and minibatched promotion. */
export class Gepa extends BaseOptimizer {
  readonly name = "gepa";
  private readonly gepaConfig: GepaConfig;

  constructor(config: GepaConfig, private readonly gepaDeps: GepaDeps = {}) {
    super(config, gepaDeps);
    this.gepaConfig = config;
  }

  async optimize(target: OptimizeTarget): Promise<OptimizeResult> {
    const agentFile = resolveEvalRunTarget(target.agent).agentFile;
    const source = (this.gepaDeps.discover ?? discoverOptimizeTargets)(agentFile);
    if (source.targets.length === 0) {
      throw new Error(`No optimize targets found in ${agentFile}. Mark a declaration with the optimize modifier.`);
    }
    const paretoInputs = this.gepaConfig.paretoSet ?? target.inputs;
    const rng = makeRng(this.config.seed ?? 0);

    const baseline = await this.makeCandidate("baseline", this.fork(source.baseDir), source, paretoInputs, fileMap(source));
    this.requireBaselineGatesPass(baseline.scorecard);

    const pool = new CandidatePool<Candidate>([toPoolCandidate(baseline)]);
    const attempts = await this.evolve(pool, target.inputs, paretoInputs, rng);

    const champion = pool.best().value;
    if (this.config.writeback && champion.iter !== "baseline") this.workspace.writeBack(source, champion.files);
    return this.buildPointwiseResult({ championIter: champion.iter, championFiles: champion.files, attempts });
  }

  /** Run the optimization loop, threading the pool. */
  private async evolve(pool: CandidatePool<Candidate>, inputs: Input[], paretoInputs: Input[], rng: () => number): Promise<Attempt[]> {
    const attempts: Attempt[] = [];
    for (let iter = 1; iter <= this.config.iterations; iter += 1) {
      const parent = pool.sampleParent(rng).value;
      const minibatch = sampleWithoutReplacement(inputs, this.gepaConfig.minibatch, rng);
      const attempt = await this.attempt(parent, minibatch, paretoInputs, iter);
      if (attempt.decision === "accepted" && attempt.candidate) pool.add(toPoolCandidate(attempt.candidate));
      attempts.push(attempt);
    }
    return attempts;
  }

  /** One reflective iteration: propose → validate → minibatch filter → (maybe) full eval. */
  private async attempt(parent: Candidate, minibatch: Input[], paretoInputs: Input[], iter: number): Promise<Attempt> {
    const proposal = await this.proposeFrom(parent, minibatch, iter);
    const preview = (this.gepaDeps.preview ?? defaultPreview)(parent.targetSet, proposal.operations);
    if (preview.diagnostics.length > 0) return { iter, decision: "validation-failed", rationale: proposal.rationale };

    const childWs = this.fork(parent.ws.dir);
    this.workspace.applyFiles(childWs, preview.files);
    const entry = preview.targetSet.entryFile;
    const childMini = await this.evaluate(childWs, entry, minibatch);
    const parentMini = await this.evaluate(parent.ws, parent.targetSet.entryFile, minibatch);   // cache hits
    if (!(childMini.gatesPassed() && childMini.objective() > parentMini.objective())) {
      return { iter, decision: "rejected", rationale: proposal.rationale };
    }
    const full = await this.evaluate(childWs, entry, paretoInputs);
    const candidate: Candidate = { iter, ws: childWs, scorecard: full, targetSet: preview.targetSet, files: preview.files };
    return { iter, decision: "accepted", rationale: proposal.rationale, candidate };
  }

  /** Build the reflection context (selected target + weakest-input traces) and ask the proposer. */
  private proposeFrom(parent: Candidate, minibatch: Input[], iter: number): Promise<MutationProposal> {
    const selected = this.selectTargets(parent.targetSet.targets, iter);
    const sections: ReflectionSections = {
      targets: renderTargetsSection(selected),
      feedback: renderReflectionFeedback(this.focus(parent, minibatch)),
      history: "",
    };
    return (this.gepaDeps.propose ?? proposeReflective)(this.agencyRunner, sections);
  }

  /** Round-robin one target per iteration (SelectModule); `"all"` shows every target. */
  private selectTargets(targets: OptimizeTargetDecl[], iter: number): OptimizeTargetDecl[] {
    if (this.gepaConfig.moduleSelection === "all") return targets;
    return [targets[(iter - 1) % targets.length]];
  }

  /** The parent's weakest minibatch inputs (by reference), weakest first; falls back to all. */
  private focus(parent: Candidate, minibatch: Input[]) {
    const batch = new Set(minibatch);
    const matched = parent.scorecard.perInput.filter((pi) => batch.has(pi.input));
    const focus = matched.length > 0 ? matched : [...parent.scorecard.perInput];
    return [...focus]
      .sort((a, b) => inputObjective(a.grades) - inputObjective(b.grades))
      .slice(0, this.gepaConfig.minibatch);
  }

  /** Apply files into a workspace and grade on `inputs`. */
  private async makeCandidate(
    iter: number | "baseline", ws: Workspace, targetSet: OptimizeTargetSet, inputs: Input[], files: Record<string, string>,
  ): Promise<Candidate> {
    this.workspace.applyFiles(ws, files);
    const scorecard = await this.evaluate(ws, targetSet.entryFile, inputs);
    return { iter, ws, scorecard, targetSet, files };
  }
}

function toPoolCandidate(c: Candidate): PoolCandidate<Candidate> {
  return { value: c, inputScores: c.scorecard.inputScores(), objective: c.scorecard.objective() };
}
```

  > Notes: (1) For the baseline, `makeCandidate` applies the unchanged `fileMap(source)` — a no-op write that keeps one code path. (2) `OptimizeTarget` collides between `targets.ts` (declaration) and `optimizer.ts` (`{agent, inputs}`); the import aliases the declaration as `OptimizeTargetDecl`. Verify both exports at execution time. (3) If `defaultPreview`/`fileMap`/`renderTargetsSection`/`OptimizeMutationPreview`/`OptimizeMutationOperation` are exported from different modules than assumed, fix the imports — they were hoisted in Task 0.

- [ ] **Step 4: Run to verify it passes** — `pnpm test:run lib/optimize/gepa.test.ts` → PASS.

- [ ] **Step 5: Commit** `feat(optimize): add GEPA optimizer (Pareto pool + minibatch promotion + SelectModule)`.

---

### Task 7: Register `gepa` + CLI flags

**Files:** Modify `lib/optimize/registry.ts`, `lib/cli/eval/optimize.ts`, `scripts/agency.ts`; test `registry.test.ts`, `optimize.test.ts`.

- [ ] **Step 1 (test first):** In `registry.test.ts`, assert `getOptimizer("gepa", <config-with-minibatch>).name === "gepa"` and `"gepa"` ∈ `listOptimizers()`. In `optimize.test.ts`, assert `buildConfig({ optimizer: "gepa", minibatch: 4, ... })` carries `minibatch: 4`, and the default greedy path is unchanged.

- [ ] **Step 2:** Register `registerOptimizer("gepa", (config) => new Gepa(config as GepaConfig))`.

- [ ] **Step 3:** `optimize.ts`: add `minibatch?: number` / `seed?: number` to `EvalOptimizeOptions`; in `buildConfig` set `seed: opts.seed`, and when `opts.optimizer === "gepa"` include `minibatch: opts.minibatch ?? DEFAULT_MINIBATCH` (`= 8`). The extra field flows through `getOptimizer(name, config)` and the factory casts.

- [ ] **Step 4:** `scripts/agency.ts` optimize command: `.option("--minibatch <n>", "GEPA minibatch size", parseInt)`, `.option("--seed <n>", "RNG seed for reproducible search", parseInt)`; add the two fields to the action options type.

- [ ] **Step 5:** Run `pnpm test:run lib/optimize/registry.test.ts lib/cli/eval/optimize.test.ts` — green (incl. unknown-optimizer and default-greedy).

- [ ] **Step 6: Commit** `feat(optimize): register gepa optimizer and wire --minibatch/--seed`.

---

### Task 8: Verification

- [ ] `pnpm test:run lib/optimize lib/cli/eval/optimize.test.ts` — all green (save output to a file).
- [ ] `pnpm typecheck` and `pnpm run lint:structure` — clean.
- [ ] `pnpm run build && pnpm run agency compile stdlib/` — clean (the new `.agency` agent compiles).
- [ ] **Optional integration smoke (needs build + LLM):** run against a small **trace-bearing** agent (makes ≥1 tool call): `agency eval optimize <file> --tasks <suite> --optimizer gepa --iterations 5 --minibatch 4 --seed 0`; confirm a champion + `summary.json`. Save output.
- [ ] Open PR "Phase 5 — GEPA optimizer".

---

## Non-goals & risks

- **System-aware Merge (crossover)** is out of scope — the paper's separate "GEPA+Merge" variant; helps only multi-module systems with complementary lineages.
- **Stochastic graders / nondeterministic agents.** The `EvalCache` stores one run per `(ws, input)`. With `samples > 1` or a nondeterministic agent, the parent's cached minibatch run won't reflect sampling variance, weakening the comparison. Acceptable for the first build; documented.
- **Trace size.** Task 4 bounds each block (`maxChars`, default 2000). Raise the budget rather than removing the clamp.
- **Pool growth.** Admitted candidates' workspaces persist on disk; pruning dominated candidates is a later optimization.
- **`paretoSet` ≠ `inputs`.** `focus()` falls back to the weakest Pareto-set entries when the minibatch can't be matched against the parent's `perInput`. The default keeps them aligned.

## Self-Review (completed during planning)

- **Both GEPA gaps are first-class:** traces → Task 4; the Appendix-C meta-prompt → Task 5.
- **No pseudocode in the heart:** Task 6 is full TS, decomposed (`optimize`/`evolve`/`attempt`/`proposeFrom`/`focus`/`makeCandidate`) to match `GreedyReflective` and keep the loop declarative — the "what" in `optimize`, the "how" in helpers.
- **Anti-pattern fixes applied:** (1) imperative mega-loop replaced by the decomposition above, consistent with greedy; (2) `loadRecord`'s catch now logs before degrading (no silent swallow); (3) score formatting extracted to `formatScore` (no nested ternary); (4) duplicated helpers (`fileMap`, `defaultPreview`, `renderTargetsSection`, result builder, baseline-gate check) hoisted in Task 0 and consumed by both optimizers.
- **Cache invariant asserted:** Task 6's test checks no full eval on rejection and zero new runs on parent re-grade.
- **Type consistency:** `Rng` shared across rng/pareto/candidatePool/gepa; `Scored<T>` shared; `MutationProposalSchema` reused so GEPA validation == greedy's; `OptimizeTarget` collision aliased as `OptimizeTargetDecl`.

## Phase series complete

With Phases 1–5 the framework supports a registry of optimizers (greedy, GEPA), grader-based pointwise evaluation (deterministic, LLM, human), reusable agent-running/eval-cache services, and reflective trace-driven prompt evolution with a Pareto candidate pool. MIPROv2 + bootstrapped few-shot demos remain a separate future effort.
