# Pluggable Optimizer Framework — Phase 3 (Agent-Running Infra + Pointwise Greedy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the grading foundation runnable: add general-purpose agent-running services (`AgencyRunner`, `WorkspaceManager`, `EvalCache`) and an `LlmJudge` grader (Milestone 3A, additive); then introduce `BaseOptimizer` (whose `evaluate()` method runs the agent per input and grades it into a `Scorecard`) and migrate `greedy` from pairwise judging to pointwise grading (Milestone 3B, the deferred behavior change).

**Architecture:** First decouple the general "run an `.agency` node" path from the test-LLM harness inside `lib/cli/util.ts`. `AgencyRunner` (a class) wraps that clean core to run the agent under test and to run zod-validated judge/proposer agents. `WorkspaceManager` owns per-iteration workspace dirs; `EvalCache` memoizes one run per (workspace, input). The pointwise evaluation pipeline lives **on the optimizer** as `BaseOptimizer.evaluate()`. Greedy becomes: fork champion → propose mutation → apply → `evaluate` → accept iff gates pass and objective improves.

**Tech Stack:** TypeScript (ESM, `@/` alias), Vitest.

**Source spec:** `docs/superpowers/specs/2026-06-17-pluggable-optimizer-framework-design.md`. **Builds on:** Phase 1 (`lib/optimize/{optimizer,registry,greedyReflective}.ts`) and Phase 2 (`lib/optimize/grading/`), both merged.

---

## Milestone split (each milestone = one PR)

- **3A — Infra (additive, zero behavior change):** Tasks 1–7. Refactor the runner, add `AgencyRunner`/`WorkspaceManager`/`EvalCache`/`LlmJudge`, extend `GraderInput`. Greedy still uses the Phase 1 pairwise path. PR "Phase 3A".
- **3B — Optimizer + greedy migration (behavior change):** Tasks 8–12. `BaseOptimizer` with the pointwise `evaluate()` method, greedy rewrite, registry/CLI evolution, fixture validation. PR "Phase 3B".

Execute and merge 3A before starting 3B.

## Verified integration points (current `main`)

- `lib/cli/util.ts:executeNodeAsync` — compiles/resolves an agent, renders an evaluate script via `renderEvaluate`, spawns `node`, and reads `<base>.evaluate.json` → `{ data, stdout, stderr }`. It also computes the deterministic-LLM env (`AGENCY_USE_TEST_LLM_PROVIDER` / `useTestLLMProvider` → `AGENCY_LLM_MOCKS`). **Task 1 splits these two responsibilities.**
- `discoverOptimizeTargets(agentFile): OptimizeTargetSet` (`lib/optimize/targets.js`) — `entryFile`, `baseDir`, `files`, `targets`.
- `new OptimizeSourceMutator({ targetSet }).preview(operations): { files, targetSet, changes, diagnostics }` (`lib/optimize/sourceMutator.js`).
- `proposeMutation(args): Promise<MutationProposal>` (`lib/optimize/mutator.js`) — the existing reflective mutator (used by greedy).
- Phase 2 grading types/classes in `lib/optimize/grading/` (`JSON`, `Input`, `AgentRun`, `Grade`, `GraderInput`, `BaseGrader`, `Scorecard`).

## Before you start

- Fresh worktree from updated `main` (`superpowers:using-git-worktrees`); then `pnpm install && pnpm run build && pnpm run agency compile stdlib/` once (so `pnpm typecheck` and agent-executing tests resolve `stdlib/index.js`).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Single test file: `pnpm test:run <path>`.

---

# Milestone 3A — Infra

### Task 1: Decouple the general agency-node runner from the test-LLM harness

**Files:**
- Modify: `lib/cli/util.ts`
- Test: `lib/cli/util.test.ts` (create if absent; otherwise append)

- [ ] **Step 1: Write the failing test** (a general run with no test-LLM env, plus the wrapper still injecting mocks). Uses a tiny constant-returning agent fixture, so it needs the built stdlib (run the build from "Before you start").

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgencyNode } from "./util.js";

describe("runAgencyNode", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-node-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("runs a node and returns its value as data, with no test-LLM env required", async () => {
    const agent = path.join(dir, "const.agency");
    fs.writeFileSync(agent, "node main() {\n  return 42\n}\n");
    const { data } = await runAgencyNode({
      config: {}, agencyFile: agent, nodeName: "main", hasArgs: false, argsString: "", scratchDir: dir, quietCompile: true,
    });
    expect(data).toBe(42);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:run lib/cli/util.test.ts`
Expected: FAIL — `runAgencyNode` is not exported.

- [ ] **Step 3: Refactor `lib/cli/util.ts`.** Extract the general core and make `executeNodeAsync` a thin wrapper. The core keeps everything **except** the deterministic-LLM env computation, and accepts an `env` override:

```ts
export type RunAgencyNodeArgs = {
  config: AgencyConfig;
  agencyFile: string;
  nodeName: string;
  hasArgs: boolean;
  argsString: string;
  interruptHandlers?: InterruptHandler[];
  timeoutMs?: number;
  signal?: AbortSignal;
  argv?: string[];
  scratchDir?: string;
  maxBufferBytes?: number;
  quietCompile?: boolean;
  /** Extra env merged over process.env for the spawned subprocess. */
  env?: Record<string, string>;
};

/** General-purpose: compile/resolve, render the evaluate script, spawn node, parse results. */
export async function runAgencyNode(args: RunAgencyNodeArgs): Promise<{ data: any; stdout: string; stderr: string }> {
  // (Move the current body of executeNodeAsync here UNCHANGED, except:
  //  - delete the `useDeterministic`/`mocksEnv` block, and
  //  - set `env: { ...process.env, ...(args.env ?? {}) }` in the execFileAsync call.)
}

/** Test/eval wrapper: adds the deterministic-LLM provider env, then delegates to runAgencyNode. */
export async function executeNodeAsync({
  llmMocks, useTestLLMProvider, ...rest
}: ExecuteNodeArgs): Promise<{ data: any; stdout: string; stderr: string }> {
  const useDeterministic = !!process.env.AGENCY_USE_TEST_LLM_PROVIDER || !!useTestLLMProvider;
  const env = useDeterministic ? { AGENCY_LLM_MOCKS: JSON.stringify(llmMocks ?? []) } : {};
  return runAgencyNode({ ...rest, env });
}
```

Keep `ExecuteNodeArgs` (with `llmMocks`/`useTestLLMProvider`) for existing callers. `interruptHandlers`, `timeoutMs`, `signal`, `argv` move into `RunAgencyNodeArgs` as general options. (The sync `executeNode` may keep its current body for now; this task only refactors the async path that `AgencyRunner` uses.)

- [ ] **Step 4: Run the new test and the regression surface**

Run: `pnpm test:run lib/cli/util.test.ts`
Expected: PASS.
Run: `pnpm test:run lib/optimize/mutator.test.ts lib/cli/eval`
Expected: PASS — `executeNodeAsync`'s observable behavior is unchanged (it now computes the same env and delegates).

- [ ] **Step 5: Commit**

```bash
git add lib/cli/util.ts lib/cli/util.test.ts
git commit -m "refactor(cli): extract general runAgencyNode core from executeNodeAsync"
```

---

### Task 2: `AgencyRunner` (class)

**Files:**
- Create: `lib/optimize/grading/agencyRunner.ts`
- Test: `lib/optimize/grading/agencyRunner.test.ts`

- [ ] **Step 1: Write the failing test** (inject a fake node-runner — no real execution):

```ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AgencyRunner, type NodeRunner } from "./agencyRunner.js";

const fakeRunner = (data: unknown): NodeRunner => vi.fn(async () => ({ data, stdout: "", stderr: "" }));

describe("AgencyRunner", () => {
  it("run() returns the node's raw value", async () => {
    const runner = new AgencyRunner({}, fakeRunner("New Delhi"));
    expect(await runner.run("./agent.agency", "main", { country: "India" })).toBe("New Delhi");
  });

  it("runStructured() validates the return against a schema", async () => {
    const runner = new AgencyRunner({}, fakeRunner({ score: 0.5, reasoning: "ok" }));
    const schema = z.object({ score: z.number(), reasoning: z.string() });
    expect(await runner.runStructured("./judge.agency", "main", {}, schema)).toEqual({ score: 0.5, reasoning: "ok" });
  });

  it("runStructured() throws a clear error on a schema mismatch", async () => {
    const runner = new AgencyRunner({}, fakeRunner({ score: "nope" }));
    await expect(runner.runStructured("./judge.agency", "main", {}, z.object({ score: z.number() }))).rejects.toThrow(/judge\.agency.*schema/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:run lib/optimize/grading/agencyRunner.test.ts`
Expected: FAIL — cannot resolve `./agencyRunner.js`.

- [ ] **Step 3: Implement**

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { ZodSchema } from "zod";

import { runAgencyNode } from "@/cli/util.js";
import type { AgencyConfig } from "@/config.js";

import type { JSON } from "./types.js";

/** Seam over runAgencyNode so callers/tests can inject a fake. */
export type NodeRunner = (args: {
  config: AgencyConfig; agencyFile: string; nodeName: string; hasArgs: boolean; argsString: string; scratchDir: string; quietCompile: boolean;
}) => Promise<{ data: unknown }>;

const defaultRunner: NodeRunner = (args) => runAgencyNode(args);

/** Runs .agency nodes for the optimizer: the agent under test (`run`) and judge/proposer agents (`runStructured`). */
export class AgencyRunner {
  constructor(private readonly config: AgencyConfig, private readonly runNode: NodeRunner = defaultRunner) {}

  /** Run an agent node and return its raw value. */
  async run(agencyFile: string, nodeName: string, args: Record<string, JSON>): Promise<JSON> {
    const { data } = await this.exec(agencyFile, nodeName, args);
    return data as JSON;
  }

  /** Run a judge/proposer node and validate its structured return. */
  async runStructured<T>(agencyFile: string, nodeName: string, args: Record<string, JSON>, schema: ZodSchema<T>): Promise<T> {
    const { data } = await this.exec(agencyFile, nodeName, args);
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${agencyFile}: structured return failed schema validation: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  private async exec(agencyFile: string, nodeName: string, args: Record<string, JSON>): Promise<{ data: unknown }> {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-runner-"));
    try {
      const config = { ...this.config };
      delete config.distDir;
      const argsString = Object.values(args).map((v) => globalThis.JSON.stringify(v)).join(", ");
      return await this.runNode({ config, agencyFile, nodeName, hasArgs: argsString.length > 0, argsString, scratchDir, quietCompile: true });
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:run lib/optimize/grading/agencyRunner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/optimize/grading/agencyRunner.ts lib/optimize/grading/agencyRunner.test.ts
git commit -m "feat(optimize): add AgencyRunner class (run + zod-validated runStructured)"
```

---

### Task 3: Extend `GraderInput` with `runAgency`

**Files:**
- Modify: `lib/optimize/grading/types.ts`
- Modify: `lib/optimize/grading/{baseGrader,builtinGraders}.test.ts` (helper objects gain the field)

- [ ] **Step 1: Edit the type.** Add an import block at the top of `types.ts` and extend `GraderInput`:

```ts
import type { AgencyRunner } from "./agencyRunner.js";

export type GraderInput = {
  input: Input;
  run: AgentRun;
  runAgency: AgencyRunner;   // capability to invoke a judge .agency file
};
```

- [ ] **Step 2: Update the `gi(...)` helpers** in `baseGrader.test.ts` and `builtinGraders.test.ts` to include a stub runner:

```ts
import { AgencyRunner } from "./agencyRunner.js";
const stubRunner = new AgencyRunner({}, async () => ({ data: null }));
// in each gi(): return { input, run: { output, recordPath: "" }, runAgency: stubRunner };
```

- [ ] **Step 3: Typecheck + run the Phase 2 grader tests**

Run: `pnpm typecheck` then `pnpm test:run lib/optimize/grading`
Expected: PASS (deterministic graders ignore `runAgency`; only the literals gained a field).

- [ ] **Step 4: Commit**

```bash
git add lib/optimize/grading/types.ts lib/optimize/grading/baseGrader.test.ts lib/optimize/grading/builtinGraders.test.ts
git commit -m "feat(optimize): add runAgency capability to GraderInput"
```

---

### Task 4: `LlmJudge` grader

**Files:**
- Create: `lib/optimize/grading/llmJudge.ts`
- Test: `lib/optimize/grading/llmJudge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { AgencyRunner } from "./agencyRunner.js";
import { LlmJudge } from "./llmJudge.js";
import type { GraderInput, Input } from "./types.js";

const gi = (verdict: { score?: number; pass?: boolean; reasoning: string }): GraderInput => {
  const input: Input = { id: "i1", args: {}, metadata: { goal: "Return the capital" } };
  return { input, run: { output: "New Delhi", recordPath: "" }, runAgency: new AgencyRunner({}, async () => ({ data: verdict })) };
};

describe("LlmJudge", () => {
  it("maps a scalar verdict to a scalar grade with feedback", async () => {
    const judge = new LlmJudge({ name: "quality", agencyFile: "./quality.agency" });
    const grade = await judge.run(gi({ score: 0.9, reasoning: "good" }));
    expect(grade.score).toEqual({ kind: "scalar", value: 0.9 });
    expect(grade.feedback).toBe("good");
  });

  it("maps a binary verdict to a binary grade", async () => {
    const judge = new LlmJudge({ name: "no-any", agencyFile: "./no-any.agency", binary: true });
    const grade = await judge.run(gi({ pass: false, reasoning: "uses any" }));
    expect(grade.score).toEqual({ kind: "binary", pass: false });
    expect(grade.feedback).toBe("uses any");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:run lib/optimize/grading/llmJudge.test.ts`
Expected: FAIL — cannot resolve `./llmJudge.js`.

- [ ] **Step 3: Implement**

```ts
import { z } from "zod";

import { BaseGrader } from "./baseGrader.js";
import { getPath } from "./getPath.js";
import type { Grade, GraderInput, GraderOptions, JSONPath } from "./types.js";

type LlmJudgeOptions = GraderOptions & {
  agencyFile: string;   // judge .agency file
  goalPath?: JSONPath;  // where to read the goal from the input (default ["metadata","goal"])
  binary?: boolean;     // expect pass/fail instead of a 0..1 score
  node?: string;        // judge node (default "main")
};

const ScalarVerdict = z.object({ score: z.number(), reasoning: z.string() });
const BinaryVerdict = z.object({ pass: z.boolean(), reasoning: z.string() });

export class LlmJudge extends BaseGrader {
  protected readonly defaultName = "llm-judge";
  constructor(protected readonly options: LlmJudgeOptions) {
    super(options);
  }

  protected async _run({ input, run, runAgency }: GraderInput): Promise<Grade> {
    const goal = String(getPath(input, this.options.goalPath ?? ["metadata", "goal"]) ?? "");
    const args = { goal, output: run.output };
    const node = this.options.node ?? "main";
    if (this.options.binary) {
      const v = await runAgency.runStructured(this.options.agencyFile, node, args, BinaryVerdict);
      return { score: { kind: "binary", pass: v.pass }, feedback: v.reasoning };
    }
    const v = await runAgency.runStructured(this.options.agencyFile, node, args, ScalarVerdict);
    return { score: { kind: "scalar", value: v.score }, feedback: v.reasoning };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:run lib/optimize/grading/llmJudge.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/optimize/grading/llmJudge.ts lib/optimize/grading/llmJudge.test.ts
git commit -m "feat(optimize): add LlmJudge grader (scalar or binary verdicts)"
```

---

### Task 5: `EvalCache`

**Files:**
- Create: `lib/optimize/evalCache.ts`
- Test: `lib/optimize/evalCache.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";

import { EvalCache } from "./evalCache.js";
import type { AgentRun } from "./grading/types.js";

describe("EvalCache", () => {
  it("computes each (workspace,input) once and reuses the result", async () => {
    const cache = new EvalCache();
    const produce = vi.fn(async (): Promise<AgentRun> => ({ output: "x", recordPath: "p" }));
    const a = await cache.get("ws1", "in1", produce);
    const b = await cache.get("ws1", "in1", produce);
    expect(a).toBe(b);
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("keys independently by workspace and input", async () => {
    const cache = new EvalCache();
    const produce = vi.fn(async (): Promise<AgentRun> => ({ output: "x", recordPath: "p" }));
    await cache.get("ws1", "in1", produce);
    await cache.get("ws2", "in1", produce);
    await cache.get("ws1", "in2", produce);
    expect(produce).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:run lib/optimize/evalCache.test.ts`
Expected: FAIL — cannot resolve `./evalCache.js`.

- [ ] **Step 3: Implement**

```ts
import type { AgentRun } from "./grading/types.js";

/** Memoizes one AgentRun per (workspaceKey, inputId). Null-prototype: keys derive from user inputs. */
export class EvalCache {
  private readonly runs: Record<string, Promise<AgentRun>> = Object.create(null);

  get(workspaceKey: string, inputId: string, produce: () => Promise<AgentRun>): Promise<AgentRun> {
    const key = `${workspaceKey} ${inputId}`;
    if (!Object.hasOwn(this.runs, key)) {
      this.runs[key] = produce();
    }
    return this.runs[key];
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:run lib/optimize/evalCache.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/optimize/evalCache.ts lib/optimize/evalCache.test.ts
git commit -m "feat(optimize): add EvalCache memoizing AgentRun per (workspace,input)"
```

---

### Task 6: `WorkspaceManager`

**Files:**
- Create: `lib/optimize/workspace.ts`
- Test: `lib/optimize/workspace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceManager } from "./workspace.js";

describe("WorkspaceManager", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "wsm-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("forks a source dir into an isolated copy; edits do not touch the source", () => {
    const src = path.join(root, "src");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "agent.agency"), "node main() {}\n");
    const wsm = new WorkspaceManager(path.join(root, "ws"));
    const ws = wsm.fork(src);
    expect(wsm.read(ws, "agent.agency")).toContain("node main()");
    wsm.write(ws, "agent.agency", "node main() { 1 }\n");
    expect(fs.readFileSync(path.join(src, "agent.agency"), "utf8")).not.toContain("{ 1 }");
  });

  it("applyFiles writes a file map into the workspace", () => {
    const src = path.join(root, "src"); fs.mkdirSync(src);
    const wsm = new WorkspaceManager(path.join(root, "ws"));
    const ws = wsm.fork(src);
    wsm.applyFiles(ws, { "a/b.agency": "node main() {}\n" });
    expect(wsm.read(ws, "a/b.agency")).toContain("node main()");
  });

  it("gives each fork a distinct key", () => {
    const src = path.join(root, "src"); fs.mkdirSync(src);
    const wsm = new WorkspaceManager(path.join(root, "ws"));
    expect(wsm.fork(src).key).not.toBe(wsm.fork(src).key);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:run lib/optimize/workspace.test.ts`
Expected: FAIL — cannot resolve `./workspace.js`.

- [ ] **Step 3: Implement**

```ts
import * as fs from "fs";
import * as path from "path";

export type Workspace = { dir: string; key: string };

/** Owns per-iteration workspace directories and resolves paths against them. */
export class WorkspaceManager {
  private counter = 0;
  constructor(private readonly rootDir: string) {}

  /** Copy `sourceDir` into a fresh workspace directory. */
  fork(sourceDir: string): Workspace {
    this.counter += 1;
    const key = `ws-${this.counter}`;
    const dir = path.join(this.rootDir, key);
    fs.cpSync(sourceDir, dir, { recursive: true });
    return { dir, key };
  }

  read(ws: Workspace, relPath: string): string {
    return fs.readFileSync(path.join(ws.dir, relPath), "utf8");
  }

  write(ws: Workspace, relPath: string, content: string): void {
    const abs = path.join(ws.dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  /** Materialize a file map (e.g. OptimizeSourceMutator.preview().files) into the workspace. */
  applyFiles(ws: Workspace, files: Record<string, string>): void {
    for (const [rel, source] of Object.entries(files)) this.write(ws, rel, source);
  }
}
```

Source-mutation *operations* are previewed by the existing `OptimizeSourceMutator` (which the optimizer holds), preserving the parse-budget invariant; `applyFiles` only writes the resulting file map.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:run lib/optimize/workspace.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/optimize/workspace.ts lib/optimize/workspace.test.ts
git commit -m "feat(optimize): add WorkspaceManager (fork/read/write/applyFiles)"
```

---

### Task 7: 3A close-out

- [ ] Run `pnpm test:run lib/optimize lib/cli/util.test.ts lib/cli/eval` — all green.
- [ ] `pnpm typecheck` and `pnpm run lint:structure` — clean.
- [ ] Confirm zero behavior change: `lib/cli/eval/optimize.test.ts` unchanged and green (greedy still pairwise).
- [ ] Open PR "Phase 3A — agent-running infra (additive)". Merge before 3B.

---

# Milestone 3B — `BaseOptimizer` + pointwise greedy (behavior change)

> Start after 3A merges. Changes greedy's acceptance from pairwise (`judgeSuite` winner) to
> pointwise (objective improves AND gates pass). `judgeSuite`/`eval judge` stay intact; only
> greedy stops using them.

## File Structure (3B)

- Modify: `lib/optimize/optimizer.ts` — target-based contract.
- Create: `lib/optimize/baseOptimizer.ts` — `BaseOptimizer<C>` with `evaluate()`, `runAgent()`, `propose()`, `eachIteration()`.
- Rewrite: `lib/optimize/greedyReflective.ts` — pointwise loop.
- Modify: `lib/optimize/registry.ts` — new factory signature.
- Modify: `lib/cli/eval/optimize.ts` + `scripts/agency.ts` — build `Input[]` + graders; desugar `--goal`/`--tasks`.
- Create: `lib/agents/goalJudge.agency` — bundled scalar goal judge.

### Task 8: Target-based `Optimizer` contract

**Files:** Modify `lib/optimize/optimizer.ts`; Test `lib/optimize/optimizer.test.ts` (type-level + a trivial impl).

- [ ] **Step 1:** Replace `optimizer.ts` contents:

```ts
import type { AgencyConfig } from "@/config.js";

import type { BaseGrader } from "./grading/baseGrader.js";
import type { Input } from "./grading/types.js";
import type { OptimizeResult } from "./types.js";

export type OptimizeTarget = { agent: string; inputs: Input[] };

export type BaseOptimizerConfig = {
  graders: BaseGrader[];
  iterations: number;
  seed?: number;
  config: AgencyConfig;
  runsDir: string;
  runId: string;
  writeback?: boolean;
};

export type Optimizer = { readonly name: string; optimize(target: OptimizeTarget): Promise<OptimizeResult> };
export type OptimizerFactory = (config: BaseOptimizerConfig) => Optimizer;
```

- [ ] **Step 2:** Write a tiny test asserting a literal object satisfies `Optimizer` (compile-time) and that `optimize` resolves:

```ts
import { describe, expect, it } from "vitest";
import type { Optimizer } from "./optimizer.js";
import type { OptimizeResult } from "./types.js";

describe("Optimizer contract", () => {
  it("is satisfied by a name + optimize(target)", async () => {
    const opt: Optimizer = { name: "noop", optimize: async () => ({}) as OptimizeResult };
    expect(opt.name).toBe("noop");
    expect(await opt.optimize({ agent: "a.agency", inputs: [] })).toBeDefined();
  });
});
```

- [ ] **Step 3:** Run `pnpm test:run lib/optimize/optimizer.test.ts` (PASS), then `pnpm typecheck` — it will FAIL in `registry.ts`/`greedyReflective.ts`/`optimize.ts` (old contract). That is expected; Tasks 9–11 fix those. Commit after Task 11 when typecheck is green again, or commit now with a note. Prefer: do Tasks 8–11 then commit together as the contract migration. (Skip the standalone commit here.)

### Task 9: `BaseOptimizer` with the pointwise `evaluate()`

**Files:** Create `lib/optimize/baseOptimizer.ts`; Test `lib/optimize/baseOptimizer.test.ts`.

- [ ] **Step 1: Write the failing test** (concrete subclass; inject a fake `AgencyRunner` + workspace; stub graders):

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgencyRunner } from "./grading/agencyRunner.js";
import { BaseGrader } from "./grading/baseGrader.js";
import { BaseOptimizer } from "./baseOptimizer.js";
import type { OptimizeTarget } from "./optimizer.js";
import type { Grade, GraderInput, GraderOptions } from "./grading/types.js";
import type { OptimizeResult } from "./types.js";

class FixedGrader extends BaseGrader {
  protected readonly defaultName = "fixed";
  constructor(private readonly grade: Grade, options: GraderOptions = {}) { super(options); }
  protected _run(_i: GraderInput): Promise<Grade> { return Promise.resolve(this.grade); }
}

// expose evaluate via a concrete subclass
class Probe extends BaseOptimizer {
  readonly name = "probe";
  async optimize(_t: OptimizeTarget): Promise<OptimizeResult> { return {} as OptimizeResult; }
  evaluatePublic = this.evaluate.bind(this);
}

describe("BaseOptimizer.evaluate", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "bo-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function probe(graders: BaseGrader[], runValue: unknown): Probe {
    const runner = new AgencyRunner({}, async () => ({ data: runValue }));
    return new Probe({
      graders, iterations: 1, config: {}, runsDir: root, runId: "r",
    }, { workspaceRoot: root, agencyRunner: runner });
  }

  it("runs the agent once per input and builds a gate-aware Scorecard", async () => {
    const p = probe([new FixedGrader({ score: { kind: "scalar", value: 0.5 } })], "out");
    const src = path.join(root, "src"); fs.mkdirSync(src); fs.writeFileSync(path.join(src, "agent.agency"), "node main(){}\n");
    const ws = p.fork(src);
    const sc = await p.evaluatePublic(ws, "agent.agency", [{ id: "a", args: {} }, { id: "b", args: {} }]);
    expect(sc.objective()).toBeCloseTo(0.5, 10);
    expect(sc.gatesPassed()).toBe(true);
  });

  it("short-circuits advisory graders when a gate fails for an input", async () => {
    const gate = new FixedGrader({ score: { kind: "binary", pass: false } }, { mustPass: true });
    const advisory = new FixedGrader({ score: { kind: "scalar", value: 1 } });
    const advisorySpy = vi.spyOn(advisory as unknown as { _run: () => Promise<Grade> }, "_run");
    const p = probe([gate, advisory], "out");
    const src = path.join(root, "src"); fs.mkdirSync(src); fs.writeFileSync(path.join(src, "agent.agency"), "node main(){}\n");
    const ws = p.fork(src);
    const sc = await p.evaluatePublic(ws, "agent.agency", [{ id: "a", args: {} }]);
    expect(sc.gatesPassed()).toBe(false);
    expect(advisorySpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:run lib/optimize/baseOptimizer.test.ts`
Expected: FAIL — cannot resolve `./baseOptimizer.js`.

- [ ] **Step 3: Implement** `lib/optimize/baseOptimizer.ts`:

```ts
import * as path from "path";

import { AgencyRunner } from "./grading/agencyRunner.js";
import type { BaseGrader } from "./grading/baseGrader.js";
import { Scorecard, type GraderGrade, type InputGrades } from "./grading/scorecard.js";
import type { AgentRun, Input } from "./grading/types.js";
import { EvalCache } from "./evalCache.js";
import type { BaseOptimizerConfig, OptimizeTarget } from "./optimizer.js";
import type { OptimizeResult } from "./types.js";
import { WorkspaceManager, type Workspace } from "./workspace.js";

export type BaseOptimizerDeps = { workspaceRoot?: string; agencyRunner?: AgencyRunner; cache?: EvalCache };

export abstract class BaseOptimizer {
  protected readonly workspace: WorkspaceManager;
  protected readonly agencyRunner: AgencyRunner;
  protected readonly cache: EvalCache;

  constructor(protected readonly config: BaseOptimizerConfig, deps: BaseOptimizerDeps = {}) {
    this.workspace = new WorkspaceManager(deps.workspaceRoot ?? path.join(config.runsDir, config.runId, "ws"));
    this.agencyRunner = deps.agencyRunner ?? new AgencyRunner(config.config);
    this.cache = deps.cache ?? new EvalCache();
  }

  abstract readonly name: string;
  abstract optimize(target: OptimizeTarget): Promise<OptimizeResult>;

  protected fork(sourceDir: string): Workspace {
    return this.workspace.fork(sourceDir);
  }

  /** Run the agent once per input (cached), grade each output, return a Scorecard. */
  protected async evaluate(ws: Workspace, entryFile: string, inputs: Input[]): Promise<Scorecard> {
    const perInput = await Promise.all(inputs.map((input) => this.gradeInput(ws, entryFile, input)));
    return new Scorecard(perInput);
  }

  private async gradeInput(ws: Workspace, entryFile: string, input: Input): Promise<InputGrades> {
    const run = await this.runAgent(ws, entryFile, input);
    const gates = this.config.graders.filter((g) => g.mustPass() && g.gradesInput(input));
    const advisory = this.config.graders.filter((g) => !g.mustPass() && g.gradesInput(input));

    const gateGrades: GraderGrade[] = [];
    for (const grader of gates) {                                  // sequential: short-circuit
      const grade = await grader.run({ input, run, runAgency: this.agencyRunner });
      gateGrades.push({ grader, grade });
      if (!grader.passes(grade)) return { input, run, grades: gateGrades, gatesPassed: false };
    }
    const advisoryGrades = await Promise.all(
      advisory.map(async (grader) => ({ grader, grade: await grader.run({ input, run, runAgency: this.agencyRunner }) })),
    );
    return { input, run, grades: [...gateGrades, ...advisoryGrades], gatesPassed: true };
  }

  /** Run the agent in `ws`, memoized by (workspace, input). */
  protected runAgent(ws: Workspace, entryFile: string, input: Input): Promise<AgentRun> {
    const id = input.id ?? "";
    return this.cache.get(ws.key, id, async () => {
      const output = await this.agencyRunner.run(path.join(ws.dir, entryFile), input.node ?? "main", input.args);
      return { output, recordPath: "" };
    });
  }

  protected async eachIteration(step: (iter: number) => Promise<void>): Promise<void> {
    for (let iter = 1; iter <= this.config.iterations; iter += 1) await step(iter);
  }
}
```

Note: `AgentRun.recordPath` is `""` in Phase 3 (greedy/pointwise need only `output`). Capturing the
execution trace for GEPA reflection is a Phase 5 enhancement.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:run lib/optimize/baseOptimizer.test.ts`
Expected: PASS (2 tests).

(No commit yet — typecheck is red until Tasks 10–11.)

### Task 10: Rewrite `GreedyReflective` as a pointwise loop

**Files:** Rewrite `lib/optimize/greedyReflective.ts`; rewrite `lib/optimize/greedyReflective.test.ts`.

- [ ] **Step 1: Write the failing test** (inject a fake runner + stub graders + a fake proposer):

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgencyRunner } from "./grading/agencyRunner.js";
import { BaseGrader } from "./grading/baseGrader.js";
import { GreedyReflective } from "./greedyReflective.js";
import type { Grade, GraderInput, GraderOptions } from "./grading/types.js";

class ValueGrader extends BaseGrader {
  protected readonly defaultName = "value";
  constructor(private readonly value: () => number, options: GraderOptions = {}) { super(options); }
  protected _run(_i: GraderInput): Promise<Grade> { return Promise.resolve({ score: { kind: "scalar", value: this.value() } }); }
}

describe("GreedyReflective (pointwise)", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "greedy-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("accepts a candidate only when gates pass and the objective improves", async () => {
    const src = path.join(root, "src"); fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "agent.agency"), 'optimize const prompt = "hi"\n\nnode main() {}\n');

    // grader value climbs by iteration so each candidate beats the champion
    let calls = 0;
    const grader = new ValueGrader(() => 0.1 * ++calls);
    const runner = new AgencyRunner({}, async () => ({ data: "out" }));

    const opt = new GreedyReflective(
      { graders: [grader], iterations: 2, config: {}, runsDir: root, runId: "r", writeback: false },
      {
        workspaceRoot: path.join(root, "ws"),
        agencyRunner: runner,
        discover: () => ({ entryFile: "agent.agency", baseDir: src, files: {}, targets: [{ id: "agent.agency:global:prompt" }] }),
        propose: async () => ({ rationale: "x", operations: [] }),
        previewFiles: () => ({}),  // no-op file changes
      },
    );

    const result = await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: [{ id: "a", args: {} }] });
    expect(result.acceptedCount).toBeGreaterThan(0);
  });
});
```

(Adjust the injected `discover`/`propose`/`previewFiles` seam names to match your `GreedyReflective` constructor in Step 2; the point is to drive the loop without real discovery/mutation/LLM.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:run lib/optimize/greedyReflective.test.ts`
Expected: FAIL — old delegation export gone / new shape not implemented.

- [ ] **Step 3: Implement** `lib/optimize/greedyReflective.ts`:

```ts
import { discoverOptimizeTargets } from "./targets.js";
import { OptimizeSourceMutator } from "./sourceMutator.js";
import { proposeMutation } from "./mutator.js";
import { BaseOptimizer, type BaseOptimizerDeps } from "./baseOptimizer.js";
import type { BaseOptimizerConfig, OptimizeTarget } from "./optimizer.js";
import type { OptimizeResult } from "./types.js";
import type { Scorecard } from "./grading/scorecard.js";
import type { Workspace } from "./workspace.js";

type GreedyDeps = BaseOptimizerDeps & {
  discover?: (agentFile: string) => ReturnType<typeof discoverOptimizeTargets>;
  propose?: (...a: Parameters<typeof proposeMutation>) => Promise<{ rationale: string; operations: unknown[] }>;
  previewFiles?: (targetSet: unknown, operations: unknown[]) => Record<string, string>;
};

export class GreedyReflective extends BaseOptimizer {
  readonly name = "greedy";
  constructor(config: BaseOptimizerConfig, private readonly greedyDeps: GreedyDeps = {}) {
    super(config, greedyDeps);
  }

  async optimize(target: OptimizeTarget): Promise<OptimizeResult> {
    const discover = this.greedyDeps.discover ?? discoverOptimizeTargets;
    const source = discover(target.agent);
    const entry = source.entryFile;

    let championWs = this.fork(source.baseDir);
    let championScore = await this.evaluate(championWs, entry, target.inputs);
    this.requireBaselineGatesPass(championScore);

    let accepted = 0; let rejected = 0;
    await this.eachIteration(async () => {
      const candidate = this.fork(championWs.dir);
      const proposal = await (this.greedyDeps.propose ?? proposeMutation)({
        config: this.config.config, targets: source.targets, tasks: [], history: "",
      } as never);
      const files = (this.greedyDeps.previewFiles ?? defaultPreview)(source.targetSet ?? source, proposal.operations);
      this.workspace.applyFiles(candidate, files);
      const score = await this.evaluate(candidate, entry, target.inputs);
      if (this.beats(score, championScore)) { championWs = candidate; championScore = score; accepted += 1; }
      else { rejected += 1; }
    });

    return this.finish(target, championWs, entry, accepted, rejected);
  }

  private beats(candidate: Scorecard, champion: Scorecard): boolean {
    return candidate.gatesPassed() && candidate.objective() > champion.objective();
  }

  private requireBaselineGatesPass(score: Scorecard): void {
    if (!score.gatesPassed()) {
      throw new Error("Baseline fails a must-pass grader — fix the program or graders before optimizing.");
    }
  }

  private finish(target: OptimizeTarget, ws: Workspace, entry: string, accepted: number, rejected: number): OptimizeResult {
    // Writeback (sha-checked) is handled as today when config.writeback; assemble OptimizeResult.
    // (Reuse the existing writeback + OptimizeResult assembly from loop.ts, adapted to the champion workspace.)
    return { runId: this.config.runId, runDir: "", championIter: accepted > 0 ? accepted : "baseline", championFiles: {}, acceptedCount: accepted, rejectedCount: rejected, validationFailedCount: 0, iterations: [] };
  }
}

function defaultPreview(targetSet: unknown, operations: unknown[]): Record<string, string> {
  const mutator = new OptimizeSourceMutator({ targetSet } as never);
  const preview = mutator.preview(operations as never);
  if (preview.diagnostics.length > 0) throw new Error(preview.diagnostics.map((d: { message: string }) => d.message).join("; "));
  return preview.files;
}
```

Note: the proposer args (`tasks`/`history`) and `OptimizeResult` assembly are simplified above —
when implementing, thread the real iteration history and reuse `loop.ts`'s writeback +
result-building helpers (sha-checked multi-file writeback). The structure (fork → propose →
applyFiles → evaluate → accept-if-`beats`) is the contract under test.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:run lib/optimize/greedyReflective.test.ts`
Expected: PASS.

### Task 11: Registry + CLI desugaring + goal judge

**Files:** Modify `lib/optimize/registry.ts`, `lib/cli/eval/optimize.ts`, `scripts/agency.ts`; create `lib/agents/goalJudge.agency`.

- [ ] **Step 1:** `registry.ts` — update to the new factory signature and keep the null-prototype hardening:

```ts
registerOptimizer("greedy", (config) => new GreedyReflective(config));
// getOptimizer now takes (name, config) and returns factory(config); update its signature + tests.
```

- [ ] **Step 2:** Author `lib/agents/goalJudge.agency` — read `lib/agents/judge.agency` first and model it; node `main(goal, output)` returns `{ score: number (0..1), reasoning: string }` judging how well `output` satisfies `goal`.

- [ ] **Step 3:** `lib/cli/eval/optimize.ts` — build the target + config:
  - Inputs: `--goal` → `[{ id: "task-1", args: {}, metadata: { goal } }]`; `--tasks` → each task → `{ id: task.task_id, node: task.node, args: task.args, metadata: { goal: task.goal } }`.
  - Graders: a single `new LlmJudge({ name: "goal", agencyFile: <resolved path to lib/agents/goalJudge.agency>, goalPath: ["metadata","goal"] })`.
  - Build `BaseOptimizerConfig` (`graders`, `iterations`, `seed`, `config`, `runsDir`, `runId`, `writeback`) and call `getOptimizer(opts.optimizer ?? DEFAULT_OPTIMIZER, config).optimize({ agent: target.agentFile, inputs })`.
  - Remove the old `OptimizeLoopConfig` construction path (or keep building it only if you retain a separate pairwise optimizer; default greedy no longer needs it).

- [ ] **Step 4:** `scripts/agency.ts` — no new flag required (the `--optimizer` flag exists from Phase 1). Keep `--iterations`, `--goal`, `--tasks`, `--writeback`, `--run-id`, `--runs-dir`.

- [ ] **Step 5:** `pnpm typecheck` — now green again (contract migration complete).

### Task 12: Validate the behavior change + verification

- [ ] **Step 1:** Update `lib/cli/eval/optimize.test.ts` and `lib/optimize/loop.test.ts`: assertions that depended on pairwise `judgeSuite.winner === "B"` now depend on pointwise objective. Rework the capture/seam tests to the new config shape (graders + inputs instead of `OptimizeLoopConfig`). Keep the discovery/CLI-plumbing assertions.
- [ ] **Step 2:** Run `pnpm test:run lib/optimize lib/cli/eval` — all green.
- [ ] **Step 3:** `pnpm typecheck` and `pnpm run lint:structure` — clean.
- [ ] **Step 4:** Commit the whole contract migration:

```bash
git add lib/optimize lib/cli/eval/optimize.ts scripts/agency.ts lib/agents/goalJudge.agency
git commit -m "feat(optimize): migrate greedy to pointwise grading via BaseOptimizer"
```

- [ ] **Step 5:** Open PR "Phase 3B — pointwise greedy migration". In the description, **enumerate every acceptance-behavior difference from PR #283** (pairwise → pointwise) — this is the deferred behavior change.

---

## Self-Review (completed during planning)

- **Spec coverage:** general runner refactor → Task 1; `AgencyRunner` class → Task 2; `GraderInput.runAgency` → Task 3; `LlmJudge` → Task 4; `EvalCache` → Task 5; `WorkspaceManager` → Task 6; target-based `Optimizer` → Task 8; `BaseOptimizer.evaluate` pointwise pipeline (gates-first, short-circuit, scoping, per-input run+cache) → Task 9; greedy pointwise loop → Task 10; registry/CLI desugaring + goal judge → Task 11; fixture validation → Task 12.
- **Reviewer feedback addressed:** (1) `runAgencyNode` extracted, test-LLM logic isolated in `executeNodeAsync` (Task 1). (2) `AgencyRunner` is a class (Task 2). (3) the pointwise pipeline is `BaseOptimizer.evaluate()`/`gradeInput`/`runGates` methods, not free functions (Task 9). (4) Milestone 3B fully specified with code (Tasks 8–12).
- **Placeholder scan:** complete code in Tasks 1–10. Task 10's `finish()`/proposer-args and Task 11's CLI are the integration glue; their structure is given as code with explicit "reuse loop.ts writeback/result helpers" notes — the one deliberately-deferred detail is the `OptimizeResult` assembly + sha-checked writeback, which should be lifted from the existing `loop.ts` rather than re-derived.
- **Type consistency:** `BaseOptimizerConfig`/`OptimizeTarget` (Task 8) consumed by `BaseOptimizer` (Task 9), `GreedyReflective` (Task 10), registry + CLI (Task 11). `AgencyRunner`/`NodeRunner` (Task 2) used by `GraderInput` (Task 3), `LlmJudge` (Task 4), `BaseOptimizer` (Task 9). `Workspace`/`WorkspaceManager` (Task 6) used by `BaseOptimizer` (Task 9).

## Follow-on

- **Phase 4:** `HumanGrader` (extends `GraderInput`/`evaluate` with a human-review capability).
- **Phase 5:** GEPA (uses `BaseOptimizer.evaluate` + `Scorecard.inputScores`).
