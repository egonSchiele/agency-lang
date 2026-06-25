# Pluggable Optimizer Framework — Phase 2 (Grading Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, fully-tested grading foundation for the pluggable optimizer framework — `Grade`/`Score` types, `BaseGrader` (k-sampling + gating), `Scorecard`, and deterministic built-in graders — as additive code that is not yet wired into any optimizer (zero behavior change).

**Architecture:** A self-contained `lib/optimize/grading/` module. Graders are TypeScript classes: a user/author defines a single-shot `_run`, and `BaseGrader` orchestrates k-sample repetition + aggregation. A `Scorecard` value object derives gate/objective results from per-input grades. All Phase 2 graders are deterministic (no LLM, no agency-file execution), so the whole module is unit-testable with no LLM calls.

**Tech Stack:** TypeScript (ESM, `@/` path alias), Vitest.

**Source spec:** `docs/superpowers/specs/2026-06-17-pluggable-optimizer-framework-design.md`.

---

## Scope decision (read before starting)

The spec's "Phase 2" line bundles four things: the grading primitives, built-in graders, an
`EvalCache`, **and** migrating the `greedy` optimizer from pairwise judging to pointwise
scoring. While planning, two hard dependencies surfaced:

- **`LlmJudge`** (an LLM-judge built-in grader) must run a judge `.agency` file — that is the
  `AgencyRunner.structured` capability, scheduled for Phase 3.
- **The greedy pointwise migration** must run the agent per input and grade its output, which
  needs the agent-running abstraction (`WorkspaceManager` / `AgencyRunner`) and an `EvalCache`
  with a real consumer — also Phase 3.

Building `EvalCache` now would leave it unused/untested-in-context, and building `LlmJudge` or
migrating greedy now would pull Phase 3 forward into a single oversized, risky plan.

**Therefore this plan delivers only the grading foundation** — the pure, deterministic core
that everything else builds on. It is additive (nothing is wired into the live optimizer), so
it is **zero behavior change**, and it is fully unit-testable today.

**Deferred to Phase 3** (documented, not built here): `EvalCache`, `WorkspaceManager`,
`AgencyRunner.structured`, `LlmJudge`, and the greedy pointwise migration. **Phase 4:**
`HumanGrader`. **Phase 5:** GEPA.

Because `LlmJudge`/`HumanGrader` are deferred, the Phase 2 `GraderInput` deliberately contains
only `{ input, run }` — it does **not** include the `runAgency` / `requestHumanReview`
capabilities from the spec, which reference Phase 3/4 types. Phase 3 will extend `GraderInput`
with those fields. This keeps Phase 2 free of forward references to undefined types.

## File Structure

All new, under a new `lib/optimize/grading/` directory (keeps the growing framework organized;
Phase 1's `optimizer.ts`/`registry.ts`/`greedyReflective.ts` stay flat in `lib/optimize/`).

- Create: `lib/optimize/grading/types.ts` — `Json`, `JsonPath`, `Input`, `AgentRun`, `Score`, `Grade`, `GraderScope`, `GraderOptions`, `GraderInput`.
- Create: `lib/optimize/grading/aggregate.ts` — `aggregateGrades` (pure: k-trial reduction).
- Create: `lib/optimize/grading/baseGrader.ts` — `BaseGrader` abstract class.
- Create: `lib/optimize/grading/scorecard.ts` — `Scorecard` value object + `inputObjective`, `InputGrades`, `GraderGrade`.
- Create: `lib/optimize/grading/getPath.ts` — `getPath` (read a `JsonPath` out of arbitrary data).
- Create: `lib/optimize/grading/builtinGraders.ts` — `ExactMatchGrader`, `ContainsGrader`, `SimilarityGrader` + a private `levenshtein` helper.
- Tests (create): co-located `*.test.ts` for `aggregate`, `baseGrader`, `scorecard`, `getPath`, `builtinGraders`.

## Before you start

- Execute on a fresh worktree branched from the updated `main` (which now includes Phase 1).
  Use the `superpowers:using-git-worktrees` skill at execution time.
- When you reach a commit step, append the repo's co-author trailer to the commit message
  (`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`).
- Phase 2 is TypeScript-only under `lib/`. No `.agency`/stdlib changes, so you do **not** need
  to run `make`. Vitest runs TypeScript directly. (Note: a fresh worktree has no compiled
  `stdlib/index.js`; that only matters for tests that execute agents — none in this plan — and
  for `pnpm typecheck`. If `pnpm typecheck` errors on a missing `stdlib/index.js` import from
  unrelated files, run `pnpm run build && pnpm run agency compile stdlib/` once to populate it.)
- Run a single test file with: `pnpm test:run <path>`.

---

### Task 1: Core types + `aggregateGrades`

**Files:**
- Create: `lib/optimize/grading/types.ts`
- Create: `lib/optimize/grading/aggregate.ts`
- Test: `lib/optimize/grading/aggregate.test.ts`

- [ ] **Step 1: Create the types file**

Create `lib/optimize/grading/types.ts`:

```ts
/** A JSON-compatible value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A path of object keys / array indices into a Json value. */
export type JsonPath = (string | number)[];

/** One invocation of the agent under optimization. */
export type Input = {
  id?: string;                       // optional; callers auto-derive when omitted
  node?: string;                     // defaults to "main" at run time
  args: Record<string, Json>;
  metadata?: Record<string, Json>;   // freeform, grader-agnostic (title, expectedOutput, tags, …)
};

/** The result of running the agent on one input. */
export type AgentRun = {
  output: Json;        // the agent's return value
  recordPath: string;  // path to the full execution trace (eval record)
};

/** A grader's score: pass/fail or a continuous value. */
export type Score =
  | { kind: "binary"; pass: boolean }
  | { kind: "scalar"; value: number };

/** A grader's output: a score plus optional natural-language feedback. */
export type Grade = { score: Score; feedback?: string };

/** Restricts a grader to a subset of inputs. */
export type GraderScope = { tag: string } | { ids: string[] };

/** Options common to every grader; subclasses extend this with their own fields. */
export type GraderOptions = {
  mustPass?: boolean;            // gate: failure fails the whole iteration for this input
  threshold?: number;            // scalar passing bar (binary reads `pass`)
  weight?: number;               // contribution to the scalarized objective (default 1)
  samples?: number;              // k repetitions (default 1)
  aggregate?: "any" | "all";     // binary only; scalar always averages
  inputScope?: GraderScope;      // restrict to a subset of inputs (default: all)
  name?: string;                 // overrides the grader's defaultName
};

/** What a grader's `_run` receives. Phase 3 extends this with run-agency capabilities. */
export type GraderInput = {
  input: Input;
  run: AgentRun;
};
```

- [ ] **Step 2: Write the failing test for `aggregateGrades`**

Create `lib/optimize/grading/aggregate.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { aggregateGrades } from "./aggregate.js";
import type { Grade } from "./types.js";

const scalar = (value: number, feedback?: string): Grade => ({ score: { kind: "scalar", value }, feedback });
const binary = (pass: boolean, feedback?: string): Grade => ({ score: { kind: "binary", pass }, feedback });

describe("aggregateGrades", () => {
  it("averages scalar trials", () => {
    const result = aggregateGrades([scalar(0.2), scalar(0.4), scalar(0.6)], "all");
    if (result.score.kind !== "scalar") throw new Error("expected scalar");
    expect(result.score.value).toBeCloseTo(0.4, 10);
  });

  it("binary 'all' passes only when every trial passes", () => {
    expect(aggregateGrades([binary(true), binary(true)], "all").score).toEqual({ kind: "binary", pass: true });
    expect(aggregateGrades([binary(true), binary(false)], "all").score).toEqual({ kind: "binary", pass: false });
  });

  it("binary 'any' passes when at least one trial passes", () => {
    expect(aggregateGrades([binary(false), binary(true)], "any").score).toEqual({ kind: "binary", pass: true });
    expect(aggregateGrades([binary(false), binary(false)], "any").score).toEqual({ kind: "binary", pass: false });
  });

  it("concatenates non-empty feedback across trials", () => {
    const result = aggregateGrades([scalar(1, "good"), scalar(0, "bad"), scalar(0.5)], "all");
    expect(result.feedback).toBe("good\nbad");
  });

  it("omits feedback entirely when no trial provided any", () => {
    expect(aggregateGrades([scalar(1), scalar(0)], "all").feedback).toBeUndefined();
  });

  it("returns the single trial unchanged for samples=1", () => {
    expect(aggregateGrades([binary(true, "ok")], "all")).toEqual(binary(true, "ok"));
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test:run lib/optimize/grading/aggregate.test.ts`
Expected: FAIL — cannot resolve `./aggregate.js`.

- [ ] **Step 4: Implement `aggregateGrades`**

Create `lib/optimize/grading/aggregate.ts`:

```ts
import type { Grade } from "./types.js";

/**
 * Combine the k single-shot trials of one grader into a single Grade.
 * Scalar scores are averaged; binary scores use `any`/`all`; feedback is the
 * newline-joined non-empty feedback across trials (undefined if none).
 */
export function aggregateGrades(trials: Grade[], mode: "any" | "all"): Grade {
  const feedbacks = trials.map((t) => t.feedback).filter((f): f is string => Boolean(f));
  const feedback = feedbacks.length > 0 ? feedbacks.join("\n") : undefined;

  const scalars = trials.flatMap((t) => (t.score.kind === "scalar" ? [t.score.value] : []));
  if (scalars.length > 0) {
    const value = scalars.reduce((sum, v) => sum + v, 0) / scalars.length;
    return { score: { kind: "scalar", value }, ...(feedback ? { feedback } : {}) };
  }

  const passes = trials.map((t) => t.score.kind === "binary" && t.score.pass);
  const pass = mode === "any" ? passes.some(Boolean) : passes.every(Boolean);
  return { score: { kind: "binary", pass }, ...(feedback ? { feedback } : {}) };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test:run lib/optimize/grading/aggregate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/optimize/grading/types.ts lib/optimize/grading/aggregate.ts lib/optimize/grading/aggregate.test.ts
git commit -m "feat(optimize): add grading types and aggregateGrades"
```

---

### Task 2: `BaseGrader`

**Files:**
- Create: `lib/optimize/grading/baseGrader.ts`
- Test: `lib/optimize/grading/baseGrader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/optimize/grading/baseGrader.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { BaseGrader } from "./baseGrader.js";
import type { Grade, GraderInput, GraderOptions, Input } from "./types.js";

const input = (over: Partial<Input> = {}): Input => ({ id: "i1", args: {}, ...over });
const gi = (over: Partial<Input> = {}): GraderInput => ({ input: input(over), run: { output: null, recordPath: "" } });

/** Test grader whose single-shot grade is supplied per instance. */
class StubGrader extends BaseGrader {
  protected readonly defaultName = "stub";
  constructor(private readonly produce: () => Grade, options: GraderOptions = {}) {
    super(options);
  }
  protected _run(): Promise<Grade> {
    return Promise.resolve(this.produce());
  }
}

describe("BaseGrader", () => {
  it("uses defaultName, overridable via options.name", () => {
    expect(new StubGrader(() => ({ score: { kind: "binary", pass: true } })).name).toBe("stub");
    expect(new StubGrader(() => ({ score: { kind: "binary", pass: true } }), { name: "custom" }).name).toBe("custom");
  });

  it("exposes isGate and weight from options with defaults", () => {
    const g = new StubGrader(() => ({ score: { kind: "scalar", value: 1 } }), { mustPass: true, weight: 3 });
    expect(g.isGate).toBe(true);
    expect(g.weight).toBe(3);
    const d = new StubGrader(() => ({ score: { kind: "scalar", value: 1 } }));
    expect(d.isGate).toBe(false);
    expect(d.weight).toBe(1);
  });

  it("runs _run `samples` times and aggregates", async () => {
    const produce = vi.fn(() => ({ score: { kind: "scalar", value: 0.5 } as const }));
    const g = new StubGrader(produce, { samples: 4 });
    const grade = await g.run(gi());
    expect(produce).toHaveBeenCalledTimes(4);
    expect(grade.score).toEqual({ kind: "scalar", value: 0.5 });
  });

  it("passes() reads binary pass, and scalar against threshold", () => {
    const g = new StubGrader(() => ({ score: { kind: "scalar", value: 0 } }), { threshold: 0.7 });
    expect(g.passes({ score: { kind: "binary", pass: true } })).toBe(true);
    expect(g.passes({ score: { kind: "binary", pass: false } })).toBe(false);
    expect(g.passes({ score: { kind: "scalar", value: 0.8 } })).toBe(true);
    expect(g.passes({ score: { kind: "scalar", value: 0.6 } })).toBe(false);
  });

  it("gradesInput: default all; tag scope matches metadata.tags; ids scope matches input.id", () => {
    const all = new StubGrader(() => ({ score: { kind: "binary", pass: true } }));
    expect(all.gradesInput(input())).toBe(true);

    const tagged = new StubGrader(() => ({ score: { kind: "binary", pass: true } }), { inputScope: { tag: "review" } });
    expect(tagged.gradesInput(input({ metadata: { tags: ["review"] } }))).toBe(true);
    expect(tagged.gradesInput(input({ metadata: { tags: ["other"] } }))).toBe(false);
    expect(tagged.gradesInput(input())).toBe(false);

    const byId = new StubGrader(() => ({ score: { kind: "binary", pass: true } }), { inputScope: { ids: ["i1"] } });
    expect(byId.gradesInput(input({ id: "i1" }))).toBe(true);
    expect(byId.gradesInput(input({ id: "i2" }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/optimize/grading/baseGrader.test.ts`
Expected: FAIL — cannot resolve `./baseGrader.js`.

- [ ] **Step 3: Implement `BaseGrader`**

Create `lib/optimize/grading/baseGrader.ts`:

```ts
import { aggregateGrades } from "./aggregate.js";
import type { Grade, GraderInput, GraderOptions, Input } from "./types.js";

/**
 * Base class for graders. Authors implement the single-shot `_run`; the base
 * handles k-sample repetition + aggregation, gating policy, and input scoping.
 */
export abstract class BaseGrader {
  constructor(protected readonly options: GraderOptions = {}) {}

  /** Subclasses set a default; `options.name` overrides it. A getter avoids field init-order issues. */
  protected abstract readonly defaultName: string;
  get name(): string {
    return this.options.name ?? this.defaultName;
  }

  /** Single-shot grade. Declarative: no sampling, no aggregation. */
  protected abstract _run(input: GraderInput): Promise<Grade>;

  get isGate(): boolean {
    return this.options.mustPass ?? false;
  }

  get weight(): number {
    return this.options.weight ?? 1;
  }

  /** Whether this grader runs on `input`. Default (no inputScope) → every input. */
  gradesInput(input: Input): boolean {
    const scope = this.options.inputScope;
    if (!scope) return true;
    if ("tag" in scope) {
      const tags = input.metadata?.tags;
      return Array.isArray(tags) && tags.includes(scope.tag);
    }
    return input.id !== undefined && scope.ids.includes(input.id);
  }

  /** Orchestration: run `_run` k times, aggregate by score kind. */
  async run(input: GraderInput): Promise<Grade> {
    const samples = this.options.samples ?? 1;
    const trials = await Promise.all(Array.from({ length: samples }, () => this._run(input)));
    return aggregateGrades(trials, this.options.aggregate ?? "all");
  }

  passes(grade: Grade): boolean {
    if (grade.score.kind === "binary") return grade.score.pass;
    return grade.score.value >= (this.options.threshold ?? 0);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run lib/optimize/grading/baseGrader.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/optimize/grading/baseGrader.ts lib/optimize/grading/baseGrader.test.ts
git commit -m "feat(optimize): add BaseGrader with k-sampling and gating"
```

---

### Task 3: `Scorecard`

**Files:**
- Create: `lib/optimize/grading/scorecard.ts`
- Test: `lib/optimize/grading/scorecard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/optimize/grading/scorecard.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { BaseGrader } from "./baseGrader.js";
import { Scorecard, type GraderGrade, type InputGrades } from "./scorecard.js";
import type { Grade, GraderInput, GraderOptions, Input } from "./types.js";

class StubGrader extends BaseGrader {
  protected readonly defaultName = "stub";
  constructor(options: GraderOptions = {}) {
    super(options);
  }
  protected _run(): Promise<Grade> {
    return Promise.resolve({ score: { kind: "scalar", value: 0 } });
  }
}

const input = (id: string): Input => ({ id, args: {} });
const scalarGrade = (grader: BaseGrader, value: number): GraderGrade => ({ grader, grade: { score: { kind: "scalar", value } } });

describe("Scorecard", () => {
  it("objective is the weighted mean of non-gating scalar grades, averaged across inputs", () => {
    const advisory = new StubGrader({ weight: 1 });
    const weighted = new StubGrader({ weight: 3 });
    const perInput: InputGrades[] = [
      { input: input("a"), run: { output: null, recordPath: "" }, gatesPassed: true, grades: [scalarGrade(advisory, 1), scalarGrade(weighted, 0)] },
      { input: input("b"), run: { output: null, recordPath: "" }, gatesPassed: true, grades: [scalarGrade(advisory, 1), scalarGrade(weighted, 1)] },
    ];
    // input a: (1*1 + 3*0)/4 = 0.25 ; input b: (1*1 + 3*1)/4 = 1.0 ; mean = 0.625
    expect(new Scorecard(perInput).objective).toBeCloseTo(0.625, 10);
  });

  it("excludes gating graders from the objective", () => {
    const gate = new StubGrader({ mustPass: true });
    const advisory = new StubGrader({ weight: 1 });
    const perInput: InputGrades[] = [
      {
        input: input("a"),
        run: { output: null, recordPath: "" },
        gatesPassed: true,
        grades: [
          { grader: gate, grade: { score: { kind: "binary", pass: true } } },
          scalarGrade(advisory, 0.5),
        ],
      },
    ];
    expect(new Scorecard(perInput).objective).toBeCloseTo(0.5, 10);
  });

  it("a gate-failed input scores 0 and drags the objective down", () => {
    const advisory = new StubGrader({ weight: 1 });
    const perInput: InputGrades[] = [
      { input: input("a"), run: { output: null, recordPath: "" }, gatesPassed: false, grades: [scalarGrade(advisory, 1)] },
      { input: input("b"), run: { output: null, recordPath: "" }, gatesPassed: true, grades: [scalarGrade(advisory, 1)] },
    ];
    const sc = new Scorecard(perInput);
    expect(sc.inputScores).toEqual([0, 1]);
    expect(sc.objective).toBeCloseTo(0.5, 10);
  });

  it("gatesPassed is true only when every input passed its gates", () => {
    const advisory = new StubGrader({ weight: 1 });
    const passing: InputGrades = { input: input("a"), run: { output: null, recordPath: "" }, gatesPassed: true, grades: [scalarGrade(advisory, 1)] };
    const failing: InputGrades = { input: input("b"), run: { output: null, recordPath: "" }, gatesPassed: false, grades: [scalarGrade(advisory, 1)] };
    expect(new Scorecard([passing]).gatesPassed).toBe(true);
    expect(new Scorecard([passing, failing]).gatesPassed).toBe(false);
  });

  it("an input with no scalar contributions scores 0", () => {
    const gate = new StubGrader({ mustPass: true });
    const perInput: InputGrades[] = [
      { input: input("a"), run: { output: null, recordPath: "" }, gatesPassed: true, grades: [{ grader: gate, grade: { score: { kind: "binary", pass: true } } }] },
    ];
    expect(new Scorecard(perInput).inputScores).toEqual([0]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/optimize/grading/scorecard.test.ts`
Expected: FAIL — cannot resolve `./scorecard.js`.

- [ ] **Step 3: Implement `Scorecard`**

Create `lib/optimize/grading/scorecard.ts`:

```ts
import type { BaseGrader } from "./baseGrader.js";
import type { AgentRun, Grade, Input } from "./types.js";

export type GraderGrade = { grader: BaseGrader; grade: Grade };
export type InputGrades = { input: Input; run: AgentRun; grades: GraderGrade[]; gatesPassed: boolean };

/** Weighted mean of the non-gating scalar grades for one input. */
export function inputObjective(grades: GraderGrade[]): number {
  const contributions = grades
    .filter((g) => !g.grader.isGate)
    .flatMap((g) => (g.grade.score.kind === "scalar" ? [{ weight: g.grader.weight, value: g.grade.score.value }] : []));
  const totalWeight = contributions.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight === 0) return 0;
  return contributions.reduce((sum, c) => sum + c.weight * c.value, 0) / totalWeight;
}

/** Per-candidate grading result: per-input grades plus derived gate/objective readouts. */
export class Scorecard {
  constructor(readonly perInput: InputGrades[]) {}

  get gatesPassed(): boolean {
    return this.perInput.every((i) => i.gatesPassed);
  }

  /** Per-input objective; a gate-failed input scores 0. */
  get inputScores(): number[] {
    return this.perInput.map((i) => (i.gatesPassed ? inputObjective(i.grades) : 0));
  }

  get objective(): number {
    const scores = this.inputScores;
    if (scores.length === 0) return 0;
    return scores.reduce((sum, s) => sum + s, 0) / scores.length;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run lib/optimize/grading/scorecard.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/optimize/grading/scorecard.ts lib/optimize/grading/scorecard.test.ts
git commit -m "feat(optimize): add Scorecard with gate-aware objective"
```

---

### Task 4: `getPath`

**Files:**
- Create: `lib/optimize/grading/getPath.ts`
- Test: `lib/optimize/grading/getPath.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/optimize/grading/getPath.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { getPath } from "./getPath.js";

describe("getPath", () => {
  it("reads a nested object path", () => {
    expect(getPath({ metadata: { expectedOutput: "New Delhi" } }, ["metadata", "expectedOutput"])).toBe("New Delhi");
  });

  it("reads an array index", () => {
    expect(getPath({ items: ["a", "b", "c"] }, ["items", 1])).toBe("b");
  });

  it("returns undefined for a missing key", () => {
    expect(getPath({ metadata: {} }, ["metadata", "expectedOutput"])).toBeUndefined();
  });

  it("returns undefined when descending into a non-object", () => {
    expect(getPath({ a: 5 }, ["a", "b"])).toBeUndefined();
  });

  it("returns undefined for null/undefined roots", () => {
    expect(getPath(null, ["a"])).toBeUndefined();
    expect(getPath(undefined, ["a"])).toBeUndefined();
  });

  it("returns the root for an empty path", () => {
    expect(getPath("hi", [])).toBe("hi");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/optimize/grading/getPath.test.ts`
Expected: FAIL — cannot resolve `./getPath.js`.

- [ ] **Step 3: Implement `getPath`**

Create `lib/optimize/grading/getPath.ts`:

```ts
import type { JsonPath } from "./types.js";

/**
 * Read a value out of arbitrary data by a path of object keys / array indices.
 * Returns undefined if any segment is missing or descends into a non-object.
 */
export function getPath(root: unknown, path: JsonPath): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      current = typeof key === "number" ? current[key] : undefined;
    } else {
      current = (current as Record<string, unknown>)[key as string];
    }
    if (current === undefined) return undefined;
  }
  return current;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run lib/optimize/grading/getPath.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/optimize/grading/getPath.ts lib/optimize/grading/getPath.test.ts
git commit -m "feat(optimize): add getPath helper for grader metadata access"
```

---

### Task 5: Deterministic built-in graders

**Files:**
- Create: `lib/optimize/grading/builtinGraders.ts`
- Test: `lib/optimize/grading/builtinGraders.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/optimize/grading/builtinGraders.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { ContainsGrader, ExactMatchGrader, SimilarityGrader } from "./builtinGraders.js";
import type { GraderInput, Input, Json } from "./types.js";

const gi = (output: Json, metadata: Record<string, Json>): GraderInput => {
  const input: Input = { id: "i1", args: {}, metadata };
  return { input, run: { output, recordPath: "" } };
};

describe("ExactMatchGrader", () => {
  const grader = new ExactMatchGrader({ matchOn: ["metadata", "expected"] });

  it("passes when the agent output equals the referenced value", async () => {
    const grade = await grader.run(gi("New Delhi", { expected: "New Delhi" }));
    expect(grade.score).toEqual({ kind: "binary", pass: true });
  });

  it("fails with feedback when the output differs", async () => {
    const grade = await grader.run(gi("Mumbai", { expected: "New Delhi" }));
    expect(grade.score).toEqual({ kind: "binary", pass: false });
    expect(grade.feedback).toContain("New Delhi");
    expect(grade.feedback).toContain("Mumbai");
  });

  it("compares structured values deeply", async () => {
    const grade = await grader.run(gi({ a: [1, 2] } as Json, { expected: { a: [1, 2] } as Json }));
    expect(grade.score).toEqual({ kind: "binary", pass: true });
  });
});

describe("ContainsGrader", () => {
  const grader = new ContainsGrader({ matchOn: ["metadata", "needle"] });

  it("passes when the output contains the needle", async () => {
    expect((await grader.run(gi("the capital is New Delhi today", { needle: "New Delhi" }))).score).toEqual({ kind: "binary", pass: true });
  });

  it("fails when the output does not contain the needle", async () => {
    expect((await grader.run(gi("the capital is Mumbai", { needle: "New Delhi" }))).score).toEqual({ kind: "binary", pass: false });
  });
});

describe("SimilarityGrader", () => {
  const grader = new SimilarityGrader({ matchOn: ["metadata", "expected"] });

  it("scores 1 for an exact match", async () => {
    expect((await grader.run(gi("hello", { expected: "hello" }))).score).toEqual({ kind: "scalar", value: 1 });
  });

  it("scores 0 against an empty-vs-nonempty comparison", async () => {
    expect((await grader.run(gi("", { expected: "hello" }))).score).toEqual({ kind: "scalar", value: 0 });
  });

  it("scores between 0 and 1 for a near match", async () => {
    const grade = await grader.run(gi("hella", { expected: "hello" }));
    if (grade.score.kind !== "scalar") throw new Error("expected scalar");
    expect(grade.score.value).toBeGreaterThan(0.5);
    expect(grade.score.value).toBeLessThan(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/optimize/grading/builtinGraders.test.ts`
Expected: FAIL — cannot resolve `./builtinGraders.js`.

- [ ] **Step 3: Implement the built-in graders**

Create `lib/optimize/grading/builtinGraders.ts`:

```ts
import { BaseGrader } from "./baseGrader.js";
import { getPath } from "./getPath.js";
import type { Grade, GraderInput, GraderOptions, JsonPath } from "./types.js";

/** Graders that compare the agent output against a value read from the input. */
type MatchOptions = GraderOptions & { matchOn: JsonPath };

/** Binary: the agent output deep-equals the referenced value. */
export class ExactMatchGrader extends BaseGrader {
  protected readonly defaultName = "exact-match";
  constructor(protected readonly options: MatchOptions) {
    super(options);
  }
  protected _run({ input, run }: GraderInput): Promise<Grade> {
    const expected = getPath(input, this.options.matchOn);
    const pass = JSON.stringify(expected) === JSON.stringify(run.output);
    return Promise.resolve({
      score: { kind: "binary", pass },
      ...(pass ? {} : { feedback: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(run.output)}` }),
    });
  }
}

/** Binary: the stringified agent output contains the referenced needle. */
export class ContainsGrader extends BaseGrader {
  protected readonly defaultName = "contains";
  constructor(protected readonly options: MatchOptions) {
    super(options);
  }
  protected _run({ input, run }: GraderInput): Promise<Grade> {
    const needle = String(getPath(input, this.options.matchOn) ?? "");
    const pass = String(run.output ?? "").includes(needle);
    return Promise.resolve({
      score: { kind: "binary", pass },
      ...(pass ? {} : { feedback: `output did not contain ${JSON.stringify(needle)}` }),
    });
  }
}

/** Scalar: normalized Levenshtein similarity between output and the referenced value. */
export class SimilarityGrader extends BaseGrader {
  protected readonly defaultName = "similarity";
  constructor(protected readonly options: MatchOptions) {
    super(options);
  }
  protected _run({ input, run }: GraderInput): Promise<Grade> {
    const expected = String(getPath(input, this.options.matchOn) ?? "");
    const actual = String(run.output ?? "");
    const longest = Math.max(expected.length, actual.length);
    const value = longest === 0 ? 1 : 1 - levenshtein(expected, actual) / longest;
    return Promise.resolve({ score: { kind: "scalar", value } });
  }
}

/** Classic Levenshtein edit distance (deterministic, dependency-free). */
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_unused, j) => j);
  for (let i = 1; i < rows; i += 1) {
    const curr = [i];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[cols - 1];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run lib/optimize/grading/builtinGraders.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/optimize/grading/builtinGraders.ts lib/optimize/grading/builtinGraders.test.ts
git commit -m "feat(optimize): add deterministic built-in graders (exact-match, contains, similarity)"
```

---

### Task 6: Whole-phase verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole grading module's tests**

Run: `pnpm test:run lib/optimize/grading`
Expected: PASS — all five test files (aggregate, baseGrader, scorecard, getPath, builtinGraders), 30 tests total.

- [ ] **Step 2: Typecheck the project**

Run: `pnpm typecheck`
Expected: PASS (no errors). (If it fails only on a missing `stdlib/index.js` import from
unrelated files, run `pnpm run build && pnpm run agency compile stdlib/` once, then re-run.)

- [ ] **Step 3: Structural lint**

Run: `pnpm run lint:structure`
Expected: PASS (no violations in `lib/optimize/grading/`).

- [ ] **Step 4: Confirm zero behavior change**

Run: `pnpm test:run lib/optimize lib/cli/eval/optimize.test.ts`
Expected: PASS — the Phase 1 optimizer/CLI tests are unchanged and still green (this phase adds
only new, unwired modules).

- [ ] **Step 5: Commit (only if Step 2/3 required a fix)**

```bash
git add -A
git commit -m "chore(optimize): phase 2 grading-foundation verification fixes"
```

---

## Self-Review (completed during planning)

- **Spec coverage (the grading-foundation slice of the spec):** `Grade`/`Score` types → Task 1.
  `aggregateGrades` (k-sample reduction) → Task 1. `BaseGrader` (`_run`/`run`, `isGate`,
  `weight`, `gradesInput`, `passes`) → Task 2. `Scorecard` + `inputObjective` (gate-aware
  `inputScores`, weighted objective) → Task 3. The metadata path-selector (`matchOn`) → Task 4
  (`getPath`). Built-in deterministic graders → Task 5. The spec's `EvalCache`, `LlmJudge`,
  `HumanGrader`, and the greedy pointwise migration are **deferred** with rationale in "Scope
  decision" (dependency on Phase 3 agent-running infra); they are not gaps in this plan, they
  are out of this plan's scope.
- **Placeholder scan:** none — every code/command step has literal content.
- **Type consistency:** `Grade`/`Score`/`GraderInput`/`Input`/`AgentRun`/`GraderOptions` are
  defined once in Task 1 `types.ts` and consumed unchanged by Tasks 2–5. `aggregateGrades(trials, mode)`
  (Task 1) is called by `BaseGrader.run` (Task 2). `GraderGrade`/`InputGrades`/`inputObjective`
  (Task 3) are used only within Task 3. `getPath(root, path)` (Task 4) is called by all three
  built-in graders (Task 5). `BaseGrader`'s `defaultName`/`_run` contract is implemented by the
  `StubGrader` test doubles (Tasks 2, 3) and the real graders (Task 5) identically.

## Follow-on plans (not part of this plan)

- **Phase 3:** `WorkspaceManager` + `AgencyRunner.structured` + `EvalCache`; extend `GraderInput`
  with run-agency capabilities; `LlmJudge`; wire a pointwise evaluation pipeline and **migrate
  `greedy` to pointwise scoring** (the behavior change — validate against the PR #283 fixtures).
- **Phase 4:** `HumanGrader` + harness human-input capability (terminal prompt; CI fail-fast).
- **Phase 5:** GEPA (`CandidatePool`, `ParetoFrontier`, reflective proposer `.agency`).
