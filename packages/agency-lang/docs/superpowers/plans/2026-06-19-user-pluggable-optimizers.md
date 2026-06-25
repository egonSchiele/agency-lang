# User-pluggable optimizers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. (Per the repo owner's standing preference, implement directly in the main session — no subagent-driven development.)

**Goal:** Let users write a custom optimizer in their own TypeScript file and run it with `agency optimize … --optimizer ./myOptimizer.ts`, exactly mirroring the custom-grader path (`--graders ./grading.ts`). Today an optimizer can only be added by editing the in-repo registry, and `BaseOptimizer` isn't even exported.

**Architecture:** Two missing halves, both parallel to custom graders: (1) export the optimizer-authoring surface from `agency-lang/optimize` so an out-of-repo module can `extends BaseOptimizer`; (2) an esbuild module loader (`loadOptimizerModule`, mirroring `loadGradingModule`) plus a `resolveOptimizer(nameOrPath, config)` that loads a path or falls back to the built-in registry. The loaded value is used **structurally** as an `Optimizer` (`{ name, optimize }`) — no `instanceof` — so the cross-realm hazard we hit with graders doesn't apply.

**Tech Stack:** TypeScript (Node, ESM, `@/` alias, `.js` import extensions), vitest, esbuild (already a dep). No `.agency`/stdlib changes, so `npx tsc --noEmit` is the typecheck and `pnpm run build` only needed before a live CLI run.

**Reference:** the grader equivalents — `lib/optimize/gradingModule.ts` (`loadGradingModule`), `lib/optimize/public.ts`, `docs/dev/writing-optimizers.md`, and the `--graders` wiring in `lib/cli/eval/optimize.ts`.

---

## Global Constraints

- Code style (enforced by `pnpm run lint:structure`): objects not maps, arrays not sets, `type` not `interface`. The module loader uses `await import()` — a CLI-layer load of a user artifact, same as `gradingModule.ts`/`serve.ts`; carry the same `// eslint-disable-next-line no-restricted-syntax` justification.
- Run only the vitest files named per task (save output with `… 2>&1 | tee /tmp/out.log`). Do not run the full agency suite locally.
- Commit after each task; write the message to a file and `git commit -F`; end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- **Branch:** `user-pluggable-optimizers` (already created off `main`).

---

## File Structure

- Modify `lib/optimize/public.ts` — export the optimizer-authoring surface.
- Create `lib/optimize/optimizerModule.ts` — `loadOptimizerModule(filePath)` (esbuild → default-exported factory).
- Modify `lib/cli/eval/optimize.ts` — `resolveOptimizer(nameOrPath, config, deps)`; thread an optional `optimizer` from `eval.optimize`; use the resolved optimizer's `name` for the gepa check and report meta.
- Modify `lib/config.ts` — `eval.optimize.optimizer?` (type + zod).
- Modify `scripts/agency.ts` — `--optimizer` help text mentions a path.
- Modify `docs/site/cli/optimize.md` and `docs/dev/writing-optimizers.md` — document the path loader + factory convention.

---

## Task 1: Export the optimizer-authoring surface

A user module can't `extends BaseOptimizer` today because `agency-lang/optimize` only exports the grader surface. Add the optimizer types/classes/helpers an optimizer (e.g. a copy of `example.ts`/`greedyReflective.ts`) needs.

**Files:**
- Modify: `lib/optimize/public.ts`
- Test: `lib/optimize/public.test.ts`

- [ ] **Step 1: Write the failing test** (extend the existing `public.test.ts`).

```ts
// in lib/optimize/public.test.ts
it("exports the optimizer-authoring surface", () => {
  expect(typeof api.BaseOptimizer).toBe("function");
  expect(typeof api.fileMap).toBe("function");
  expect(typeof api.proposeMutation).toBe("function");
  expect(typeof api.defaultPreview).toBe("function");
  expect(typeof api.renderReflectionFeedback).toBe("function");
  expect(typeof api.splitInputs).toBe("function");
  expect(typeof api.breakdown).toBe("function");
  expect(typeof api.Scorecard).toBe("function");
});
```

- [ ] **Step 2: Run; expect failure.** Run: `pnpm test:run lib/optimize/public.test.ts 2>&1 | tee /tmp/t1.log`

- [ ] **Step 3: Add the exports** to `lib/optimize/public.ts` (append after the grader exports):

```ts
// --- optimizer authoring surface ---
export { BaseOptimizer } from "./baseOptimizer.js";
export type { BaseOptimizerDeps, RunInput, MutationOutcome } from "./baseOptimizer.js";
export type { Optimizer, OptimizerFactory, BaseOptimizerConfig, OptimizeTarget } from "./optimizer.js";
export type { OptimizeResult, MutationProposal } from "./types.js";
export { fileMap } from "./targets.js";
export type { OptimizeTargetSet, OptimizeTarget as OptimizeTargetDecl } from "./targets.js";
export { Scorecard, inputObjective } from "./grading/scorecard.js";
export type { GraderGrade, InputGrades } from "./grading/scorecard.js";
export { proposeMutation } from "./mutator.js";
export type { ProposeMutationArgs } from "./mutator.js";
export { defaultPreview } from "./sourceMutator.js";
export type { OptimizeMutationOperation, OptimizeMutationPreview, OptimizeMutationDiagnostic, OptimizeAppliedChange } from "./sourceMutator.js";
export { renderReflectionFeedback, renderInputFeedback } from "./reflectionFeedback.js";
export { splitInputs } from "./validationSplit.js";
export { breakdown } from "./gradeBreakdown.js";
export type { InputBreakdown, GradeRow } from "./gradeBreakdown.js";
```

(Note the alias `OptimizeTarget as OptimizeTargetDecl` — `targets.ts` and `optimizer.ts` both export an `OptimizeTarget`; the run-level one from `optimizer.ts` keeps the bare name, the discovered-declaration one is re-exported as `OptimizeTargetDecl`.)

- [ ] **Step 4: Run + typecheck + lint.**

Run: `pnpm test:run lib/optimize/public.test.ts 2>&1 | tee /tmp/t1.log` → PASS
Run: `npx tsc --noEmit` → 0; `pnpm run lint:structure`

- [ ] **Step 5: Commit.** (msg: "Export the optimizer-authoring surface from agency-lang/optimize")

---

## Task 2: `loadOptimizerModule` — esbuild-load a user optimizer file

Mirror `loadGradingModule`. The module **default-exports an `OptimizerFactory`** (`(config) => Optimizer`) — the same shape `registerOptimizer` takes. The loader transpiles with esbuild (leaving `agency-lang` external), imports the default export, and validates it's a function. Applying the factory + validating the produced `Optimizer` happens in Task 3 (where `config` exists).

**Files:**
- Create: `lib/optimize/optimizerModule.ts`
- Test: `lib/optimize/optimizerModule.test.ts`

- [ ] **Step 1: Write the failing tests** (real temp files on disk; no LLM). Mirror `gradingModule.test.ts`.

```ts
// lib/optimize/optimizerModule.test.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadOptimizerModule } from "./optimizerModule.js";

describe("loadOptimizerModule", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (src: string): string => {
    const p = path.join(dir, "opt.ts");
    fs.writeFileSync(p, src);
    return p;
  };

  it("returns the default-exported factory function", async () => {
    const file = write(`export default (config: any) => ({ name: "mine", optimize: async () => ({}) });`);
    const factory = await loadOptimizerModule(file);
    expect(typeof factory).toBe("function");
    const opt = factory({} as any);
    expect(opt.name).toBe("mine");
  });

  it("throws when there is no default export", async () => {
    const file = write(`export const notDefault = 1;`);
    await expect(loadOptimizerModule(file)).rejects.toThrow(/must default-export/);
  });

  it("throws when the default export is not a function", async () => {
    const file = write(`export default { name: "mine" };`);
    await expect(loadOptimizerModule(file)).rejects.toThrow(/must default-export a factory function/);
  });
});
```

- [ ] **Step 2: Run; expect failure.** Run: `pnpm test:run lib/optimize/optimizerModule.test.ts 2>&1 | tee /tmp/t2.log`

- [ ] **Step 3: Implement** (copy the esbuild/import scaffold from `gradingModule.ts`):

```ts
// lib/optimize/optimizerModule.ts
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

import { build } from "esbuild";

import type { OptimizerFactory } from "./optimizer.js";

let counter = 0;

/**
 * Load a user-authored TypeScript optimizer module and return its factory.
 * Transpiles with esbuild (leaving `agency-lang` external so the user's
 * `import { BaseOptimizer } from "agency-lang/optimize"` resolves to the
 * installed package), writes the bundle next to the source so Node finds the
 * project's node_modules, and returns the default-exported factory.
 */
export async function loadOptimizerModule(filePath: string): Promise<OptimizerFactory> {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Optimizer module not found: ${absolute}`);
  }
  counter += 1;
  const out = path.join(path.dirname(absolute), `.agency-optimizer-${process.pid}-${counter}.mjs`);
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
    // eslint-disable-next-line no-restricted-syntax -- CLI-layer loading of a user artifact; the bundle path is only known at runtime
    const mod = await import(pathToFileURL(out).href);
    const factory = mod.default;
    if (factory === undefined) {
      throw new Error(`Optimizer module ${absolute} must default-export a factory function (config) => Optimizer.`);
    }
    if (typeof factory !== "function") {
      throw new Error(`Optimizer module ${absolute} must default-export a factory function, got ${typeof factory}.`);
    }
    return factory as OptimizerFactory;
  } finally {
    if (fs.existsSync(out)) fs.rmSync(out, { force: true });
  }
}
```

- [ ] **Step 4: Run + typecheck + lint** → PASS / 0 / clean.

Run: `pnpm test:run lib/optimize/optimizerModule.test.ts 2>&1 | tee /tmp/t2.log`; `npx tsc --noEmit`; `pnpm run lint:structure`

- [ ] **Step 5: Commit.** (msg: "Add loadOptimizerModule: esbuild-load a user TS optimizer file")

---

## Task 3: Resolve a name-or-path optimizer and wire it into the CLI

**Files:**
- Modify: `lib/config.ts` (`eval.optimize.optimizer?`)
- Modify: `lib/cli/eval/optimize.ts` (`resolveOptimizer`, settings, gepa check, report meta)
- Modify: `scripts/agency.ts` (`--optimizer` help text)
- Test: `lib/cli/eval/optimize.test.ts`

- [ ] **Step 1: Config schema.** In `lib/config.ts`, add `optimizer` to the `eval.optimize` type and the zod object:

```ts
// type:
optimize?: {
  goal?: string;
  graders?: string;
  optimizer?: string;                                   // built-in name or path to a .ts/.js module
  validation?: { inputs?: string; split?: number };
};
// zod (inside the optimize object):
optimizer: z.string().optional(),
```

- [ ] **Step 2: Write the failing tests** in `lib/cli/eval/optimize.test.ts`.

```ts
// loads a custom optimizer from a path (uses the real esbuild loader → must resolve agency-lang/optimize,
// so write the module inside the package, like the grader-module test).
it("loads a custom optimizer from a --optimizer path", async () => {
  const agentFile = writeAgent();
  const inputsFile = writeInputs([{ id: "a", goal: "g", args: {} }]);
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".test-optimizer-"));
  try {
    const optFile = path.join(dir, "opt.ts");
    fs.writeFileSync(optFile, `export default (config) => ({ name: "mine", optimize: async () => ({ runId: config.runId, runDir: "", championIter: "baseline", championFiles: {}, acceptedCount: 0, rejectedCount: 0, validationFailedCount: 0, iterations: [] }) });`);
    const { name } = await capture({ agent: `${agentFile}:main`, inputs: inputsFile, optimizer: optFile });
    expect(name).toBe("mine");   // captured from the loaded optimizer's .name
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("still resolves a built-in optimizer by name", async () => {
  const agentFile = writeAgent();
  const { name } = await capture({ agent: agentFile, goal: "g", optimizer: "gepa" });
  expect(name).toBe("gepa");
});
```

(The existing `capture` helper records the optimizer the run used. For the path case, `name` is the loaded optimizer's `.name`; see Step 4 — the captured value should be `optimizer.name`. If `capture` currently records the *factory-call name*, adjust it to read `optimizer.name`.)

> **Implementer note:** the existing `capture` test helper injects `deps.getOptimizer` and records the `name` argument. `resolveOptimizer` calls `deps.getOptimizer` only for the **name** branch; for the **path** branch it goes through `loadOptimizerModule` and `deps.getOptimizer` is never called. So the path test must assert on the optimizer actually returned, not on a `getOptimizer` capture. Have `capture` also record `captured.optimizerName = (the resolved optimizer).name` — see Step 4 where `evalOptimize` already holds the resolved `optimizer`.

- [ ] **Step 3: Run; expect failure.** Run: `pnpm test:run lib/cli/eval/optimize.test.ts 2>&1 | tee /tmp/t3.log`

- [ ] **Step 4: Implement `resolveOptimizer` + wire it in `lib/cli/eval/optimize.ts`.**

Add `optimizer` to `resolveOptimizeSettings`:
```ts
    optimizer: opts.optimizer ?? cfg?.optimizer,
```

Add the resolver + a path test:
```ts
import { loadOptimizerModule } from "@/optimize/optimizerModule.js";
import type { Optimizer } from "@/optimize/optimizer.js";

/** A built-in name vs a path to a TS/JS module. */
function looksLikePath(ref: string): boolean {
  return /[\\/]/.test(ref) || ref.endsWith(".ts") || ref.endsWith(".js") || ref.endsWith(".mjs");
}

/** Resolve `--optimizer` to an Optimizer: a path loads a user module, a bare name
 *  uses the built-in registry. The result is used structurally ({ name, optimize }). */
async function resolveOptimizer(ref: string, config: BaseOptimizerConfig, deps: EvalOptimizeDeps): Promise<Optimizer> {
  if (!looksLikePath(ref)) return (deps.getOptimizer ?? getOptimizer)(ref, config);
  const factory = await loadOptimizerModule(ref);
  const optimizer = factory(config);
  if (!optimizer || typeof optimizer.optimize !== "function" || typeof optimizer.name !== "string") {
    throw new Error(`Optimizer module ${ref} must default-export (config) => Optimizer ({ name, optimize }).`);
  }
  return optimizer;
}
```

In `evalOptimize`, replace the resolve call:
```ts
  const optimizerRef = opts.optimizer ?? opts.config?.eval?.optimize?.optimizer ?? DEFAULT_OPTIMIZER;
  const optimizer = await resolveOptimizer(optimizerRef, config, deps);
  const result = await optimizer.optimize(target);
```
(Delete the old `const resolve = deps.getOptimizer ?? getOptimizer; const optimizer = resolve(opts.optimizer ?? DEFAULT_OPTIMIZER, config);`.)

In the same `if (result.runDir)` block, use the **resolved** optimizer's name for the report (works for both names and paths):
```ts
    const ignoresValidation = optimizer.name !== "greedy";
    writeReport(result.runDir, result, {
      optimizer: optimizer.name,
      graders: config.graders.map((g) => g.name()),
      trainObjective: result.trainObjective,
      validationObjective: result.validationObjective,
      validationConfiguredButUnused: ignoresValidation && (target.validationInputs?.length ?? 0) > 0,
    });
```

In `buildConfig`, the gepa-minibatch branch must read the resolved settings name (so `eval.optimize.optimizer: "gepa"` also works), not just `opts.optimizer`:
```ts
  if (s.optimizer === "gepa") return { ...base, minibatch: opts.minibatch ?? DEFAULT_MINIBATCH } as BaseOptimizerConfig;
```
(`s` is the `resolveOptimizeSettings(opts)` already computed in `buildConfig`.)

- [ ] **Step 4b: Make `capture` record the resolved optimizer name.** In `optimize.test.ts`'s `capture`, the fake `getOptimizer` records the name for the *name* branch; additionally capture the path-branch result. The simplest robust approach: have `capture` read the optimizer the run actually used. Since `evalOptimize` doesn't expose it, capture it via the fake for names and, for paths, assert on `result`/a spy. Concretely: keep the `getOptimizer` fake recording `captured.name` for names; for the path test, the loaded optimizer's `optimize` returns a result whose shape you assert, or record `captured.name` by having the test's exported factory set a detectable name and asserting via the run result. **Pin this down when implementing** — the goal is to assert the path optimizer ran. (Recommended: give the resolved `Optimizer` a unique `name` and have the test's fake `optimize` push it to a captured array.)

- [ ] **Step 5: CLI help text.** In `scripts/agency.ts`, update the `--optimizer` option description:
```ts
    .option("--optimizer <nameOrPath>", "Optimization strategy: a built-in name (greedy, gepa, example) or a path to a .ts module")
```

- [ ] **Step 6: Run + typecheck + lint.**

Run: `pnpm test:run lib/cli/eval/optimize.test.ts 2>&1 | tee /tmp/t3.log` → PASS
Run: `npx tsc --noEmit` → 0; `pnpm run lint:structure`

- [ ] **Step 7: Manual smoke (optional, no LLM).** Write a trivial optimizer module in the package that returns a baseline result; `pnpm run build` then `pnpm run agency optimize foo.agency --inputs inputs.json --optimizer ./thatModule.ts` and confirm it runs. Delete the scratch file.

- [ ] **Step 8: Commit.** (msg: "Resolve --optimizer as a built-in name or a path to a user optimizer module")

---

## Task 4: Docs

**Files:**
- Modify: `docs/site/cli/optimize.md`, `docs/dev/writing-optimizers.md`

- [ ] **Step 1: User docs.** In `docs/site/cli/optimize.md` "Writing your own optimizer", document that `--optimizer` accepts a path (or `eval.optimize.optimizer`), and the **factory default-export** convention, with an example:

```ts
// myOptimizer.ts
import { BaseOptimizer, fileMap, type BaseOptimizerConfig, type Input, type OptimizeResult, type OptimizeTargetSet } from "agency-lang/optimize";

class MyOptimizer extends BaseOptimizer {
  readonly name = "mine";
  protected async optimizeTargets(source: OptimizeTargetSet, inputs: Input[]): Promise<OptimizeResult> {
    // ... use this.scoreFiles / this.proposeValidMutation / this.evaluate ...
  }
}
export default (config: BaseOptimizerConfig) => new MyOptimizer(config);
```
```bash
agency optimize foo.agency --inputs inputs.json --optimizer ./myOptimizer.ts
```

- [ ] **Step 2: Dev guide.** In `docs/dev/writing-optimizers.md`, update the "Writing your own optimizer" / registration section: two ways to use one — (a) **register a built-in** (`registerOptimizer(name, factory)` in `registry.ts`, in-repo), or (b) **a path module** that default-exports the factory, loaded via `--optimizer ./file.ts` (no repo changes). Note the authoring imports come from `agency-lang/optimize`, and that the loaded optimizer is used structurally (so it works across realms; no `instanceof`).

- [ ] **Step 3: Commit.** (msg: "Document user-pluggable optimizers (path loader + factory convention)")

---

## Self-Review

**1. Spec coverage:** export surface (Task 1); esbuild loader (Task 2); name-or-path resolution + config + flag + report-name (Task 3); docs (Task 4). ✓

**2. Placeholder scan:** code shown for each step. The one soft spot is the `capture` test-helper adaptation (Task 3 Step 4b) — flagged explicitly with a recommended approach rather than left vague, because how `capture` records the resolved optimizer depends on the current helper shape; pin it when implementing.

**3. Type consistency:** `loadOptimizerModule(filePath): Promise<OptimizerFactory>`; `resolveOptimizer(ref, config, deps): Promise<Optimizer>`; `looksLikePath(ref)`; `resolveOptimizeSettings` gains `optimizer`; `OptimizerFactory = (config: BaseOptimizerConfig) => Optimizer` (from `optimizer.js`); report meta uses `optimizer.name`. ✓

**4. Parallels to custom graders (anti-duplication):** `loadOptimizerModule` reuses the `loadGradingModule` esbuild scaffold (same externalization + temp-file + dynamic-import + eslint exception); `resolveOptimizer` mirrors `buildConfig`'s graders-path-vs-default; the loaded optimizer is validated **structurally** like the grader pipeline treats graders. ✓

## Out of scope / follow-ups

- No `--optimizer` package specifier (`pkg::…`) support — only local paths + built-in names.
- No custom **config** plumbing for user optimizers beyond `BaseOptimizerConfig` (a custom optimizer needing its own knobs reads them off `config.config`, like gepa casts for `minibatch`). If common, a typed extension point is a later follow-up.
