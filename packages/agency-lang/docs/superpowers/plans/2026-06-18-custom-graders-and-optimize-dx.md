# Custom Graders, Validation Sets, and Optimize DX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Per the repo owner's standing preference, do **not** use subagent-driven development — implement directly in the main session.)

**Goal:** Let users define optimizer grading by composing built-in graders or writing plain TypeScript metric functions; add held-out validation sets so overfitting is caught; and make optimize runs legible (startup echo, fail-fast validation, per-input grade breakdown, headline `report.md`).

**Architecture:** Three phases, each independently shippable and tested. Phase 1 adds a TS grading-module surface loaded via esbuild + `await import()` (the existing CLI pattern), with built-in graders and a `grader(fn, opts)` wrapper exposed at `agency-lang/optimize`; functions are adapted into `BaseGrader` so the existing `Scorecard`/gating/weighting pipeline is unchanged. Phase 2 adds reporting that consumes grader output. Phase 3 threads a validation set through and picks the writeback champion by validation objective (fully for the default `greedy`; `gepa`/`example` report train-vs-val but keep train-based selection — see Known Limitations).

**Tech Stack:** TypeScript (Node, ESM, `@/` path alias, `.js` import extensions), vitest, esbuild (already a dependency), the Agency compiler/stdlib, `make` for stdlib build.

**Spec:** `docs/superpowers/specs/2026-06-18-custom-graders-and-optimize-dx-design.md`

---

## Global Constraints

- **Code style (enforced by `pnpm run lint:structure`):** objects not maps, arrays not sets, `type` not `interface`, **no dynamic imports in generated/runtime code** (the grading-module loader uses `await import()` — this is CLI-layer code loading a user artifact, the same pattern as `lib/cli/serve.ts`/`debug.ts`/`coverage.ts`, and is allowed). No force-push/amend.
- **Do not run the full agency execution suite locally** — slow/expensive. Run only the specific vitest files named in each task. Save test output to a file (e.g. `… 2>&1 | tee /tmp/out.log`) so failures don't require a rerun.
- **`make` only when a `.agency` stdlib file changes.** This plan changes no stdlib `.agency` files, so `pnpm run build` (tsc) is the build/typecheck command throughout. Run `pnpm run build` after structural changes to catch type errors.
- Commit after every task. Write commit messages to a file and `git commit -F` (apostrophes on the command line break). End every commit message with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- **Branch:** work on `custom-graders-optimize-dx` (already checked out, already rebased on the merged "inputs" terminology).

---

## File Structure

**Phase 1 — custom graders**
- Create `lib/optimize/grading/functionGrader.ts` — the `GraderContext`/`GraderFn`/`Grader` types, the `FunctionGrader` adapter (function → `BaseGrader`), the `grader(fn, opts)` wrapper, and `toGrader(spec)` normalizer.
- Create `lib/optimize/goalJudgeFile.ts` — single source of truth for the bundled goal-judge path + the `ScalarVerdict` schema (shared by `LlmJudge`'s default wiring and `FunctionGrader`'s `judge` helper).
- Create `lib/optimize/gradingModule.ts` — `loadGradingModule(filePath, config)`: esbuild-transpile the user TS, import its default export, normalize to `BaseGrader[]`.
- Create `lib/optimize/public.ts` — the `agency-lang/optimize` public surface (re-exports graders, `grader`, types).
- Modify `lib/eval/loadInputs.ts` — make `goal` optional via a `requireGoal` option.
- Modify `lib/cli/eval/optimize.ts` — async `buildConfig` resolves a grading module or falls back to the default judge; `buildTarget` passes `requireGoal`.
- Modify `lib/config.ts` — add `eval.optimize` to the type + zod schema.
- Modify `scripts/agency.ts` — add `--graders <file>`.
- Modify `package.json` — add the `./optimize` export subpath.

**Phase 2 — DX / run-dir**
- Create `lib/optimize/gradeBreakdown.ts` — `breakdown(scorecard)`: a serializable per-input/per-grader view.
- Create `lib/optimize/report.ts` — `renderReport(...)` (pure) + `writeReport(runDir, …)`.
- Modify `lib/optimize/grading/baseGrader.ts` — add `describe()` (default = name) and `validateInput(input)` (default no-op).
- Modify `lib/optimize/grading/graders/builtinGraders.ts` — `validateInput` checks `matchOn` resolves; `describe()` names the path.
- Modify `lib/optimize/reporter.ts` — add `gradingSetup(...)` to `PointwiseReporter`.
- Modify `lib/optimize/baseOptimizer.ts` — echo + eager-validate before search; write the report at the end.

**Phase 3 — validation set**
- Create `lib/optimize/validationSplit.ts` — `splitInputs(inputs, ratio, seed)` (seeded).
- Modify `lib/optimize/optimizer.ts` — `OptimizeTarget.validationInputs?`.
- Modify `lib/optimize/types.ts` — `OptimizeResult.trainObjective?` / `validationObjective?`.
- Modify `lib/optimize/baseOptimizer.ts` — store `validationInputs`; add `scoreFiles(...)` helper; include val objective in the report.
- Modify `lib/optimize/optimizers/greedyReflective.ts` — pick writeback champion by validation objective; record both objectives.
- Modify `lib/cli/eval/optimize.ts` — load validation inputs (file) or split (ratio) into `target.validationInputs`.
- Modify `scripts/agency.ts` — add `--validation-inputs` / `--validation-split`.

---

# Phase 1 — Custom grader module

## Task 1: Shared goal-judge file + verdict schema

**Files:**
- Create: `lib/optimize/goalJudgeFile.ts`
- Modify: `lib/cli/eval/optimize.ts` (use the shared constant)
- Test: `lib/optimize/goalJudgeFile.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// lib/optimize/goalJudgeFile.test.ts
import * as fs from "fs";
import { describe, expect, it } from "vitest";
import { goalJudgeFile, ScalarVerdict } from "./goalJudgeFile.js";

describe("goalJudgeFile", () => {
  it("points at the bundled goalJudge.agency that exists on disk", () => {
    const file = goalJudgeFile();
    expect(file.endsWith("eval/goalJudge.agency")).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("ScalarVerdict accepts a {score, reasoning} object", () => {
    expect(ScalarVerdict.parse({ score: 0.5, reasoning: "ok" })).toEqual({ score: 0.5, reasoning: "ok" });
  });
});
```

- [ ] **Step 2: Run it; expect failure** (`Cannot find module './goalJudgeFile.js'`).

Run: `pnpm test:run lib/optimize/goalJudgeFile.test.ts 2>&1 | tee /tmp/t1.log`

- [ ] **Step 3: Implement.**

```ts
// lib/optimize/goalJudgeFile.ts
import * as path from "path";

import { z } from "zod";

import { getAgentsDir } from "@/importPaths.js";

/** Bundled scalar goal judge: scores how well an output satisfies the input's goal. */
export function goalJudgeFile(): string {
  return path.join(getAgentsDir(), "eval", "goalJudge.agency");
}

/** Structured verdict shape the goal judge returns (0..1 score + reasoning). */
export const ScalarVerdict = z.object({ score: z.number(), reasoning: z.string() });
```

- [ ] **Step 4: Point `optimize.ts` at the shared constant.** In `lib/cli/eval/optimize.ts`, delete the local `GOAL_JUDGE_FILE` constant (currently `const GOAL_JUDGE_FILE = path.join(getAgentsDir(), "eval", "goalJudge.agency");`) and its now-unused `getAgentsDir` import if nothing else uses it; import `goalJudgeFile` and use `goalJudgeFile()` where `GOAL_JUDGE_FILE` was referenced in `buildConfig`.

```ts
import { goalJudgeFile } from "@/optimize/goalJudgeFile.js";
// …in buildConfig:
graders: [new LlmJudge({ name: "goal", agencyFile: goalJudgeFile(), goalPath: ["goal"] })],
```

- [ ] **Step 5: Run the test + build.**

Run: `pnpm test:run lib/optimize/goalJudgeFile.test.ts 2>&1 | tee /tmp/t1.log` → PASS
Run: `pnpm run build 2>&1 | tee /tmp/t1-build.log` → tsc clean

- [ ] **Step 6: Commit.**

```bash
git add lib/optimize/goalJudgeFile.ts lib/optimize/goalJudgeFile.test.ts lib/cli/eval/optimize.ts
git commit -F /tmp/msg.txt   # "Extract shared goal-judge file path and verdict schema"
```

---

## Task 2: `FunctionGrader` adapter + `grader()` wrapper + `toGrader()`

**Files:**
- Create: `lib/optimize/grading/functionGrader.ts`
- Test: `lib/optimize/grading/functionGrader.test.ts`

Background the implementer needs: `BaseGrader` (in `grading/baseGrader.ts`) is abstract with `protected abstract _run(input: GraderInput): Promise<Grade>` and takes `GraderOptions` in its constructor. `GraderInput = { input: Input; run: AgentRun; runAgency: AgencyRunner }` (from `grading/types.ts`). `AgentRun = { output: JSON; recordPath: string }`. `Grade = { score: Score; feedback?: string }`, `Score = { kind:"binary"; pass:boolean } | { kind:"scalar"; value:number }`. `AgencyRunner.runStructured(file, node, args, zodSchema)` runs a judge `.agency` and validates output.

- [ ] **Step 1: Write the failing tests.**

```ts
// lib/optimize/grading/functionGrader.test.ts
import { describe, expect, it, vi } from "vitest";

import type { AgencyRunner } from "./agencyRunner.js";
import { FunctionGrader, grader, toGrader } from "./functionGrader.js";
import { BaseGrader } from "./baseGrader.js";
import type { GraderInput } from "./types.js";

const runInput = (output: unknown): GraderInput => ({
  input: { id: "a", args: {}, metadata: { expected: "Paris" } },
  run: { output: output as any, recordPath: "" },
  runAgency: {} as AgencyRunner,
});

describe("FunctionGrader", () => {
  it("coerces a number return to a scalar grade", async () => {
    const g = new FunctionGrader(({ input, output }) => (output === input.metadata?.expected ? 1 : 0));
    expect(await g.run(runInput("Paris"))).toEqual({ score: { kind: "scalar", value: 1 } });
    expect(await g.run(runInput("Lyon"))).toEqual({ score: { kind: "scalar", value: 0 } });
  });

  it("coerces a boolean return to a binary grade", async () => {
    const g = new FunctionGrader(({ output }) => output === "Paris");
    expect(await g.run(runInput("Paris"))).toEqual({ score: { kind: "binary", pass: true } });
  });

  it("passes through a full Grade object", async () => {
    const g = new FunctionGrader(() => ({ score: { kind: "scalar", value: 0.7 }, feedback: "close" }));
    expect(await g.run(runInput("x"))).toEqual({ score: { kind: "scalar", value: 0.7 }, feedback: "close" });
  });

  it("exposes the input's metadata to the function via ctx.input", async () => {
    const seen: unknown[] = [];
    const g = new FunctionGrader(({ input }) => { seen.push(input.metadata?.expected); return 1; });
    await g.run(runInput("Paris"));
    expect(seen).toEqual(["Paris"]);
  });

  it("provides ctx.judge that runs the bundled goal judge and returns its score", async () => {
    const runStructured = vi.fn(async () => ({ score: 0.9, reasoning: "good" }));
    const ctxInput: GraderInput = { ...runInput("Paris"), runAgency: { runStructured } as unknown as AgencyRunner };
    const g = new FunctionGrader(async ({ judge, output }) => (await judge({ goal: "capital", output })).score);
    expect(await g.run(ctxInput)).toEqual({ score: { kind: "scalar", value: 0.9 } });
    expect(runStructured).toHaveBeenCalledTimes(1);
  });

  it("grader() attaches policy options (mustPass/name) to the wrapped function", () => {
    const g = grader(() => 1, { mustPass: true, name: "exact" });
    expect(g.mustPass()).toBe(true);
    expect(g.name()).toBe("exact");
  });

  it("toGrader passes a BaseGrader through and wraps a function", () => {
    const instance = grader(() => 1);
    expect(toGrader(instance)).toBe(instance);
    expect(toGrader(() => 1)).toBeInstanceOf(BaseGrader);
  });

  it("toGrader rejects a non-grader value with a clear error", () => {
    expect(() => toGrader(42 as any)).toThrow(/expected a grader function or grader instance/);
  });
});
```

- [ ] **Step 2: Run; expect failure** (module not found).

Run: `pnpm test:run lib/optimize/grading/functionGrader.test.ts 2>&1 | tee /tmp/t2.log`

- [ ] **Step 3: Implement.**

```ts
// lib/optimize/grading/functionGrader.ts
import { AgencyRunner } from "./agencyRunner.js";
import { BaseGrader } from "./baseGrader.js";
import { goalJudgeFile, ScalarVerdict } from "../goalJudgeFile.js";
import type { Grade, GraderInput, GraderOptions, Input, JSON } from "./types.js";

/** What a metric function receives. `input` is the typed Input; per-input grading
 *  data (an expected answer, tags) lives under `input.metadata`. */
export type GraderContext = {
  output: JSON;
  input: Input;
  /** Run the bundled LLM goal judge and get back its 0..1 score + reasoning. */
  judge: (args: { goal: string; output?: JSON }) => Promise<{ score: number; reasoning: string }>;
};

/** A metric: return a 0..1 number, a pass/fail boolean, or a full Grade. */
export type GraderFn = (ctx: GraderContext) => number | boolean | Grade | Promise<number | boolean | Grade>;

/** Public "grader" union: a metric function or a configured grader instance. */
export type Grader = GraderFn | BaseGrader;

/** Adapts a metric function into a single-shot BaseGrader so the whole grading
 *  pipeline (sampling, gating, weighting, scoring) treats it like any grader. */
export class FunctionGrader extends BaseGrader {
  protected readonly defaultName = "fn";
  constructor(private readonly fn: GraderFn, options: GraderOptions = {}) {
    super(options);
  }

  protected async _run({ input, run, runAgency }: GraderInput): Promise<Grade> {
    const judge = async ({ goal, output }: { goal: string; output?: JSON }) => {
      const text = output ?? run.output;
      const str = typeof text === "string" ? text : globalThis.JSON.stringify(text);
      return runAgency.runStructured(goalJudgeFile(), "main", [goal, str], ScalarVerdict);
    };
    const result = await this.fn({ output: run.output, input, judge });
    return coerce(result);
  }
}

function coerce(result: number | boolean | Grade): Grade {
  if (typeof result === "number") return { score: { kind: "scalar", value: result } };
  if (typeof result === "boolean") return { score: { kind: "binary", pass: result } };
  if (result && typeof result === "object" && "score" in result) return result;
  throw new Error(`grader function must return a number, boolean, or {score} object; got ${typeof result}`);
}

/** Wrap a metric function so it carries policy (mustPass/weight/threshold/inputScope/samples/name). */
export function grader(fn: GraderFn, options: GraderOptions = {}): BaseGrader {
  return new FunctionGrader(fn, options);
}

/** Normalize a user-supplied grader (function or instance) into a BaseGrader. */
export function toGrader(spec: Grader): BaseGrader {
  if (spec instanceof BaseGrader) return spec;
  if (typeof spec === "function") return new FunctionGrader(spec);
  throw new Error(
    `Invalid grader: expected a grader function or grader instance, got ${spec === null ? "null" : typeof spec}.`,
  );
}
```

Note: `Input.args`/`metadata` are `Record<string, any>` (eval's `Input`), so `input.metadata?.expected` is untyped `any` — fine for user metric code. `JSON` is imported from `grading/types.ts`.

- [ ] **Step 4: Run the tests** → PASS.

Run: `pnpm test:run lib/optimize/grading/functionGrader.test.ts 2>&1 | tee /tmp/t2.log`

- [ ] **Step 5: Build** → tsc clean. Run: `pnpm run build 2>&1 | tee /tmp/t2-build.log`

- [ ] **Step 6: Commit.** (`git commit -F` msg: "Add FunctionGrader adapter, grader() wrapper, and toGrader normalizer")

---

## Task 3: Public `agency-lang/optimize` surface

**Files:**
- Create: `lib/optimize/public.ts`
- Modify: `package.json` (exports map)
- Test: `lib/optimize/public.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// lib/optimize/public.test.ts
import { describe, expect, it } from "vitest";
import * as api from "./public.js";

describe("public optimize surface", () => {
  it("exports the grader wrapper, base class, and built-in graders", () => {
    expect(typeof api.grader).toBe("function");
    expect(typeof api.BaseGrader).toBe("function");
    expect(typeof api.ExactMatch).toBe("function");
    expect(typeof api.Contains).toBe("function");
    expect(typeof api.Similarity).toBe("function");
    expect(typeof api.LlmJudge).toBe("function");
  });
});
```

- [ ] **Step 2: Run; expect failure.** Run: `pnpm test:run lib/optimize/public.test.ts 2>&1 | tee /tmp/t3.log`

- [ ] **Step 3: Implement the surface.** Built-in grader classes export under friendly aliases.

```ts
// lib/optimize/public.ts
// The public surface users import in a custom grading module:
//   import { grader, ExactMatch, LlmJudge, type Grader } from "agency-lang/optimize";
export { grader, FunctionGrader, toGrader } from "./grading/functionGrader.js";
export type { Grader, GraderFn, GraderContext } from "./grading/functionGrader.js";
export { BaseGrader } from "./grading/baseGrader.js";
export {
  ExactMatchGrader as ExactMatch,
  ContainsGrader as Contains,
  SimilarityGrader as Similarity,
} from "./grading/graders/builtinGraders.js";
export { LlmJudge } from "./grading/graders/llmJudge.js";
export type { Grade, GraderOptions, Input, JSON, JSONPath, Score } from "./grading/types.js";
```

- [ ] **Step 4: Add the export subpath to `package.json`.** Insert after the `"./compiler"` entry:

```jsonc
"./optimize": {
  "types": "./dist/lib/optimize/public.d.ts",
  "import": "./dist/lib/optimize/public.js",
  "require": "./dist/lib/optimize/public.js"
},
```

- [ ] **Step 5: Run the test + build** → PASS / tsc clean.

Run: `pnpm test:run lib/optimize/public.test.ts 2>&1 | tee /tmp/t3.log`
Run: `pnpm run build 2>&1 | tee /tmp/t3-build.log`

- [ ] **Step 6: Commit.** (msg: "Expose agency-lang/optimize public grading surface")

---

## Task 4: `loadGradingModule` — esbuild-load a user TS grading file

**Files:**
- Create: `lib/optimize/gradingModule.ts`
- Test: `lib/optimize/gradingModule.test.ts`

Approach: bundle the user file with esbuild (`agency-lang` left external so its `import` resolves to the installed package), writing the output **next to the user's grading file** so Node module resolution finds the project's `node_modules/agency-lang`. Then `await import()` the file-URL and read its default export. Clean up the temp file in `finally`.

- [ ] **Step 1: Write the failing tests** (use a real temp grading file on disk; no LLM).

```ts
// lib/optimize/gradingModule.test.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgencyConfig } from "@/config.js";
import { BaseGrader } from "./grading/baseGrader.js";
import { loadGradingModule } from "./gradingModule.js";

const cfg: AgencyConfig = {};

describe("loadGradingModule", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (name: string, src: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, src);
    return p;
  };

  it("loads a default-exported metric function as one grader", async () => {
    const file = write("grading.ts", `export default ({ output }: any) => (output === "Paris" ? 1 : 0);`);
    const graders = await loadGradingModule(file, cfg);
    expect(graders).toHaveLength(1);
    expect(graders[0]).toBeInstanceOf(BaseGrader);
  });

  it("loads a default-exported array of graders", async () => {
    const file = write("grading.ts", `
      const a = ({ output }: any) => output === "x";
      const b = ({ output }: any) => 0.5;
      export default [a, b];
    `);
    const graders = await loadGradingModule(file, cfg);
    expect(graders).toHaveLength(2);
  });

  it("throws a clear error when there is no default export", async () => {
    const file = write("grading.ts", `export const notDefault = () => 1;`);
    await expect(loadGradingModule(file, cfg)).rejects.toThrow(/must default-export/);
  });

  it("throws a clear error when an exported entry is not a grader", async () => {
    const file = write("grading.ts", `export default [123];`);
    await expect(loadGradingModule(file, cfg)).rejects.toThrow(/expected a grader function or grader instance/);
  });
});
```

(Note: the test grading files import nothing from `agency-lang`, so resolution of the external is not exercised here; the integration test in Task 6 / Phase-1 manual check covers a real `import … from "agency-lang/optimize"`.)

- [ ] **Step 2: Run; expect failure.** Run: `pnpm test:run lib/optimize/gradingModule.test.ts 2>&1 | tee /tmp/t4.log`

- [ ] **Step 3: Implement.**

```ts
// lib/optimize/gradingModule.ts
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

import { build } from "esbuild";

import type { AgencyConfig } from "@/config.js";
import type { BaseGrader } from "./grading/baseGrader.js";
import { toGrader, type Grader } from "./grading/functionGrader.js";

let counter = 0;

/**
 * Load a user-authored TypeScript grading module and return its graders.
 * Transpiles with esbuild (leaving `agency-lang` external so the user's
 * `import { grader } from "agency-lang/optimize"` resolves to the installed
 * package), writes the bundle next to the source so Node finds the project's
 * node_modules, imports the default export, and normalizes it to BaseGrader[].
 */
export async function loadGradingModule(filePath: string, _config: AgencyConfig): Promise<BaseGrader[]> {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Grading module not found: ${absolute}`);
  }
  counter += 1;
  const out = path.join(path.dirname(absolute), `.agency-grading-${process.pid}-${counter}.mjs`);
  try {
    await build({
      entryPoints: [absolute],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node18",
      outfile: out,
      write: true,
      logLevel: "silent",
      external: ["agency-lang", "agency-lang/*"],
    });
    const mod = await import(pathToFileURL(out).href);
    const exported = mod.default;
    if (exported === undefined) {
      throw new Error(
        `Grading module ${absolute} must default-export a grader or an array of graders ` +
        `(e.g. \`export default [...]\`).`,
      );
    }
    const specs: Grader[] = Array.isArray(exported) ? exported : [exported];
    return specs.map(toGrader);
  } finally {
    if (fs.existsSync(out)) fs.rmSync(out, { force: true });
  }
}
```

- [ ] **Step 4: Run the tests** → PASS. Run: `pnpm test:run lib/optimize/gradingModule.test.ts 2>&1 | tee /tmp/t4.log`

- [ ] **Step 5: Build** → tsc clean. Run: `pnpm run build 2>&1 | tee /tmp/t4-build.log`

- [ ] **Step 6: Commit.** (msg: "Add loadGradingModule: esbuild-load a user TS grading file")

---

## Task 5: Make the input loader's `goal` optional

**Files:**
- Modify: `lib/eval/loadInputs.ts`
- Test: `lib/eval/loadInputs.test.ts`

The default goal-judge needs `goal`; a custom grading module may not. Add a `requireGoal` option (default `true`, preserving today's behavior). The `goal`+`rubric` conflict check stays.

- [ ] **Step 1: Write the failing test** (append to the existing `loadInputs.test.ts` describe block).

```ts
// in lib/eval/loadInputs.test.ts
import { loadInputsFromFile } from "./loadInputs.js";

it("allows a missing goal when requireGoal is false", () => {
  const file = path.join(tmpDir, "no-goal.json");
  fs.writeFileSync(file, JSON.stringify({ inputs: [{ id: "a", args: { country: "Brazil" }, metadata: { expected: "Brasília" } }] }));
  const inputs = loadInputsFromFile(file, () => "a", { requireGoal: false });
  expect(inputs[0].goal).toBeUndefined();
  expect(inputs[0].metadata).toEqual({ expected: "Brasília" });
});

it("still requires a non-empty goal by default", () => {
  const file = path.join(tmpDir, "needs-goal.json");
  fs.writeFileSync(file, JSON.stringify({ inputs: [{ id: "a", args: {} }] }));
  expect(() => loadInputsFromFile(file, () => "a")).toThrow(/goal must be a non-empty string/);
});
```

(If `tmpDir` isn't already set up in the test file, create one in a `beforeEach`/`afterEach` mirroring the existing tests.)

- [ ] **Step 2: Run; expect failure** (the `requireGoal` arg and `metadata` passthrough don't exist).

Run: `pnpm test:run lib/eval/loadInputs.test.ts 2>&1 | tee /tmp/t5.log`

- [ ] **Step 3: Implement.** Thread an options object through the three entry points and `normalizeInput`, and preserve `metadata`.

```ts
// lib/eval/loadInputs.ts — add an options type and thread it through
type LoadOptions = { requireGoal?: boolean };

export function loadInputs(sourcePath: string, makeId: MakeId = nanoid, options: LoadOptions = {}): Input[] {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) return loadInputsFromDirectory(sourcePath, makeId, options);
  return loadInputsFromFile(sourcePath, makeId, options);
}

export function loadInputsFromFile(filePath: string, makeId: MakeId = nanoid, options: LoadOptions = {}): Input[] {
  const parsed = readJson(filePath);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).inputs)) {
    throw new Error(`Input suite ${filePath} must contain a top-level inputs array`);
  }
  return validateInputs(
    (parsed as any).inputs.map((raw: unknown) => normalizeInput(raw, path.dirname(filePath), makeId, options)),
  );
}

function loadInputsFromDirectory(directoryPath: string, makeId: MakeId, options: LoadOptions): Input[] {
  const files = fs.readdirSync(directoryPath).filter((file) => file.endsWith(".json")).sort();
  return validateInputs(
    files.map((file) => normalizeInput(readJson(path.join(directoryPath, file)), directoryPath, makeId, options)),
  );
}
```

Then update `normalizeInput`'s signature and goal handling, and carry `metadata`:

```ts
function normalizeInput(raw: unknown, baseDir: string, makeId: MakeId, options: LoadOptions): Input {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Eval input must be a JSON object");
  }
  const spec = raw as Record<string, unknown>;
  if (spec.goal !== undefined && spec.rubric !== undefined) {
    throw new Error("Eval input cannot specify both goal and rubric");
  }
  const requireGoal = options.requireGoal ?? true;
  if (requireGoal && (typeof spec.goal !== "string" || spec.goal.length === 0)) {
    throw new Error("Eval input goal must be a non-empty string");
  }
  if (spec.goal !== undefined && typeof spec.goal !== "string") {
    throw new Error("Eval input goal must be a string when provided");
  }
  if (spec.args !== undefined && (!spec.args || typeof spec.args !== "object" || Array.isArray(spec.args))) {
    throw new Error("Eval input args must be an object when provided");
  }
  if (spec.node !== undefined && typeof spec.node !== "string") {
    throw new Error("Eval input node must be a string when provided");
  }
  if (spec.working_dir !== undefined && typeof spec.working_dir !== "string") {
    throw new Error("Eval input working_dir must be a string when provided");
  }
  if (spec.metadata !== undefined && (!spec.metadata || typeof spec.metadata !== "object" || Array.isArray(spec.metadata))) {
    throw new Error("Eval input metadata must be an object when provided");
  }
  const out: Input = {
    id: typeof spec.id === "string" ? spec.id : makeId(),
    args: (spec.args ?? {}) as Record<string, any>,
  };
  if (typeof spec.goal === "string") out.goal = spec.goal;
  if (typeof spec.node === "string") out.node = spec.node;
  if (typeof spec.working_dir === "string") out.working_dir = path.resolve(baseDir, spec.working_dir);
  if (spec.metadata && typeof spec.metadata === "object") out.metadata = spec.metadata as Record<string, any>;
  return out;
}
```

(Note: `goal` is no longer unconditionally set, matching the optional field.)

- [ ] **Step 4: Run the tests** → PASS. Run: `pnpm test:run lib/eval/loadInputs.test.ts 2>&1 | tee /tmp/t5.log`

- [ ] **Step 5: Build** → tsc clean. Run: `pnpm run build 2>&1 | tee /tmp/t5-build.log`

- [ ] **Step 6: Commit.** (msg: "Make eval input loader goal optional and preserve metadata")

---

## Task 6: Wire grading module + config into the optimize CLI

**Files:**
- Modify: `lib/config.ts` (type + zod schema)
- Modify: `lib/cli/eval/optimize.ts` (`EvalOptimizeOptions`, async `buildConfig`, `buildTarget`)
- Modify: `scripts/agency.ts` (`--graders` flag + action opt type)
- Test: `lib/cli/eval/optimize.test.ts`

- [ ] **Step 1: Extend the config type + zod schema.** In `lib/config.ts`, the `eval?:` object type (around line 109) gains `optimize`:

```ts
  eval?: {
    runsDir?: string;
    optimizeRunsDir?: string;
    optimize?: {
      goal?: string;
      graders?: string;                              // path to a TS grading module
      validation?: { inputs?: string; split?: number };
    };
  };
```

And the zod schema (around line 327) gains the matching optional object:

```ts
    eval: z
      .object({
        runsDir: z.string(),
        optimizeRunsDir: z.string(),
        optimize: z
          .object({
            goal: z.string().optional(),
            graders: z.string().optional(),
            validation: z.object({ inputs: z.string().optional(), split: z.number().optional() }).optional(),
          })
          .partial()
          .optional(),
      })
      .partial()
      .optional(),
```

(Match the existing `.partial().optional()` style already used for the `eval` block — verify the exact surrounding shape when editing.)

- [ ] **Step 2: Write the failing test** for `buildConfig` resolving a grading module.

```ts
// in lib/cli/eval/optimize.test.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildConfig } from "./optimize.js";

it("uses the default goal LlmJudge when no grading module is configured", async () => {
  const config = await buildConfig({ agent: "a.agency", goal: "g" }, {});
  expect(config.graders).toHaveLength(1);
  expect(config.graders[0].name()).toBe("goal");
});

it("loads graders from a configured grading module instead of the default", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opt-cfg-"));
  const gradingFile = path.join(dir, "grading.ts");
  fs.writeFileSync(gradingFile, `import { grader } from "agency-lang/optimize";
export default [grader(({ output }) => output === "x" ? 1 : 0, { name: "mine" })];`);
  const config = await buildConfig({ agent: "a.agency", graders: gradingFile }, {});
  expect(config.graders.map((g) => g.name())).toEqual(["mine"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

(This test does a real esbuild load resolving `agency-lang/optimize` from the repo's own `node_modules` self-link; if the self-link isn't present in the test environment, fall back to a grading file that imports nothing and asserts the count — but prefer the real-import form to exercise resolution.)

- [ ] **Step 2b: Run; expect failure** (`buildConfig` is sync and ignores `graders`). Run: `pnpm test:run lib/cli/eval/optimize.test.ts 2>&1 | tee /tmp/t6.log`

- [ ] **Step 3: Make `buildConfig` async and grading-module-aware.** In `lib/cli/eval/optimize.ts`:

Add to `EvalOptimizeOptions`:
```ts
  graders?: string;
  validationInputs?: string;   // used in Phase 3
  validationSplit?: number;    // used in Phase 3
```

Change `buildConfig` to async and resolve graders:
```ts
import { loadGradingModule } from "@/optimize/gradingModule.js";
import type { BaseGrader } from "@/optimize/grading/baseGrader.js";

export async function buildConfig(opts: EvalOptimizeOptions, deps: EvalOptimizeDeps): Promise<BaseOptimizerConfig> {
  const config = opts.config ?? {};
  const gradersPath = opts.graders ?? config.eval?.optimize?.graders;
  const graders: BaseGrader[] = gradersPath
    ? await loadGradingModule(gradersPath, config)
    : [new LlmJudge({ name: "goal", agencyFile: goalJudgeFile(), goalPath: ["goal"] })];
  const base: BaseOptimizerConfig = {
    graders,
    iterations: opts.iterations ?? DEFAULT_ITERATIONS,
    seed: opts.seed,
    config,
    runsDir: path.resolve(opts.runsDir ?? config.eval?.optimizeRunsDir ?? path.join(config.eval?.runsDir ?? "runs", "optimize")),
    runId: opts.runId ?? (deps.makeRunId ?? nanoid)(),
    writeback: opts.writeback ?? true,
    mutatorModel: opts.mutatorModel,
    verbosity: opts.silent ? "silent" : "default",
  };
  if (opts.optimizer === "gepa") return { ...base, minibatch: opts.minibatch ?? DEFAULT_MINIBATCH } as BaseOptimizerConfig;
  return base;
}
```

Update the single caller `evalOptimize`: `const config = await buildConfig(opts, deps);`.

- [ ] **Step 4: Make `buildTarget` honor `requireGoal` + an overall goal default.** When a grading module is configured, don't require a per-input `goal`; when `--goal` is set alongside `--inputs`, fill it in as the default goal for inputs that lack one.

```ts
export function buildTarget(opts: EvalOptimizeOptions, deps: EvalOptimizeDeps): OptimizeTarget {
  const selection = validateInputSelection(opts);
  const resolved = resolveEvalRunTarget(opts.agent);
  const hasGraders = !!(opts.graders ?? opts.config?.eval?.optimize?.graders);
  if (selection === "goal") {
    const targetSet = discoverOptimizeTargets(resolved.agentFile);
    rejectGoalForNodeWithRequiredArgs(targetSet, resolved.node);
    return { agent: opts.agent, inputs: [{ id: "input-1", node: resolved.node, args: {}, goal: opts.goal ?? "" }] };
  }
  const loaded = loadInputs(path.resolve(opts.inputs ?? ""), deps.makeId ?? nanoid, { requireGoal: !hasGraders });
  const overallGoal = opts.goal ?? opts.config?.eval?.optimize?.goal;
  const inputs: Input[] = loaded.map((input) => ({
    ...input,
    node: input.node ?? resolved.node,
    ...(input.goal === undefined && overallGoal !== undefined ? { goal: overallGoal } : {}),
  }));
  return { agent: opts.agent, inputs };
}
```

(Note: `validateInputSelection` must still allow `--goal` + `--inputs` together — verify it does after the terminology merge; if it enforces exactly-one, relax it so both may be set, with `--goal` becoming the overall goal. If you change it, update its unit test in `run.test.ts`.)

- [ ] **Step 5: Add the `--graders` CLI flag.** In `scripts/agency.ts`, inside `addOptimizeCommand`, add after the `--inputs` option:

```ts
    .option("--graders <file>", "TypeScript grading module (default-exports graders)")
```

and add `graders?: string;` to the `.action` opts type. `evalOptimize({ ...opts, agent, config: getConfig() })` already forwards it.

- [ ] **Step 6: Run tests + build.**

Run: `pnpm test:run lib/cli/eval/optimize.test.ts lib/cli/eval/run.test.ts 2>&1 | tee /tmp/t6.log` → PASS
Run: `pnpm run build 2>&1 | tee /tmp/t6-build.log` → tsc clean

- [ ] **Step 7: Manual end-to-end smoke (optional, no LLM).** Create `inputs.json` with `{ "inputs": [{ "id": "brazil", "args": { "country": "Brazil" }, "metadata": { "expected": "Brasília" } }] }` and `grading.ts` exact-matching `input.metadata.expected`; run `pnpm run agency optimize foo.agency --inputs inputs.json --graders grading.ts --iterations 0` (or a tiny iteration count) and confirm it loads graders without requiring a goal. Delete the scratch files after.

- [ ] **Step 8: Commit.** (msg: "Wire TS grading modules and eval.optimize config into the optimize CLI")

**Phase 1 is shippable here:** users can supply a custom grading module; the default judge path still works.

---

# Phase 2 — DX / run-directory overhaul

## Task 7: Grade breakdown (serializable per-input/per-grader view)

**Files:**
- Create: `lib/optimize/gradeBreakdown.ts`
- Test: `lib/optimize/gradeBreakdown.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// lib/optimize/gradeBreakdown.test.ts
import { describe, expect, it } from "vitest";
import { Scorecard } from "./grading/scorecard.js";
import { BaseGrader } from "./grading/baseGrader.js";
import type { Grade, GraderInput } from "./grading/types.js";
import { breakdown } from "./gradeBreakdown.js";

class Fixed extends BaseGrader {
  protected readonly defaultName = "fixed";
  constructor(private g: Grade, name: string) { super({ name }); }
  protected _run(_i: GraderInput): Promise<Grade> { return Promise.resolve(this.g); }
}

describe("breakdown", () => {
  it("renders per-input output and each grader's score + feedback", () => {
    const sc = new Scorecard([{
      input: { id: "brazil", args: {} },
      run: { output: "area is 8.5M km²", recordPath: "" },
      gatesPassed: true,
      grades: [{ grader: new Fixed({ score: { kind: "scalar", value: 0.2 }, feedback: "off-topic" }, "goal"), grade: { score: { kind: "scalar", value: 0.2 }, feedback: "off-topic" } }],
    }]);
    expect(breakdown(sc)).toEqual([{
      inputId: "brazil",
      output: "area is 8.5M km²",
      objective: 0.2,
      gatesPassed: true,
      grades: [{ grader: "goal", kind: "scalar", value: 0.2, feedback: "off-topic" }],
    }]);
  });
});
```

- [ ] **Step 2: Run; expect failure.** Run: `pnpm test:run lib/optimize/gradeBreakdown.test.ts 2>&1 | tee /tmp/t7.log`

- [ ] **Step 3: Implement.**

```ts
// lib/optimize/gradeBreakdown.ts
import { inputObjective, type Scorecard } from "./grading/scorecard.js";

export type GradeRow =
  | { grader: string; kind: "scalar"; value: number; feedback?: string }
  | { grader: string; kind: "binary"; pass: boolean; feedback?: string };

export type InputBreakdown = {
  inputId: string;
  output: unknown;
  objective: number;
  gatesPassed: boolean;
  grades: GradeRow[];
};

/** A serializable, human-renderable view of a Scorecard: per input, the output
 *  plus each grader's score and feedback. Used by the per-iteration artifact and report. */
export function breakdown(scorecard: Scorecard): InputBreakdown[] {
  return scorecard.perInput.map((i) => ({
    inputId: i.input.id ?? "(no id)",
    output: i.run.output,
    objective: i.gatesPassed ? inputObjective(i.grades) : 0,
    gatesPassed: i.gatesPassed,
    grades: i.grades.map(({ grader, grade }): GradeRow =>
      grade.score.kind === "scalar"
        ? { grader: grader.name(), kind: "scalar", value: grade.score.value, ...(grade.feedback ? { feedback: grade.feedback } : {}) }
        : { grader: grader.name(), kind: "binary", pass: grade.score.pass, ...(grade.feedback ? { feedback: grade.feedback } : {}) }),
  }));
}
```

(`inputObjective` is already exported from `scorecard.ts`.)

- [ ] **Step 4: Run** → PASS. **Step 5: Build** → tsc clean.

Run: `pnpm test:run lib/optimize/gradeBreakdown.test.ts 2>&1 | tee /tmp/t7.log`; `pnpm run build 2>&1 | tee /tmp/t7-build.log`

- [ ] **Step 6: Commit.** (msg: "Add serializable grade breakdown for optimize reporting")

---

## Task 8: Grader `describe()` + `validateInput()` for echo and eager validation

**Files:**
- Modify: `lib/optimize/grading/baseGrader.ts` (two default methods)
- Modify: `lib/optimize/grading/graders/builtinGraders.ts` (override both on match-based graders)
- Test: `lib/optimize/grading/graders/builtinGraders.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// in lib/optimize/grading/graders/builtinGraders.test.ts
import { ExactMatchGrader } from "./builtinGraders.js";

describe("matcher pre-flight validation", () => {
  it("describe names the grader and its matchOn path", () => {
    const g = new ExactMatchGrader({ matchOn: ["metadata", "expected"] });
    expect(g.describe()).toContain("metadata");
  });

  it("validateInput throws when matchOn does not resolve on the input", () => {
    const g = new ExactMatchGrader({ matchOn: ["metadata", "expected"] });
    expect(() => g.validateInput({ id: "a", args: {} })).toThrow(/matchOn .* did not resolve/);
  });

  it("validateInput passes when matchOn resolves", () => {
    const g = new ExactMatchGrader({ matchOn: ["metadata", "expected"] });
    expect(() => g.validateInput({ id: "a", args: {}, metadata: { expected: "x" } })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run; expect failure** (`describe`/`validateInput` don't exist). Run: `pnpm test:run lib/optimize/grading/graders/builtinGraders.test.ts 2>&1 | tee /tmp/t8.log`

- [ ] **Step 3: Add the default methods to `BaseGrader`.** In `lib/optimize/grading/baseGrader.ts`:

```ts
  /** One-line human description for the startup echo. Default: the grader name. */
  describe(): string {
    return this.name();
  }

  /** Pre-flight check against an input before the run. Default: nothing to check.
   *  Match-based graders override this to fail fast on an unresolved matchOn. */
  validateInput(_input: Input): void { /* no-op */ }
```

(`Input` is already imported in `baseGrader.ts`.)

- [ ] **Step 4: Override on the match-based graders.** In `builtinGraders.ts`, add to `ExactMatchGrader`, `ContainsGrader`, and `SimilarityGrader` (they all have `options.matchOn`). Add a shared helper and the two methods. Put the helper near `resolveMatch`:

```ts
  describe(): string {
    return `${this.name()} (matchOn ${stringify(this.options.matchOn)})`;
  }

  validateInput(input: Input): void {
    resolveMatch(input, this.options.matchOn, this.name());   // throws if unresolved
  }
```

Add these identical two methods to each of the three classes (repeat the code in each — do not share via inheritance, they already each carry `options.matchOn`). `Input` is imported already.

- [ ] **Step 5: Run** → PASS. **Step 6: Build** → tsc clean.

Run: `pnpm test:run lib/optimize/grading/graders/builtinGraders.test.ts 2>&1 | tee /tmp/t8.log`; `pnpm run build 2>&1 | tee /tmp/t8-build.log`

- [ ] **Step 7: Commit.** (msg: "Add grader describe() and validateInput() for echo and pre-flight checks")

---

## Task 9: Startup echo + eager fail-fast validation in BaseOptimizer

**Files:**
- Modify: `lib/optimize/reporter.ts` (add `gradingSetup` to `PointwiseReporter` + default/silent impls)
- Modify: `lib/optimize/baseOptimizer.ts` (`optimize()` echoes + validates before search)
- Test: `lib/optimize/baseOptimizer.test.ts`

- [ ] **Step 1: Write the failing test** (uses the `Probe` subclass already in the test file; add to it the ability to call `optimize`). Add a test that a grader failing `validateInput` aborts before any run.

```ts
// in lib/optimize/baseOptimizer.test.ts
import { BaseGrader } from "./grading/baseGrader.js";

it("fails fast when a grader's validateInput rejects the first input, before running the agent", async () => {
  class NeedsExpected extends BaseGrader {
    protected readonly defaultName = "needs-expected";
    validateInput(input: any): void { if (!input.metadata?.expected) throw new Error("matchOn [metadata,expected] did not resolve"); }
    protected _run(): Promise<any> { return Promise.resolve({ score: { kind: "scalar", value: 1 } }); }
  }
  const runInput = vi.fn(async () => ({ output: "x", recordPath: "" }));
  // Probe.optimizeTargets is a stub returning {}; add a discover dep + a grader that rejects.
  const p = new (class extends BaseOptimizer {
    readonly name = "probe2";
    protected async optimizeTargets(): Promise<OptimizeResult> { return {} as OptimizeResult; }
  })(
    { graders: [new NeedsExpected()], iterations: 1, config: {}, runsDir: root, runId: "r" },
    { workspaceRoot: path.join(root, "ws"), runInput, discover: () => ({ baseDir: src, entryFile: "agent.agency", files: {}, targets: [{ id: "t", kind: "variable", file: "agent.agency", absoluteFile: path.join(src, "agent.agency"), scope: "global", name: "p", valueKind: "string", value: "x" }] }) },
  );
  await expect(p.optimize({ agent: path.join(src, "agent.agency"), inputs: [{ id: "a", args: {} }] }))
    .rejects.toThrow(/did not resolve/);
  expect(runInput).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run; expect failure** (no validation happens; `optimizeTargets` stub returns and `runInput` is never called, but also no throw). Run: `pnpm test:run lib/optimize/baseOptimizer.test.ts 2>&1 | tee /tmp/t9.log`

- [ ] **Step 3: Add `gradingSetup` to the reporter.** In `lib/optimize/reporter.ts`, add to the `PointwiseReporter` type:

```ts
  gradingSetup(args: { graders: { name: string; describe: string }[]; firstInput?: { id: string; goal?: string } }): void;
```

In `createPointwiseReporter`'s returned object:
```ts
    gradingSetup({ graders, firstInput }) {
      log(color.yellow("  grading:"));
      for (const g of graders) log(`    - ${g.describe}`);
      if (firstInput) log(color.dim(`    first input: ${firstInput.id}${firstInput.goal ? ` — goal: ${truncate(firstInput.goal, 80)}` : ""}`));
    },
```

Add `gradingSetup() { }` to `SILENT_POINTWISE_REPORTER`.

- [ ] **Step 4: Echo + validate in `optimize()`.** In `lib/optimize/baseOptimizer.ts`, after the `source.targets.length === 0` guard and before `return this.optimizeTargets(...)`:

```ts
    this.echoAndValidateGrading(target.inputs);
    return this.optimizeTargets(source, target.inputs);
  }

  /** Print the resolved grading setup and fail fast on a misconfigured grader,
   *  checked against the first input before any agent run. */
  private echoAndValidateGrading(inputs: Input[]): void {
    this.reporter.gradingSetup({
      graders: this.config.graders.map((g) => ({ name: g.name(), describe: g.describe() })),
      firstInput: inputs[0] ? { id: inputs[0].id ?? "(no id)", goal: inputs[0].goal } : undefined,
    });
    const first = inputs[0];
    if (!first) return;
    for (const grader of this.config.graders) {
      if (grader.gradesInput(first)) grader.validateInput(first);
    }
  }
```

- [ ] **Step 5: Run** → PASS. **Step 6: Build** → tsc clean. Also run the existing greedy/gepa optimizer tests to confirm the new abstract reporter method didn't break their inline reporters.

Run: `pnpm test:run lib/optimize/baseOptimizer.test.ts lib/optimize/optimizers/greedyReflective.test.ts 2>&1 | tee /tmp/t9.log`
Run: `pnpm run build 2>&1 | tee /tmp/t9-build.log`

(If any test constructs a `PointwiseReporter` literal, it now needs a `gradingSetup` member — add `gradingSetup() {}` to those test doubles.)

- [ ] **Step 7: Commit.** (msg: "Echo resolved grading setup and fail fast on misconfigured graders")

---

## Task 10: Headline `report.md` + per-iteration breakdown artifacts

**Files:**
- Create: `lib/optimize/report.ts`
- Test: `lib/optimize/report.test.ts`
- Modify: `lib/cli/eval/optimize.ts` (write the report after the run)

The optimizer already returns an `OptimizeResult` with `iterations`, `championIter`, `championFiles`, and decision counts, and `evalOptimize` already writes `summary.json` into `result.runDir`. This task adds a human-readable `report.md` next to it. The per-input breakdown for the champion is recomputed by re-grading the champion files (cheap relative to the search) — OR, simpler and LLM-free, render what the result already carries. To keep this task free of extra agent runs, render from `OptimizeResult` only; the champion per-input breakdown is added in Phase 3 where validation scoring already re-evaluates.

- [ ] **Step 1: Write the failing test** (pure `renderReport`).

```ts
// lib/optimize/report.test.ts
import { describe, expect, it } from "vitest";
import { renderReport } from "./report.js";
import type { OptimizeResult } from "./types.js";

const result: OptimizeResult = {
  runId: "r1", runDir: "/runs/r1", championIter: 2,
  championFiles: { "agent.agency": "node main() {}\n" },
  acceptedCount: 1, rejectedCount: 1, validationFailedCount: 0,
  iterations: [
    { iter: 0, decision: "baseline", winsA: 0, winsB: 0, ties: 0 },
    { iter: 1, decision: "rejected", winsA: 0, winsB: 0, ties: 0, detail: "no improvement" },
    { iter: 2, decision: "accepted", winsA: 0, winsB: 0, ties: 0 },
  ],
};

describe("renderReport", () => {
  it("includes the run id, champion, decision counts, and per-iteration table", () => {
    const md = renderReport(result, { optimizer: "greedy", graders: ["goal"] });
    expect(md).toContain("# Optimize run r1");
    expect(md).toContain("greedy");
    expect(md).toContain("Champion: iteration 2");
    expect(md).toContain("accepted: 1");
    expect(md).toMatch(/\| 1 \| rejected \| no improvement \|/);
  });
});
```

- [ ] **Step 2: Run; expect failure.** Run: `pnpm test:run lib/optimize/report.test.ts 2>&1 | tee /tmp/t10.log`

- [ ] **Step 3: Implement.**

```ts
// lib/optimize/report.ts
import * as fs from "fs";
import * as path from "path";

import type { OptimizeResult } from "./types.js";

export type ReportMeta = {
  optimizer: string;
  graders: string[];
  trainObjective?: number;        // populated in Phase 3
  validationObjective?: number;   // populated in Phase 3
};

/** Render a human-readable Markdown report for an optimize run. Pure. */
export function renderReport(result: OptimizeResult, meta: ReportMeta): string {
  const lines: string[] = [];
  lines.push(`# Optimize run ${result.runId}`, "");
  lines.push(`- Optimizer: ${meta.optimizer}`);
  lines.push(`- Graders: ${meta.graders.join(", ") || "(none)"}`);
  lines.push(`- Champion: iteration ${result.championIter}`);
  if (meta.trainObjective !== undefined) lines.push(`- Train objective: ${meta.trainObjective.toFixed(3)}`);
  if (meta.validationObjective !== undefined) lines.push(`- Validation objective: ${meta.validationObjective.toFixed(3)}`);
  lines.push(`- Decisions — accepted: ${result.acceptedCount}, rejected: ${result.rejectedCount}, invalid: ${result.validationFailedCount}`, "");
  lines.push("## Iterations", "", "| iter | decision | detail |", "| --- | --- | --- |");
  for (const it of result.iterations) {
    lines.push(`| ${it.iter} | ${it.decision} | ${(it.detail ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Write report.md into the run directory. */
export function writeReport(runDir: string, result: OptimizeResult, meta: ReportMeta): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "report.md"), renderReport(result, meta));
}
```

- [ ] **Step 4: Write `report.md` from the CLI.** In `lib/cli/eval/optimize.ts` `evalOptimize`, after writing `summary.json`:

```ts
import { writeReport } from "@/optimize/report.js";
// …after the summary.json write, inside the `if (result.runDir)` block:
    writeReport(result.runDir, result, {
      optimizer: opts.optimizer ?? "greedy",
      graders: config.graders.map((g) => g.name()),
    });
```

(`config` is already in scope in `evalOptimize`.)

- [ ] **Step 5: Run + build** → PASS / clean.

Run: `pnpm test:run lib/optimize/report.test.ts lib/cli/eval/optimize.test.ts 2>&1 | tee /tmp/t10.log`
Run: `pnpm run build 2>&1 | tee /tmp/t10-build.log`

- [ ] **Step 6: Commit.** (msg: "Write a headline report.md alongside summary.json")

**Phase 2 is shippable here.**

---

# Phase 3 — Validation set

## Task 11: Seeded train/validation split utility

**Files:**
- Create: `lib/optimize/validationSplit.ts`
- Test: `lib/optimize/validationSplit.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// lib/optimize/validationSplit.test.ts
import { describe, expect, it } from "vitest";
import type { Input } from "@/eval/runTypes.js";
import { splitInputs } from "./validationSplit.js";

const inputs = (n: number): Input[] => Array.from({ length: n }, (_u, i) => ({ id: `i${i}`, args: {} }));

describe("splitInputs", () => {
  it("holds out floor(ratio * n) inputs for validation", () => {
    const { train, validation } = splitInputs(inputs(10), 0.3, 1);
    expect(validation).toHaveLength(3);
    expect(train).toHaveLength(7);
  });

  it("is deterministic for a given seed and partitions without overlap", () => {
    const a = splitInputs(inputs(10), 0.3, 42);
    const b = splitInputs(inputs(10), 0.3, 42);
    expect(a.validation.map((i) => i.id)).toEqual(b.validation.map((i) => i.id));
    const ids = new Set([...a.train, ...a.validation].map((i) => i.id));
    expect(ids.size).toBe(10);
  });

  it("never leaves train empty (keeps at least one) and clamps ratio", () => {
    const { train, validation } = splitInputs(inputs(2), 0.9, 1);
    expect(train.length).toBeGreaterThanOrEqual(1);
    expect(train.length + validation.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run; expect failure.** Run: `pnpm test:run lib/optimize/validationSplit.test.ts 2>&1 | tee /tmp/t11.log`

- [ ] **Step 3: Implement** (deterministic mulberry32 PRNG — no `Math.random`).

```ts
// lib/optimize/validationSplit.ts
import type { Input } from "@/eval/runTypes.js";

export type Split = { train: Input[]; validation: Input[] };

/** Hold out a fraction of inputs for validation, deterministically by seed.
 *  Always keeps at least one training input. */
export function splitInputs(inputs: Input[], ratio: number, seed = 0): Split {
  const clamped = Math.max(0, Math.min(1, ratio));
  const shuffled = shuffle(inputs, seed);
  const maxHoldout = Math.max(0, inputs.length - 1);
  const holdout = Math.min(maxHoldout, Math.floor(clamped * inputs.length));
  return { validation: shuffled.slice(0, holdout), train: shuffled.slice(holdout) };
}

function shuffle(items: Input[], seed: number): Input[] {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Build** → tsc clean.

Run: `pnpm test:run lib/optimize/validationSplit.test.ts 2>&1 | tee /tmp/t11.log`; `pnpm run build 2>&1 | tee /tmp/t11-build.log`

- [ ] **Step 6: Commit.** (msg: "Add seeded train/validation split utility")

---

## Task 12: Thread validation inputs through target/result/BaseOptimizer

**Files:**
- Modify: `lib/optimize/optimizer.ts` (`OptimizeTarget.validationInputs?`)
- Modify: `lib/optimize/types.ts` (`OptimizeResult.trainObjective?` / `validationObjective?`)
- Modify: `lib/optimize/baseOptimizer.ts` (store `validationInputs`; add `scoreFiles` helper)
- Test: `lib/optimize/baseOptimizer.test.ts`

- [ ] **Step 1: Extend the types.** In `optimizer.ts`:
```ts
export type OptimizeTarget = { agent: string; inputs: Input[]; validationInputs?: Input[] };
```
In `types.ts`, add to `OptimizeResult` (find the type and add two optional fields):
```ts
  trainObjective?: number;
  validationObjective?: number;
```

- [ ] **Step 2: Write the failing test** for `scoreFiles` (exposed via the `Probe` subclass).

```ts
// in lib/optimize/baseOptimizer.test.ts — extend Probe with:
//   scoreFilesAt(source: OptimizeTargetSet, files: Record<string,string>, inputs: Input[]) {
//     return this.scoreFiles(source, files, inputs);
//   }
it("scoreFiles forks, applies files, and grades the given inputs", async () => {
  const p = probe([new FixedGrader({ score: { kind: "scalar", value: 0.4 } })], fixedRun);
  const source = { baseDir: src, entryFile: "agent.agency", files: { "agent.agency": { file: "agent.agency", absoluteFile: path.join(src, "agent.agency"), source: "node main() {}\n", sha256: "x" } }, targets: [] };
  const sc = await p.scoreFilesAt(source as any, { "agent.agency": "node main() {}\n" }, [{ id: "a", args: {} }]);
  expect(sc.objective()).toBeCloseTo(0.4, 10);
});
```

- [ ] **Step 3: Run; expect failure.** Run: `pnpm test:run lib/optimize/baseOptimizer.test.ts 2>&1 | tee /tmp/t12.log`

- [ ] **Step 4: Implement in `baseOptimizer.ts`.** Add a protected field + set it in `optimize()`, and add `scoreFiles`:

```ts
  protected validationInputs: Input[] = [];
```
In `optimize()`, right after resolving `source`:
```ts
    this.validationInputs = target.validationInputs ?? [];
```
Add the helper (mirrors greedy's `makeCandidate` fork+apply+evaluate):
```ts
  /** Fork the agent, apply a candidate's files, and grade it on the given inputs. */
  protected async scoreFiles(source: OptimizeTargetSet, files: Record<string, string>, inputs: Input[]): Promise<Scorecard> {
    const ws = this.fork(source.baseDir);
    this.workspace.applyFiles(ws, files);
    return this.evaluate(ws, source.entryFile, inputs);
  }
```

- [ ] **Step 5: Run** → PASS. **Step 6: Build** → tsc clean.

Run: `pnpm test:run lib/optimize/baseOptimizer.test.ts 2>&1 | tee /tmp/t12.log`; `pnpm run build 2>&1 | tee /tmp/t12-build.log`

- [ ] **Step 7: Commit.** (msg: "Thread validation inputs and scoreFiles helper through BaseOptimizer")

---

## Task 13: Greedy picks the writeback champion by validation objective

**Files:**
- Modify: `lib/optimize/optimizers/greedyReflective.ts`
- Test: `lib/optimize/optimizers/greedyReflective.test.ts`

Behavior: search/acceptance still run on train (unchanged). In `finish`, when `this.validationInputs` is non-empty, score baseline + every accepted candidate on validation and write back the one with the best validation objective; record `trainObjective` (champion's train objective) and `validationObjective` (the chosen one's val objective) on the result. With no validation set, behavior is exactly as today.

- [ ] **Step 1: Write the failing test.** A run where the train-best candidate overfits (high train, low val) and an earlier candidate generalizes (lower train, higher val); assert the validation winner is written back.

```ts
// in lib/optimize/optimizers/greedyReflective.test.ts
it("writes back the candidate with the best validation objective, not the best train objective", async () => {
  // train grader climbs each candidate (0.2, 0.4, 0.6...) so all are accepted;
  // val grader peaks on the FIRST candidate then drops, so iter 1 is the val winner.
  let trainN = 0; const train = new ValueGrader(() => 0.2 * ++trainN);          // baseline .2, c1 .4, c2 .6
  const valByObjective: Record<string, number> = {};
  let call = 0; const valScores = [0.3, 0.9, 0.5, 0.5]; // baseline, c1, c2, (champion re-score order)
  const val = new ValueGrader(() => valScores[Math.min(call++, valScores.length - 1)]);
  // Use deps to make every proposal valid; two iterations → two accepted candidates.
  const opt = new GreedyReflective(
    { graders: [train], iterations: 2, config: {}, runsDir: root, runId: "valpick", writeback: false },
    { ...deps(), /* validation graders are applied via a separate scoreFiles path — see note */ },
  );
  const result = await opt.optimize({
    agent: path.join(src, "agent.agency"),
    inputs: [{ id: "a", args: {} }],
    validationInputs: [{ id: "v", args: {} }],
  });
  expect(result.championIter).toBe(1);            // val winner, though iter 2 had higher train objective
  expect(result.validationObjective).toBeCloseTo(0.9, 5);
});
```

> **Implementer note on the test:** the single `ValueGrader` returns the same value regardless of which input set it grades, so to distinguish train vs. validation scoring you need a grader whose value depends on the input id (e.g. `new (class extends BaseGrader { _run({input}) { return {score:{kind:"scalar", value: input.id === "v" ? valFor(...) : trainFor(...)}} } })`). Rewrite the fixture so one grader returns a train curve for input `a` and a val curve for input `v`; the assertion (val winner = iter 1) is the point. Keep the fixture deterministic.

- [ ] **Step 2: Run; expect failure** (greedy ignores validation; `championIter` would be 2). Run: `pnpm test:run lib/optimize/optimizers/greedyReflective.test.ts 2>&1 | tee /tmp/t13.log`

- [ ] **Step 3: Implement.** Change `optimizeTargets`/`finish` to select by validation when present. Replace `finish` and adjust the champion choice:

```ts
  protected async optimizeTargets(source: OptimizeTargetSet, inputs: Input[]): Promise<OptimizeResult> {
    const startedAt = Date.now();
    this.reporter.runStarted({ optimizer: this.name, runId: this.config.runId, targets: source.targets, inputCount: inputs.length, iterations: this.config.iterations });
    const baseline = await this.makeCandidate("baseline", this.fork(source.baseDir), source, inputs);
    this.requireBaselineGatesPass(baseline.scorecard);
    this.reporter.baselineScored({ objective: baseline.scorecard.objective() });

    if (this.isMaxObjective(baseline.scorecard)) {
      this.reporter.note("baseline already scores the maximum objective (1.000) — nothing to optimize");
      return this.finish(source, baseline, [baseline], [], startedAt);
    }
    const attempts = await this.hillClimb(baseline, inputs);
    const accepted = attempts.filter((a) => a.decision === "accepted" && a.candidate).map((a) => a.candidate!);
    const trainChampion = accepted.length ? accepted[accepted.length - 1] : baseline;
    return this.finish(source, trainChampion, [baseline, ...accepted], attempts, startedAt);
  }

  /** Choose the writeback champion (validation objective when a validation set
   *  exists, else the train champion), write it back, build + report the result. */
  private async finish(
    source: OptimizeTargetSet,
    trainChampion: Candidate,
    candidates: Candidate[],
    attempts: Attempt[],
    startedAt: number,
  ): Promise<OptimizeResult> {
    let champion = trainChampion;
    let validationObjective: number | undefined;
    if (this.validationInputs.length > 0) {
      let best = -1;
      for (const candidate of candidates) {
        const sc = await this.scoreFiles(source, candidate.files, this.validationInputs);
        const obj = sc.gatesPassed() ? sc.objective() : 0;
        if (obj > best) { best = obj; champion = candidate; validationObjective = obj; }
      }
    }
    if (this.config.writeback && champion.iter !== "baseline") {
      this.workspace.writeBack(source, champion.files);
    }
    const result = this.buildPointwiseResult({
      championIter: champion.iter, championFiles: champion.files,
      attempts: attempts.map((a) => ({ iter: a.iter, decision: a.decision, detail: attemptDetail(a) })),
    });
    result.trainObjective = champion.scorecard.objective();
    if (validationObjective !== undefined) result.validationObjective = validationObjective;
    this.reporter.runFinished({ result, initialTargets: source.targets, finalTargets: champion.targetSet.targets, durationMs: Date.now() - startedAt });
    return result;
  }
```

`optimizeTargets` is already `async`; `finish` is now `async` and awaited (it's `return this.finish(...)`, which returns a Promise — fine). Update the two call sites to `return this.finish(...)` (already returning). Note `buildPointwiseResult` returns a fresh object so assigning `result.trainObjective` is safe.

- [ ] **Step 4: Run** → PASS. **Step 5: Build** → tsc clean. Run the full optimizer test file to confirm no-validation runs are unchanged.

Run: `pnpm test:run lib/optimize/optimizers/greedyReflective.test.ts 2>&1 | tee /tmp/t13.log`
Run: `pnpm run build 2>&1 | tee /tmp/t13-build.log`

- [ ] **Step 6: Commit.** (msg: "Greedy: select writeback champion by validation objective")

---

## Task 14: Load validation inputs / split in the CLI; surface in the report

**Files:**
- Modify: `lib/cli/eval/optimize.ts` (`buildTarget` populates `validationInputs`)
- Modify: `scripts/agency.ts` (`--validation-inputs` / `--validation-split` flags + opt type)
- Modify: `lib/cli/eval/optimize.ts` (`evalOptimize` passes train+val objective into the report meta)
- Test: `lib/cli/eval/optimize.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// in lib/cli/eval/optimize.test.ts
import { buildTarget } from "./optimize.js";

it("loads validation inputs from a file into the target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "valt-"));
  fs.writeFileSync(path.join(dir, "train.json"), JSON.stringify({ inputs: [{ id: "t", goal: "g", args: {} }] }));
  fs.writeFileSync(path.join(dir, "val.json"), JSON.stringify({ inputs: [{ id: "v", goal: "g", args: {} }] }));
  const target = buildTarget({ agent: "foo.agency:main", inputs: path.join(dir, "train.json"), validationInputs: path.join(dir, "val.json") } as any, {});
  expect(target.validationInputs?.map((i) => i.id)).toEqual(["v"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

it("splits train inputs by ratio when --validation-split is given", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vals-"));
  const inputs = Array.from({ length: 10 }, (_u, i) => ({ id: `t${i}`, goal: "g", args: {} }));
  fs.writeFileSync(path.join(dir, "train.json"), JSON.stringify({ inputs }));
  const target = buildTarget({ agent: "foo.agency:main", inputs: path.join(dir, "train.json"), validationSplit: 0.3, seed: 1 } as any, {});
  expect(target.validationInputs).toHaveLength(3);
  expect(target.inputs).toHaveLength(7);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

(`foo.agency:main` must resolve — point `agent` at a real fixture agent in the test, mirroring the existing `optimize.test.ts` fixtures, or stub `resolveEvalRunTarget`/`discoverOptimizeTargets` the way the file already does. Match the existing test setup in `optimize.test.ts`.)

- [ ] **Step 2: Run; expect failure.** Run: `pnpm test:run lib/cli/eval/optimize.test.ts 2>&1 | tee /tmp/t14.log`

- [ ] **Step 3: Implement `buildTarget` validation handling.** Extend the tasks branch of `buildTarget`:

```ts
import { splitInputs } from "@/optimize/validationSplit.js";
// …inside buildTarget, after computing `inputs` for the --inputs path:
  const valOpts = opts.config?.eval?.optimize?.validation;
  const valInputsPath = opts.validationInputs ?? valOpts?.inputs;
  const valSplit = opts.validationSplit ?? valOpts?.split;
  if (valInputsPath) {
    const validationInputs = loadInputs(path.resolve(valInputsPath), deps.makeId ?? nanoid, { requireGoal: !hasGraders })
      .map((input) => ({ ...input, node: input.node ?? resolved.node, ...(input.goal === undefined && overallGoal !== undefined ? { goal: overallGoal } : {}) }));
    return { agent: opts.agent, inputs, validationInputs };
  }
  if (valSplit !== undefined) {
    const { train, validation } = splitInputs(inputs, valSplit, opts.seed ?? 0);
    return { agent: opts.agent, inputs: train, validationInputs: validation };
  }
  return { agent: opts.agent, inputs };
```

(The `--goal`-only branch returns a single input and no validation — leave it as-is.)

- [ ] **Step 4: Add the CLI flags.** In `scripts/agency.ts` `addOptimizeCommand`, after `--graders`:

```ts
    .option("--validation-inputs <fileOrDir>", "Held-out validation input suite")
    .option("--validation-split <ratio>", "Hold out this fraction of inputs for validation", (v) => parseFloat(v))
```
Add to the `.action` opts type: `validationInputs?: string; validationSplit?: number;`.

- [ ] **Step 5: Surface train/val objective in the report.** In `evalOptimize`, pass them into `writeReport` meta:

```ts
    writeReport(result.runDir, result, {
      optimizer: opts.optimizer ?? "greedy",
      graders: config.graders.map((g) => g.name()),
      trainObjective: result.trainObjective,
      validationObjective: result.validationObjective,
    });
```

- [ ] **Step 6: Run + build** → PASS / clean.

Run: `pnpm test:run lib/cli/eval/optimize.test.ts 2>&1 | tee /tmp/t14.log`
Run: `pnpm run build 2>&1 | tee /tmp/t14-build.log`

- [ ] **Step 7: Commit.** (msg: "Load validation inputs/split in the optimize CLI and report train-vs-val")

---

## Task 15: Docs

**Files:**
- Modify: `docs/site/cli/eval.md` (or wherever optimize is documented — grep first) to document `--graders`, the grading-module shape (`agency-lang/optimize`), `eval.optimize` config, and `--validation-inputs`/`--validation-split`.
- Create: a short example grading module under `docs/site/` examples if the docs site has an examples convention (grep for existing optimize examples first).

- [ ] **Step 1: Find where optimize is documented.**

Run: `grep -rln "agency optimize\|--optimizer\|eval optimize" docs/site --include=*.md`

- [ ] **Step 2: Write the docs** for: the grading-module surface (a metric function and an array example, importing from `agency-lang/optimize`), where per-input data lives (`metadata`), the `--graders` flag and `eval.optimize.graders` config, the default-judge fallback (`--goal`), and validation (`--validation-inputs` / `--validation-split`, train-drives-search / val-picks-champion, the `report.md` train-vs-val line). Use the exact `grading.ts` example from the spec (with `input.metadata?.expectedCapital`).

- [ ] **Step 3: Verify links/anchors render** (no build step needed for hand-written md). Commit. (msg: "Document custom graders, grading modules, and validation sets")

---

## Known Limitations (record honestly; do not hide)

- **Champion-by-validation is implemented for `greedy` (the default) only.** `gepa` and `example` run the search and select their champion on the train objective; when a validation set is present they should still *report* a validation objective, but they do **not** re-pick the champion by validation. This is a deliberate scope cut to avoid rewriting GEPA's Pareto selection in this plan. If GEPA validation-selection is wanted, it is a follow-up: apply the same `scoreFiles(source, files, validationInputs)` pass over GEPA's final Pareto candidates. Add a one-line `reporter.note(...)`/`report.md` caveat in `gepa.ts` when `this.validationInputs.length > 0` so users aren't misled. (If time permits, do this in Task 13b; otherwise leave the note and the follow-up.)
- **The per-input grade breakdown artifact** (`gradeBreakdown.breakdown`) is built and unit-tested in Task 7 but only *wired into a written artifact* where re-evaluation already happens (validation scoring). Writing a champion per-input breakdown for the non-validation path would cost an extra grading pass; defer unless desired. If wanted, write `breakdown(championScorecard)` to `runDir/champion/grades.json` from greedy's `finish`.

---

## Self-Review

**1. Spec coverage:**
- Config surface (`eval.optimize`, `--goal`+`--inputs` combinable, flag table): Task 6 (config + buildTarget), Task 14 (validation flags). ✓
- Custom grader module — esbuild load, four export forms, `grader()` wrapper, `agency-lang/optimize`, metadata: Tasks 2–4, 6. ✓ (subclass form (d) is supported because `toGrader` passes any `BaseGrader` through.)
- Default behavior (no grader file → `LlmJudge` `goalPath:["goal"]`; loader goal relaxation): Tasks 1, 5, 6. ✓
- Validation set (file + split, train-drives-search/val-picks-champion, train-vs-val report): Tasks 11–14. ✓ (greedy fully; gepa/example reporting-only — Known Limitations.)
- DX: startup echo (Task 9), eager fail-fast (Tasks 8–9), per-input breakdown (Task 7), headline report.md (Task 10). ✓
- Out of scope honored: no `loop.ts`/`artifacts.ts` changes; no `EvalTask` nomenclature work (already merged). ✓

**2. Placeholder scan:** Each code step shows full code; commands give exact files + expected PASS/clean. The two test fixtures that need input-id-dependent grading (Task 13) carry an explicit implementer note with the shape to write, not a vague "add a test." No "TBD"/"handle edge cases."

**3. Type consistency:** `loadGradingModule(filePath, config)`, `toGrader(spec)`, `grader(fn, opts)`, `FunctionGrader`, `GraderContext{output,input,judge}`, `breakdown(scorecard): InputBreakdown[]`, `renderReport(result, meta)`/`writeReport(runDir, result, meta)`, `splitInputs(inputs, ratio, seed): {train, validation}`, `OptimizeTarget.validationInputs?`, `OptimizeResult.trainObjective?`/`validationObjective?`, `BaseGrader.describe()`/`validateInput(input)`, `PointwiseReporter.gradingSetup(...)`, `scoreFiles(source, files, inputs)` — names used consistently across tasks. `buildConfig`/`buildTarget` signatures match their callers (`buildConfig` becomes async; `evalOptimize` awaits it). ✓
