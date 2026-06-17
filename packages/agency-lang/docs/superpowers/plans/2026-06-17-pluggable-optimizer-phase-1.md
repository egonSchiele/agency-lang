# Pluggable Optimizer Framework — Phase 1 (Extract the Seam) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a pluggable `Optimizer` seam and registry, re-home the existing PR #283 optimize loop as a `greedy` optimizer, and let `agency eval optimize --optimizer <name>` select a strategy — all with **zero behavior change** to today's default run.

**Architecture:** Define a small `Optimizer` type whose shape matches today's `OptimizeLoopConfig`/`OptimizeResult`. Wrap the existing `optimizeLoop()` in a `GreedyReflective` class that delegates to it verbatim (its pairwise judge stays internal). A module-level registry maps optimizer names to factories. The CLI resolves the optimizer by name (default `greedy`) and calls it instead of calling `optimizeLoop()` directly. No graders, `Scorecard`, `WorkspaceManager`, or pointwise scoring yet — those are Phase 2+.

**Tech Stack:** TypeScript (ESM, `@/` path alias), Vitest, Commander (CLI in `scripts/agency.ts`).

**Source spec:** `docs/superpowers/specs/2026-06-17-pluggable-optimizer-framework-design.md` (see "Implementation phasing", phase 1).

---

## Before you start

- You are on `main`. Create a feature branch first:
  ```bash
  git checkout -b pluggable-optimizer-phase-1
  ```
- When you reach a commit step, append the repo's co-author trailer to the commit message
  (`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`).
- Phase 1 touches only TypeScript under `lib/` and `scripts/`. No `.agency` stdlib files change,
  so you do **not** need to run `make`. Vitest runs TypeScript directly.

## Scope (Phase 1 only)

**In scope:** the `Optimizer` type, the registry, `GreedyReflective`, CLI/Commander wiring.

**Explicitly out of scope (later phases):** `BaseGrader`/`Grade`/`Scorecard`, `WorkspaceManager`,
`AgencyRunner.structured`, `EvalCache`, `HumanGrader`, GEPA, and the pointwise-scoring migration.
The agency-callable entry point `lib/stdlib/agencyEval.ts` (`_optimize`) keeps calling
`optimizeLoop` directly in Phase 1 — do not change it.

## File Structure

- Create: `lib/optimize/optimizer.ts` — the `Optimizer` type and `OptimizerFactory` type. One responsibility: the strategy contract.
- Create: `lib/optimize/greedyReflective.ts` — the `GreedyReflective` class, delegating to `optimizeLoop`.
- Create: `lib/optimize/registry.ts` — `registerOptimizer` / `getOptimizer` / `listOptimizers` / `DEFAULT_OPTIMIZER`; registers `greedy`.
- Modify: `lib/cli/eval/optimize.ts` — add the `optimizer?` option and `getOptimizer?` dep, resolve from the registry.
- Modify: `scripts/agency.ts:354-387` — add the `--optimizer <name>` Commander flag.
- Test (create): `lib/optimize/greedyReflective.test.ts`
- Test (create): `lib/optimize/registry.test.ts`
- Test (modify): `lib/cli/eval/optimize.test.ts` — add optimizer-selection tests.

---

### Task 1: `Optimizer` type and `GreedyReflective` class

**Files:**
- Create: `lib/optimize/optimizer.ts`
- Create: `lib/optimize/greedyReflective.ts`
- Test: `lib/optimize/greedyReflective.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/optimize/greedyReflective.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./loop.js", () => ({ optimizeLoop: vi.fn() }));

import { optimizeLoop } from "./loop.js";
import { GreedyReflective } from "./greedyReflective.js";
import type { OptimizeLoopConfig, OptimizeResult } from "./types.js";

describe("GreedyReflective", () => {
  beforeEach(() => {
    vi.mocked(optimizeLoop).mockReset();
  });

  it("is named \"greedy\"", () => {
    expect(new GreedyReflective().name).toBe("greedy");
  });

  it("delegates optimize() to optimizeLoop and returns its result", async () => {
    const result = { runId: "r" } as OptimizeResult;
    vi.mocked(optimizeLoop).mockResolvedValue(result);
    const config = {} as OptimizeLoopConfig;
    const deps = {};

    const returned = await new GreedyReflective().optimize(config, deps);

    expect(optimizeLoop).toHaveBeenCalledWith(config, deps);
    expect(returned).toBe(result);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/optimize/greedyReflective.test.ts`
Expected: FAIL — cannot resolve `./greedyReflective.js` (module does not exist yet).

- [ ] **Step 3: Create `lib/optimize/optimizer.ts`**

```ts
import type { OptimizeLoopDeps } from "./loop.js";
import type { OptimizeLoopConfig, OptimizeResult } from "./types.js";

/**
 * A pluggable optimization strategy. Phase 1 keeps the contract shaped around the existing
 * OptimizeLoopConfig/OptimizeResult; later phases generalize it (graders, inputs) per
 * docs/superpowers/specs/2026-06-17-pluggable-optimizer-framework-design.md.
 */
export type Optimizer = {
  readonly name: string;
  optimize(config: OptimizeLoopConfig, deps?: OptimizeLoopDeps): Promise<OptimizeResult>;
};

export type OptimizerFactory = () => Optimizer;
```

- [ ] **Step 4: Create `lib/optimize/greedyReflective.ts`**

```ts
import { optimizeLoop, type OptimizeLoopDeps } from "./loop.js";
import type { Optimizer } from "./optimizer.js";
import type { OptimizeLoopConfig, OptimizeResult } from "./types.js";

/**
 * The PR #283 champion–challenger hill-climb, exposed as an Optimizer. Phase 1 delegates
 * verbatim to optimizeLoop (its pairwise judge stays internal) — zero behavior change.
 */
export class GreedyReflective implements Optimizer {
  readonly name = "greedy";

  optimize(config: OptimizeLoopConfig, deps: OptimizeLoopDeps = {}): Promise<OptimizeResult> {
    return optimizeLoop(config, deps);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test:run lib/optimize/greedyReflective.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/optimize/optimizer.ts lib/optimize/greedyReflective.ts lib/optimize/greedyReflective.test.ts
git commit -m "feat(optimize): add Optimizer seam and GreedyReflective wrapper"
```

---

### Task 2: Optimizer registry

**Files:**
- Create: `lib/optimize/registry.ts`
- Test: `lib/optimize/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/optimize/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPTIMIZER,
  getOptimizer,
  listOptimizers,
  registerOptimizer,
} from "./registry.js";
import type { OptimizeResult } from "./types.js";

describe("optimizer registry", () => {
  it("resolves the built-in greedy optimizer", () => {
    expect(getOptimizer("greedy").name).toBe("greedy");
  });

  it("defaults to greedy", () => {
    expect(DEFAULT_OPTIMIZER).toBe("greedy");
    expect(getOptimizer(DEFAULT_OPTIMIZER).name).toBe("greedy");
  });

  it("lists registered optimizers", () => {
    expect(listOptimizers()).toContain("greedy");
  });

  it("throws a helpful error naming the unknown optimizer and the available ones", () => {
    expect(() => getOptimizer("nope")).toThrow(/Unknown optimizer "nope".*greedy/);
  });

  it("registers and resolves a custom optimizer", () => {
    registerOptimizer("custom-test", () => ({
      name: "custom-test",
      optimize: async () => ({}) as OptimizeResult,
    }));
    expect(getOptimizer("custom-test").name).toBe("custom-test");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/optimize/registry.test.ts`
Expected: FAIL — cannot resolve `./registry.js`.

- [ ] **Step 3: Create `lib/optimize/registry.ts`**

```ts
import { GreedyReflective } from "./greedyReflective.js";
import type { Optimizer, OptimizerFactory } from "./optimizer.js";

export const DEFAULT_OPTIMIZER = "greedy";

const registry: Record<string, OptimizerFactory> = {};

export function registerOptimizer(name: string, factory: OptimizerFactory): void {
  registry[name] = factory;
}

export function listOptimizers(): string[] {
  return Object.keys(registry).sort();
}

export function getOptimizer(name: string): Optimizer {
  const factory = registry[name];
  if (!factory) {
    throw new Error(
      `Unknown optimizer "${name}". Available optimizers: ${listOptimizers().join(", ")}.`,
    );
  }
  return factory();
}

registerOptimizer("greedy", () => new GreedyReflective());
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run lib/optimize/registry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/optimize/registry.ts lib/optimize/registry.test.ts
git commit -m "feat(optimize): add optimizer registry with greedy default"
```

---

### Task 3: Wire the CLI to resolve the optimizer from the registry

**Files:**
- Modify: `lib/cli/eval/optimize.ts`
- Test: `lib/cli/eval/optimize.test.ts`

- [ ] **Step 1: Write the failing tests**

In `lib/cli/eval/optimize.test.ts`, add `vi` to the vitest import:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
```

Then add these two tests inside the `describe("eval optimize CLI", ...)` block (after the
existing `it(...)` blocks, before the closing `});`):

```ts
  it("resolves and runs the optimizer named by --optimizer", async () => {
    const agentFile = writeAgent();
    const sentinel = { runId: "sentinel" } as OptimizeResult;
    const optimizeSpy = vi.fn(async () => sentinel);
    let requestedName: string | undefined;

    const result = await evalOptimize(
      { agent: agentFile, goal: "g", optimizer: "fake", silent: true, config: {} },
      {
        getOptimizer: (name) => {
          requestedName = name;
          return { name, optimize: optimizeSpy };
        },
      },
    );

    expect(requestedName).toBe("fake");
    expect(optimizeSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(sentinel);
  });

  it("defaults to the greedy optimizer when --optimizer is omitted", async () => {
    const agentFile = writeAgent();
    let requestedName: string | undefined;

    await evalOptimize(
      { agent: agentFile, goal: "g", silent: true, config: {} },
      {
        getOptimizer: (name) => {
          requestedName = name;
          return { name, optimize: async () => ({}) as OptimizeResult };
        },
      },
    );

    expect(requestedName).toBe("greedy");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:run lib/cli/eval/optimize.test.ts`
Expected: FAIL — `optimizer` and `getOptimizer` are not valid properties of the options/deps
types (TypeScript error), and the calls don't behave as asserted.

- [ ] **Step 3: Add the imports and types in `lib/cli/eval/optimize.ts`**

Add these imports alongside the existing `@/optimize/...` imports near the top:

```ts
import { DEFAULT_OPTIMIZER, getOptimizer } from "@/optimize/registry.js";
import type { Optimizer } from "@/optimize/optimizer.js";
```

Add `optimizer?: string;` to `EvalOptimizeOptions` (after `mutatorModel?: string;`):

```ts
export type EvalOptimizeOptions = {
  agent: string;
  tasks?: string;
  goal?: string;
  iterations?: number;
  samples?: number;
  confidenceThreshold?: number;
  marginThreshold?: number;
  writeback?: boolean;
  silent?: boolean;
  runsDir?: string;
  runId?: string;
  mutatorModel?: string;
  optimizer?: string;
  config?: AgencyConfig;
};
```

Add `getOptimizer?` to `EvalOptimizeDeps`:

```ts
export type EvalOptimizeDeps = {
  optimizeLoop?: (config: OptimizeLoopConfig) => Promise<OptimizeResult>;
  getOptimizer?: (name: string) => Optimizer;
  makeId?: () => string;
  makeRunId?: () => string;
};
```

- [ ] **Step 4: Resolve the optimizer in `evalOptimize`**

Replace the body of the `runInBootstrapFrame` callback (the `try { ... } finally { ... }` block)
with:

```ts
    getRuntimeContext().ctx.pushHandler(async () => approve());
    try {
      if (deps.optimizeLoop) return await deps.optimizeLoop(config);
      const resolve = deps.getOptimizer ?? getOptimizer;
      const optimizer = resolve(opts.optimizer ?? DEFAULT_OPTIMIZER);
      return await optimizer.optimize(config, { reporter: createOptimizeReporter(verbosity) });
    } finally {
      getRuntimeContext().ctx.popHandler();
    }
```

Note: the `deps.optimizeLoop` short-circuit is kept so existing tests (and the
characterization of the old path) are untouched. When no deps are supplied, the default
production path is now `getOptimizer("greedy") → GreedyReflective → optimizeLoop(config,
{ reporter })`, which is functionally identical to the previous direct call.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:run lib/cli/eval/optimize.test.ts`
Expected: PASS — all existing tests plus the two new ones.

- [ ] **Step 6: Commit**

```bash
git add lib/cli/eval/optimize.ts lib/cli/eval/optimize.test.ts
git commit -m "feat(optimize): resolve the optimizer by name in the eval optimize CLI"
```

---

### Task 4: Add the `--optimizer` Commander flag

**Files:**
- Modify: `scripts/agency.ts:354-387`

- [ ] **Step 1: Add the option**

In the `evalCmd.command("optimize")` chain, add the `--optimizer` option directly after the
`.option("--mutator-model <model>", ...)` line (around line 364):

```ts
    .option("--optimizer <name>", "Optimization strategy to use (default: greedy)")
```

- [ ] **Step 2: Add the option to the action's opts type**

In the `.action(async (agent: string, opts: { ... })` type literal (around lines 369-381), add
`optimizer?: string;` after `mutatorModel?: string;`:

```ts
      mutatorModel?: string;
      optimizer?: string;
      samples?: number;
```

The existing `evalOptimize({ ...opts, agent, config: getConfig() })` call already forwards
`optimizer` because it spreads `opts`. No change needed there.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no errors). This confirms the new option threads through the option/deps types.

- [ ] **Step 4: Commit**

```bash
git add scripts/agency.ts
git commit -m "feat(cli): add --optimizer flag to eval optimize"
```

---

### Task 5: Whole-phase verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full optimizer + CLI test surface**

Run: `pnpm test:run lib/optimize lib/cli/eval/optimize.test.ts`
Expected: PASS. In particular, the pre-existing `lib/optimize/loop.test.ts` and the original
`lib/cli/eval/optimize.test.ts` assertions stay green — that is the "zero behavior change"
evidence.

- [ ] **Step 2: Typecheck the project**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Structural lint**

Run: `pnpm run lint:structure`
Expected: PASS (no new violations in the files you added/changed).

- [ ] **Step 4 (optional smoke test, requires a build): confirm the CLI flag is wired**

The `agency` script runs the compiled `dist/`, so this needs a build first:

```bash
pnpm run build
pnpm run agency eval optimize --help
```

Expected: the help output lists `--optimizer <name>`.

- [ ] **Step 5: Commit (only if Step 3/4 required a fix)**

```bash
git add -A
git commit -m "chore(optimize): phase 1 verification fixes"
```

---

## Self-Review (completed during planning)

- **Spec coverage (phase 1 of the spec's phasing):** "Introduce `BaseOptimizer` + registry" →
  Tasks 1–2 (the Phase-1 contract is the minimal `Optimizer` type, not the full generic
  `BaseOptimizer<C>`, which arrives with graders in Phase 2; this is called out in Scope).
  "Re-home the PR #283 loop as `greedy`, keeping its pairwise `judgeSuite` internally (zero
  behavior change)" → Task 1 (`GreedyReflective` delegates verbatim) + Task 5 Step 1
  (regression evidence). CLI strategy selection (`--optimizer`, default `greedy`) → Tasks 3–4.
  Phases 2–5 are intentionally not covered here (separate plans).
- **Placeholder scan:** none — every code and command step contains literal content.
- **Type consistency:** `Optimizer.optimize(config, deps?)` is defined once in `optimizer.ts`
  and matched by `GreedyReflective.optimize` (Task 1), the registry's `OptimizerFactory`
  (Task 2), and the CLI `getOptimizer?` dep + call site (Task 3). `DEFAULT_OPTIMIZER` /
  `getOptimizer` names are identical across `registry.ts` and its import in `optimize.ts`. The
  `name` property is `"greedy"` consistently.

## Follow-on plans (not part of this plan)

Each subsequent spec phase gets its own plan, executed in order because each builds on the
prior:

1. **Phase 2:** `BaseGrader`/`Grade`/`Score`/`Scorecard` + built-in graders + `EvalCache`;
   migrate `greedy` to pointwise scoring (the behavior change, isolated here and validated
   against the PR #283 fixtures).
2. **Phase 3:** `WorkspaceManager` + `AgencyRunner.structured` formalized as services.
3. **Phase 4:** `HumanGrader` + harness human-input capability (terminal prompt; CI fail-fast).
4. **Phase 5:** GEPA (`CandidatePool`, `ParetoFrontier`, reflective proposer `.agency` file).
