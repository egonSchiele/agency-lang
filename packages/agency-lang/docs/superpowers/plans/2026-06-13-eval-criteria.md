# Eval Criteria Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, suite-level `criteria` field (shared plaintext grading standards) that anchors the pairwise judge so `agency eval judge`/`optimize` reflect the user's own standards.

**Architecture:** Criteria are resolved (inline strings or `@path` file references) into a `string[]`, attached to each `EvalTask`, threaded into the pairwise judge prompt as grading standards, and rendered into a `<criteria>` block. They are **judge-only** — never passed to the mutator. No ground truth, no new eval mode; the judge stays pairwise.

**Tech Stack:** TypeScript, vitest, commander (CLI), Agency stdlib agents (`.agency` compiled via `make`).

**Reference spec:** `docs/superpowers/specs/2026-06-13-eval-criteria-design.md`

---

## File Structure

- **Create** `lib/eval/criteria.ts` — pure resolution + rendering helpers (`resolveCriteria`, `renderCriteria`). One responsibility: turn criterion sources into resolved/rendered text. Shared by loader and CLI.
- **Create** `lib/eval/criteria.test.ts` — unit tests for the above.
- **Create** `lib/eval/judge/criteria.test.ts` — LLM-free test that criteria flow through `judgeSuite` → `judgePair`.
- **Modify** `lib/eval/runTypes.ts` — add `criteria?: string[]` to `EvalTask`.
- **Modify** `lib/eval/loadTasks.ts` (+ `loadTasks.test.ts`) — parse suite-level `criteria`, resolve relative to task-file dir, attach via a single exported `withCriteria` helper (the one place that owns task-shaping); extend `taskFromGoal`.
- **Modify** `lib/eval/judge/types.ts` — add `criteria?` to `JudgePairArgs` (defined in pairwise.ts; see Task 3).
- **Modify** `lib/eval/judge/pairwise.ts` — thread criteria through `judgePair`, `judgePairwise`, `runPairwiseJudge`.
- **Modify** `lib/eval/judge/suite.ts` — pass `task.criteria` into each judge call.
- **Modify** `lib/agents/judgePairwise.agency` — add `criteria` param + prompt block; rebuild with `make`.
- **Modify** `scripts/agency.ts` — repeatable `--criteria` flag on `judge` and `optimize`.
- **Modify** `lib/cli/eval/optimize.ts` — wire criteria; error on `--criteria` + `--tasks`.
- **Modify** `lib/cli/evalJudge.ts` — wire criteria in both file mode and run/goal mode; error on `--criteria` + `--tasks`.
- **Modify** docs under `docs/site/` — document the field, the `@path` convention, and the flag.

---

## Task 1: Criteria resolution + rendering module

**Files:**
- Create: `lib/eval/criteria.ts`
- Test: `lib/eval/criteria.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/eval/criteria.test.ts`:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, it, expect } from "vitest";

import { resolveCriteria, renderCriteria } from "./criteria.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "criteria-"));
}

describe("resolveCriteria", () => {
  it("returns [] for undefined", () => {
    expect(resolveCriteria(undefined, process.cwd())).toEqual([]);
  });

  it("wraps a bare inline string", () => {
    expect(resolveCriteria("no any", process.cwd())).toEqual(["no any"]);
  });

  it("keeps inline array elements", () => {
    expect(resolveCriteria(["a", "b"], process.cwd())).toEqual(["a", "b"]);
  });

  it("loads @path relative to baseDir as one verbatim criterion", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "std.md"), "line1\nline2\n");
    expect(resolveCriteria(["x", "@std.md"], dir)).toEqual(["x", "line1\nline2"]);
  });

  it("treats a leading @@ as a literal @", () => {
    expect(resolveCriteria("@@handle", process.cwd())).toEqual(["@handle"]);
  });

  it("throws a clear error when an @file is missing", () => {
    expect(() => resolveCriteria("@nope.md", tmpDir())).toThrow(/criteria file/i);
  });
});

describe("renderCriteria", () => {
  it("renders empty string for no criteria", () => {
    expect(renderCriteria([])).toBe("");
    expect(renderCriteria(undefined)).toBe("");
  });

  it("renders a bulleted <criteria> block", () => {
    const out = renderCriteria(["no any", "handle errors"]);
    expect(out).toContain("<criteria>");
    expect(out).toContain("- no any");
    expect(out).toContain("- handle errors");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/eval/criteria.test.ts`
Expected: FAIL with "Failed to resolve import ./criteria.js" / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `lib/eval/criteria.ts`:

```ts
import * as fs from "fs";
import * as path from "path";

/**
 * Resolve criterion sources into a flat list of resolved criterion strings.
 *
 * A source is a string. If it starts with `@`, the remainder is a file path
 * (resolved relative to `baseDir`) whose entire contents become one criterion,
 * verbatim. A leading `@@` is an escape for a literal leading `@`. All other
 * strings are inline criteria. `@` never fans out into multiple criteria.
 */
export function resolveCriteria(
  sources: string | string[] | undefined,
  baseDir: string,
): string[] {
  if (sources === undefined) return [];
  const list = Array.isArray(sources) ? sources : [sources];
  return list.map((source) => resolveOne(source, baseDir));
}

function resolveOne(source: string, baseDir: string): string {
  if (source.startsWith("@@")) return source.slice(1);
  if (source.startsWith("@")) {
    const filePath = path.resolve(baseDir, source.slice(1));
    try {
      return fs.readFileSync(filePath, "utf-8").trimEnd();
    } catch (err) {
      throw new Error(`Failed to read criteria file ${filePath}: ${(err as Error).message}`);
    }
  }
  return source;
}

/**
 * Render resolved criteria into a prompt block for the judge. Returns "" when
 * there are no criteria so the judge prompt is unchanged from today.
 */
export function renderCriteria(criteria: string[] | undefined): string {
  if (!criteria || criteria.length === 0) return "";
  const bullets = criteria.map((c) => `- ${c}`).join("\n");
  return (
    "\nApply these grading standards. A response that violates them is worse, " +
    "even if it otherwise meets the goal:\n" +
    `<criteria>\n${bullets}\n</criteria>\n`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/eval/criteria.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/eval/criteria.ts lib/eval/criteria.test.ts
git commit -m "Add criteria resolution and rendering helpers"
```

---

## Task 2: EvalTask type + loader attaches suite-level criteria

**Files:**
- Modify: `lib/eval/runTypes.ts:1-7`
- Modify: `lib/eval/loadTasks.ts:11-34`
- Test: `lib/eval/loadTasks.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lib/eval/loadTasks.test.ts` (inside the existing top-level `describe`; mirror the file's existing imports — `fs`, `os`, `path` are already imported there):

```ts
  it("attaches suite-level criteria to every task", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-criteria-"));
    const file = path.join(dir, "suite.json");
    fs.writeFileSync(file, JSON.stringify({
      criteria: ["no any", "handle errors"],
      tasks: [{ goal: "g1", args: {} }, { goal: "g2", args: {} }],
    }));
    const tasks = loadTasksFromFile(file);
    expect(tasks[0].criteria).toEqual(["no any", "handle errors"]);
    expect(tasks[1].criteria).toEqual(["no any", "handle errors"]);
  });

  it("resolves @path criteria relative to the task file directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-criteria-at-"));
    fs.writeFileSync(path.join(dir, "std.md"), "house rules\n");
    const file = path.join(dir, "suite.json");
    fs.writeFileSync(file, JSON.stringify({
      criteria: "@std.md",
      tasks: [{ goal: "g1", args: {} }],
    }));
    const tasks = loadTasksFromFile(file);
    expect(tasks[0].criteria).toEqual(["house rules"]);
  });

  it("leaves criteria undefined when none are given", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-no-criteria-"));
    const file = path.join(dir, "suite.json");
    fs.writeFileSync(file, JSON.stringify({ tasks: [{ goal: "g1", args: {} }] }));
    const tasks = loadTasksFromFile(file);
    expect(tasks[0].criteria).toBeUndefined();
  });
```

> If `os` is not already imported at the top of `loadTasks.test.ts`, add `import * as os from "os";`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/eval/loadTasks.test.ts`
Expected: FAIL — `tasks[0].criteria` is `undefined` (criteria not yet parsed).

- [ ] **Step 3: Add `criteria` to the `EvalTask` type**

In `lib/eval/runTypes.ts`, change the `EvalTask` type (lines 1-7) to:

```ts
export type EvalTask = {
  task_id: string;
  goal: string;
  args: Record<string, any>;
  node?: string;
  working_dir?: string;
  criteria?: string[];
};
```

- [ ] **Step 4: Parse + attach criteria in the loader**

In `lib/eval/loadTasks.ts`:

Add the import near the other imports (after line 6):

```ts
import { resolveCriteria } from "./criteria.js";
```

Add a single declarative helper that owns the "a task carries the suite's
shared criteria" rule, so no call site hand-rolls the attach logic. Place it
just above `taskFromGoal`:

```ts
/** A task carrying the suite's shared criteria — field omitted when empty. */
export function withCriteria(task: EvalTask, criteria: string[]): EvalTask {
  return criteria.length > 0 ? { ...task, criteria } : task;
}
```

Extend `taskFromGoal` (lines 11-16) to accept resolved criteria, expressed via
the helper (no inline guard):

```ts
export function taskFromGoal(goal: string, criteria: string[] = []): EvalTask {
  if (typeof goal !== "string" || goal.length === 0) {
    throw new Error("--goal must be a non-empty string");
  }
  return withCriteria({ task_id: "task-1", goal, args: {} }, criteria);
}
```

Replace `loadTasksFromFile` (lines 26-34) to read suite-level criteria and
attach them declaratively (a `map`, not a mutation loop):

```ts
export function loadTasksFromFile(filePath: string, makeId: MakeId = nanoid): EvalTask[] {
  const parsed = readJson(filePath);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).tasks)) {
    throw new Error(`Task suite ${filePath} must contain a top-level tasks array`);
  }
  const baseDir = path.dirname(filePath);
  const criteria = resolveCriteria((parsed as any).criteria as string | string[] | undefined, baseDir);
  const tasks = validateTasks(
    (parsed as any).tasks.map((raw: unknown) => normalizeTask(raw, baseDir, makeId)),
  );
  return tasks.map((task) => withCriteria(task, criteria));
}
```

> Note: directory-mode loading (`loadTasksFromDirectory`) has no single suite file, so it does not support criteria. This is intentional for v1.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:run lib/eval/loadTasks.test.ts`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 6: Commit**

```bash
git add lib/eval/runTypes.ts lib/eval/loadTasks.ts lib/eval/loadTasks.test.ts
git commit -m "Attach suite-level criteria to eval tasks"
```

---

## Task 3: Thread criteria into the pairwise judge

**Files:**
- Modify: `lib/eval/judge/pairwise.ts:14-20,33-37,61-94`
- Modify: `lib/eval/judge/suite.ts:96-107`
- Modify: `lib/agents/judgePairwise.agency`
- Test: `lib/eval/judge/criteria.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/eval/judge/criteria.test.ts`:

```ts
import { describe, it, expect } from "vitest";

import { judgeSuite } from "./suite.js";
import type { JudgePairArgs } from "./pairwise.js";
import type { TaskVerdict } from "./types.js";

describe("judgeSuite criteria forwarding", () => {
  it("forwards task criteria to each judgePair call", async () => {
    const received: (string[] | undefined)[] = [];
    const fakeJudge = async (args: JudgePairArgs): Promise<TaskVerdict> => {
      received.push(args.criteria);
      return {
        taskId: args.taskId,
        goal: args.goal,
        inputs: [{ status: "ok" }, { status: "ok" }],
        winner: "A",
        confidence: 80,
        reasoning: "",
        samples: [{ winner: "A", confidence: 80, reasoning: "", order: args.order ?? "AB" }],
        generatedAt: "",
      };
    };

    const runA = { runDir: "a", tasksById: { t1: { taskId: "t1", status: "ok" as const, recordPath: "a.json" } } };
    const runB = { runDir: "b", tasksById: { t1: { taskId: "t1", status: "ok" as const, recordPath: "b.json" } } };

    await judgeSuite({
      runA,
      runB,
      tasks: [{ task_id: "t1", goal: "g", args: {}, criteria: ["no any"] }],
      policy: { samples: 1, confidenceThreshold: 0, marginThreshold: 0, positionBias: "none" },
      judgePair: fakeJudge,
    });

    expect(received[0]).toEqual(["no any"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/eval/judge/criteria.test.ts`
Expected: FAIL — `args.criteria` is `undefined` (suite does not yet forward it) / type error on `criteria` not existing on `JudgePairArgs`.

- [ ] **Step 3: Add `criteria` to `JudgePairArgs` and thread it through `pairwise.ts`**

In `lib/eval/judge/pairwise.ts`:

Extend `JudgePairArgs` (lines 14-20):

```ts
export type JudgePairArgs = {
  taskId: string;
  goal: string;
  recordPathA: string;
  recordPathB: string;
  order?: "AB" | "BA";
  criteria?: string[];
};
```

In `judgePair`, pass criteria into `runPairwiseJudge` (replace the call at lines 33-37):

```ts
  const judged = await runPairwiseJudge(
    args.goal,
    order === "AB" ? respA.text : respB.text,
    order === "AB" ? respB.text : respA.text,
    args.criteria,
  );
```

Extend the file-mode `judgePairwise` wrapper (lines 61-80) to accept and forward criteria:

```ts
export async function judgePairwise(
  goal: string,
  recordPathA: string,
  recordPathB: string,
  criteria?: string[],
): Promise<PairwiseVerdict> {
  const verdict = await judgePair({ taskId: "pairwise", goal, recordPathA, recordPathB, criteria });

  return {
    verdictVersion: 1,
    goal,
    inputs: [
      pairwiseInputOf(verdict.inputs[0]),
      pairwiseInputOf(verdict.inputs[1]),
    ],
    winner: verdict.winner,
    confidence: verdict.confidence,
    reasoning: verdict.reasoning,
    generatedAt: verdict.generatedAt,
  };
}
```

Update `runPairwiseJudge` (lines 82-94) to render criteria and pass them as an agent arg. Add the import at the top of the file (after line 5):

```ts
import { renderCriteria } from "../criteria.js";
```

Then:

```ts
async function runPairwiseJudge(
  goal: string,
  responseA: string,
  responseB: string,
  criteria?: string[],
): Promise<PairwiseJudgeResult> {
  const result = await runAgencyAgent({
    agent: "judgePairwise.agency",
    node: "judgePairwise",
    args: { goal, responseA, responseB, criteria: renderCriteria(criteria) },
    config: {},
  });
  return assertPairwiseJudgeResult(result.data);
}
```

- [ ] **Step 4: Forward `task.criteria` in `suite.ts`**

In `lib/eval/judge/suite.ts`, update the judge call inside `judgeSuite` (lines 99-105) to include criteria:

```ts
      const verdict = await judge({
        taskId: task.task_id,
        goal: task.goal,
        recordPathA: taskA.recordPath ?? "",
        recordPathB: taskB.recordPath ?? "",
        order,
        criteria: task.criteria,
      });
```

- [ ] **Step 5: Run the forwarding test to verify it passes**

Run: `pnpm test:run lib/eval/judge/criteria.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the `criteria` param to the judge agent prompt**

In `lib/agents/judgePairwise.agency`, change the node signature (lines 7-11) to add a defaulted `criteria` param:

```
node judgePairwise(
  goal: string,
  responseA: string,
  responseB: string,
  criteria: string = "",
): PairwiseJudgeResult {
```

Then insert `${criteria}` into the prompt, immediately after the Response B block (after line 27, before the `Decide which response...` line). The relevant prompt region becomes:

```
  Response B:
  <response>
  ${responseB}
  </response>
  ${criteria}
  Decide which response better meets the goal. Pick \"A\", \"B\", or \"tie\". Return confidence as an integer from 0 to 100:
```

> `${criteria}` is empty (renders nothing meaningful) when no criteria are supplied, so existing behavior is preserved.

- [ ] **Step 7: Rebuild stdlib and run the judge tests**

Run: `make`
Expected: build succeeds (recompiles the changed `.agency` agent).

Run: `pnpm test:run lib/eval/judge/criteria.test.ts`
Expected: PASS (still green after rebuild).

- [ ] **Step 8: Commit**

```bash
git add lib/eval/judge/pairwise.ts lib/eval/judge/suite.ts lib/agents/judgePairwise.agency lib/eval/judge/criteria.test.ts
git commit -m "Thread criteria into the pairwise judge prompt"
```

---

## Task 4: CLI `--criteria` flag (judge + optimize)

**Files:**
- Modify: `scripts/agency.ts:324-352` (judge) and `scripts/agency.ts:354-382` (optimize)
- Modify: `lib/cli/eval/optimize.ts:18-32,71-83`
- Modify: `lib/cli/evalJudge.ts:11-19,31-45,75-84`

- [ ] **Step 1: Add the repeatable `--criteria` flag in `scripts/agency.ts`**

Near the top of the file's command-building function (just before `const evalCmd = program` at line 257), add a collector helper:

```ts
  const collectCriteria = (value: string, previous: string[]): string[] => previous.concat([value]);
```

On the **judge** command (after line 330, `.option("--tasks ...")`), add:

```ts
    .option("--criteria <textOrFile>", "Grading standard (inline or @file); repeatable", collectCriteria, [])
```

Add `criteria?: string[];` to the judge action's `opts` type (the object literal at lines 340-348).

On the **optimize** command (after line 359, `.option("--tasks ...")`), add the same option line:

```ts
    .option("--criteria <textOrFile>", "Grading standard (inline or @file); repeatable", collectCriteria, [])
```

Add `criteria?: string[];` to the optimize action's `opts` type (the object literal at lines 370-381).

- [ ] **Step 2: Wire criteria into `optimize.ts`**

In `lib/cli/eval/optimize.ts`:

Add the import (after line 6):

```ts
import { resolveCriteria } from "@/eval/criteria.js";
```

Add `criteria?: string[];` to `EvalOptimizeOptions` (inside the type at lines 18-32).

In `buildOptimizeLoopConfig`, replace the task construction (lines 77-79) with criteria handling:

```ts
  const cliCriteria = opts.criteria ?? [];
  if (cliCriteria.length > 0 && taskSelection === "tasks") {
    throw new Error("--criteria cannot be combined with --tasks; put criteria in the task file instead");
  }
  const tasks = taskSelection === "goal"
    ? [taskFromGoal(opts.goal ?? "", resolveCriteria(cliCriteria, process.cwd()))]
    : loadTasks(path.resolve(opts.tasks ?? ""), deps.makeId ?? nanoid);
```

- [ ] **Step 3: Wire criteria into `evalJudge.ts`**

In `lib/cli/evalJudge.ts`:

Add the imports (after line 6):

```ts
import { resolveCriteria } from "@/eval/criteria.js";
import { withCriteria } from "@/eval/loadTasks.js";
```

> `loadTasks` already imports from this file (`loadTasks`), so import `withCriteria` from the same module to keep task-shaping in one place.

Add `criteria?: string[];` to `EvalJudgeOptions` (lines 11-19).

In file mode, forward resolved criteria to `judgePairwise` (replace line 34):

```ts
    const criteria = resolveCriteria(opts.criteria ?? [], process.cwd());
    const verdict = await judgePairwise(opts.goal, inputA, inputB, criteria);
```

In run mode, after `const taskSelection = validateTaskSelection(opts);` (line 44), reject criteria with `--tasks` and resolve for the goal sub-mode:

```ts
  const cliCriteria = opts.criteria ?? [];
  if (cliCriteria.length > 0 && taskSelection === "tasks") {
    throw new Error("--criteria cannot be combined with --tasks; put criteria in the task file instead");
  }
  const tasks = taskSelection === "goal"
    ? tasksFromInlineGoal(inputA, inputB, opts.goal ?? "", resolveCriteria(cliCriteria, process.cwd()))
    : loadTasks(path.resolve(opts.tasks ?? ""));
```

(Replace the existing `const tasks = ...` assignment at line 45.)

Update `tasksFromInlineGoal` (lines 75-84) to accept and attach criteria:

```ts
function tasksFromInlineGoal(runA: string, runB: string, goal: string, criteria: string[]) {
  const summaryA = readEvalRun(runA);
  const summaryB = readEvalRun(runB);
  const taskIdA = onlyTaskId(summaryA);
  const taskIdB = onlyTaskId(summaryB);
  if (taskIdA !== taskIdB) {
    throw new Error(`Inline --goal run task ids differ (${taskIdA} vs ${taskIdB}); use --tasks instead`);
  }
  return [withCriteria({ task_id: taskIdA, goal, args: {} }, criteria)];
}
```

- [ ] **Step 4: Typecheck the CLI changes**

Run: `pnpm run build` (or the repo's typecheck; if unsure use `pnpm test:run lib/cli/eval` to compile the touched modules)
Expected: no TypeScript errors.

- [ ] **Step 5: Manual smoke check (no LLM)**

Run: `pnpm run agency eval optimize --help`
Expected: output lists `--criteria <textOrFile>`.

Run: `pnpm run agency eval optimize some.agency --tasks t.json --criteria "x"` (with any paths)
Expected: errors with "--criteria cannot be combined with --tasks ...".

- [ ] **Step 6: Commit**

```bash
git add scripts/agency.ts lib/cli/eval/optimize.ts lib/cli/evalJudge.ts
git commit -m "Add repeatable --criteria flag to eval judge and optimize"
```

---

## Task 5: Documentation

**Files:**
- Modify: the eval task-file / CLI reference page(s) under `docs/site/` (locate with the grep below)

- [ ] **Step 1: Find the eval docs to update**

Run: `grep -rln "\-\-tasks\|task suite\|eval optimize\|eval judge" docs/site/`
Expected: one or more markdown pages documenting the eval commands and the task-file format.

- [ ] **Step 2: Document the `criteria` field and flag**

In the eval task-file reference, add a `criteria` section covering:
- It is an **optional, suite-level** field (sibling of `tasks`), shared across all tasks.
- It accepts a string or an array; array elements may mix inline text and `@path` file references.
- A `@path` loads the file's entire contents as **one** criterion, resolved relative to the task file's directory; `@@` escapes a literal leading `@`.
- Criteria anchor the **judge only** (they are never shown to the optimizer's mutator).

Include the worked example from the spec:

```json
{
  "criteria": [
    "Prefer pure, immutable transformations (map/reduce/filter) over loops that mutate external state",
    "Never use `any`; introduce precise types instead",
    "@./docs/dev/anti-patterns.md"
  ],
  "tasks": [
    { "goal": "Refactor this reducer to avoid mutation", "args": { "code": "..." } }
  ]
}
```

In the CLI reference for `eval judge` and `eval optimize`, document the repeatable `--criteria <textOrFile>` flag (inline or `@file`, `@path` resolved relative to cwd), and that combining `--criteria` with `--tasks` is an error.

- [ ] **Step 3: Commit**

```bash
git add docs/site/
git commit -m "Document eval criteria field and --criteria flag"
```

---

## Self-Review

**Spec coverage:**
- Suite-level `criteria` in task file → Task 2. ✅
- `@path` resolution (file-dir for files, cwd for CLI) + whole-file-as-one-criterion + `@@` escape → Task 1 (`resolveCriteria`), used in Tasks 2 & 4. ✅
- Repeatable `--criteria` on `optimize` and `judge`, not `run` → Task 4 (flag only added to judge + optimize). ✅
- `--criteria` + `--tasks` is an error → Task 4 (both commands). ✅
- Criteria thread into judge prompt → Task 3. ✅
- Judge two-mode nuance (file mode does not use loadTasks) → Task 4 Step 3 handles file mode explicitly. ✅
- Mutator unchanged (judge-only) → no task touches `lib/optimize/*` or `mutatePrompt.agency`; verified by omission. ✅
- Backward compatible (empty criteria → today's behavior) → `renderCriteria([]) === ""`, `criteria` optional everywhere; covered by Task 1 + Task 2 "leaves criteria undefined" test. ✅
- "criteria with neither --goal nor --tasks" (flagged nuance) → existing `validateTaskSelection` already throws "Provide exactly one of --tasks or --goal" before criteria are used; no new handling needed. ✅
- Docs → Task 5. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code. The only ellipses are inside illustrative JSON `"code": "..."` payloads, which are intentional sample data, not plan gaps.

**Type consistency:** `resolveCriteria(sources, baseDir)` and `renderCriteria(criteria)` signatures are used identically in Tasks 2, 3, 4. `EvalTask.criteria?: string[]` defined in Task 2 is read in Task 3 (`task.criteria`) and attached only through `withCriteria(task, criteria)` (Task 2), the single declarative owner of task-shaping, reused by `taskFromGoal` (Task 2), `loadTasksFromFile` (Task 2), and `tasksFromInlineGoal` (Task 4) — no call site hand-rolls the attach guard. `JudgePairArgs.criteria?: string[]` defined in Task 3 Step 3 is forwarded in Task 3 Step 4 and consumed by the Task 3 test. `taskFromGoal(goal, criteria: string[] = [])` and `tasksFromInlineGoal(runA, runB, goal, criteria)` signatures match their call sites in Task 4.

**Anti-pattern check (`docs/dev/anti-patterns.md`):** "Imperative code everywhere" — attachment is encapsulated behind `withCriteria` and applied via `map`, not a mutation loop, so the three call sites are declarative. "Inconsistent patterns" / duplication — the attach guard lives in exactly one helper. "Leaky abstractions" — `criteria.ts` exposes `resolve`/`render` and hides `@path` + prompt-block construction. "Swallowed catch" — `resolveOne` rethrows with context. No nested ternaries; the empty-vs-undefined `criteria` field has no downstream meaning and is handled once in `withCriteria`.
