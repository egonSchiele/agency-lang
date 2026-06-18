# Pluggable Optimizer Framework — Phase 4 (Human Grader) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `HumanGrader` — a normal `BaseGrader` whose `_run` pauses for a human rating — configured entirely by constructor settings, with no framework special-casing.

**Architecture:** `HumanGrader` is just another grader. It reads the agent output from `run.output` (already on `GraderInput`), prompts a human via a `read` function that defaults to a terminal (stdin) reader, and maps the response to a `Grade` (binary or scalar). The terminal reader fails fast when there's no TTY (e.g. CI). The `read` function is a **constructor** option (injected in tests / by a web harness) — there is **no** `HumanReviewFn` capability on `GraderInput` and **no** `BaseOptimizer`/CLI changes.

**Tech Stack:** TypeScript (ESM, `@/` alias), Vitest, Node `readline`.

**Source spec:** `docs/superpowers/specs/2026-06-17-pluggable-optimizer-framework-design.md`.

## Design note (revised from the original Phase 4 plan)

The original plan threaded a `requestHumanReview` capability through `GraderInput` →
`BaseOptimizer` → `BaseOptimizerConfig` → CLI. That special-cased the whole pipeline for one
grader whose only need is "show a prompt, read a response" — which are constructor settings.
`runAgency` belongs on `GraderInput` because many graders need it and it's optimizer-configured;
the human reader is needed by exactly one grader and varies only in *how it reads input*, so it
lives on the `HumanGrader` constructor (default terminal, overridable). **Human grading is
programmatic-only for now** (no CLI flag); it's used by constructing a `HumanGrader` and passing
it in the `graders` array.

## Prerequisites (assumed merged: Phases 1–3)

- `BaseGrader` (Phase 2): authors implement `_run(input: GraderInput): Promise<Grade>`; the base
  handles sampling/aggregation/gating; `name()` resolves the grader name.
- `GraderInput = { input, run, runAgency }` (Phase 3); `HumanGrader` uses only `run.output`.

## Before you start

- Fresh worktree / branch from updated `main`; `pnpm install && pnpm run build && pnpm run agency compile stdlib/` once.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Single test file: `pnpm test:run <path>`.

## File Structure

- Create: `lib/optimize/grading/humanGrader.ts` — `HumanGrader` class + the default `terminalRead`.
- Test: `lib/optimize/grading/humanGrader.test.ts`.

(No changes to `types.ts`, `baseOptimizer.ts`, `optimizer.ts`, or the CLI.)

---

### Task 1: `HumanGrader`

**Files:**
- Create: `lib/optimize/grading/humanGrader.ts`
- Test: `lib/optimize/grading/humanGrader.test.ts`

- [ ] **Step 1: Write the failing test** (inject `read` — no terminal):

```ts
import { describe, expect, it } from "vitest";

import { AgencyRunner } from "./agencyRunner.js";
import { HumanGrader, type HumanRead } from "./humanGrader.js";
import type { GraderInput, Input, JSON } from "./types.js";

const graderInput = (output: JSON): GraderInput => {
  const input: Input = { id: "i1", args: {} };
  return { input, run: { output, recordPath: "" }, runAgency: new AgencyRunner({}, async () => ({ data: null })) };
};

describe("HumanGrader", () => {
  it("normalizes a scalar rating against the scale", async () => {
    const read: HumanRead = async () => ({ rating: 8, note: "clean" });
    const grade = await new HumanGrader({ scale: { min: 1, max: 10 }, read }).run(graderInput("some code"));
    if (grade.score.kind !== "scalar") throw new Error("expected scalar");
    expect(grade.score.value).toBeCloseTo((8 - 1) / (10 - 1), 10); // min→0, max→1, so 0.777…
    expect(grade.feedback).toBe("clean");
  });

  it("supports a binary verdict when no scale is given", async () => {
    const read: HumanRead = async () => ({ pass: true });
    const grade = await new HumanGrader({ read }).run(graderInput("x"));
    expect(grade.score).toEqual({ kind: "binary", pass: true });
  });

  it("asks the human exactly once even if samples is set higher", async () => {
    let calls = 0;
    const read: HumanRead = async () => { calls += 1; return { rating: 1 }; };
    await new HumanGrader({ scale: { min: 0, max: 1 }, samples: 5, read }).run(graderInput("x"));
    expect(calls).toBe(1);
  });

  it("passes the prompt, scale, and stringified artifact to the reader", async () => {
    let seen: { prompt: string; artifact: string; scale?: { min: number; max: number } } | undefined;
    const read: HumanRead = async (req) => { seen = req; return { rating: 1 }; };
    await new HumanGrader({ name: "quality", prompt: "Rate it", scale: { min: 0, max: 2 }, read }).run(graderInput({ a: 1 }));
    expect(seen?.prompt).toBe("Rate it");
    expect(seen?.scale).toEqual({ min: 0, max: 2 });
    expect(seen?.artifact).toBe("{\"a\":1}");   // structured output stringified
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:run lib/optimize/grading/humanGrader.test.ts`
Expected: FAIL — cannot resolve `./humanGrader.js`.

- [ ] **Step 3: Implement** `lib/optimize/grading/humanGrader.ts`:

```ts
import * as readline from "readline/promises";

import { BaseGrader } from "./baseGrader.js";
import type { Grade, GraderInput, GraderOptions } from "./types.js";

export type HumanReviewRequest = { prompt: string; artifact: string; scale?: { min: number; max: number } };
export type HumanReviewResponse = { rating?: number; pass?: boolean; note?: string };
export type HumanRead = (request: HumanReviewRequest) => Promise<HumanReviewResponse>;

type HumanGraderOptions = GraderOptions & {
  prompt?: string;                       // shown above the artifact
  scale?: { min: number; max: number };  // omit → binary pass/fail
  read?: HumanRead;                       // defaults to the terminal reader; inject in tests / web harnesses
};

export class HumanGrader extends BaseGrader {
  protected readonly defaultName = "human";
  // Distinct name so it doesn't shadow BaseGrader.options (whose samples is forced to 1).
  private readonly humanOptions: HumanGraderOptions;
  constructor(options: HumanGraderOptions = {}) {
    super({ ...options, samples: 1 });   // a human is asked exactly once
    this.humanOptions = options;
  }

  protected async _run({ run }: GraderInput): Promise<Grade> {
    const read = this.humanOptions.read ?? terminalRead;
    const scale = this.humanOptions.scale;
    const response = await read({
      prompt: this.humanOptions.prompt ?? `Review this output (${this.name()}):`,
      artifact: typeof run.output === "string" ? run.output : globalThis.JSON.stringify(run.output),
      scale,
    });
    if (!scale) {
      return { score: { kind: "binary", pass: response.pass ?? false }, ...(response.note ? { feedback: response.note } : {}) };
    }
    const span = (scale.max - scale.min) || 1;
    const value = ((response.rating ?? scale.min) - scale.min) / span;
    return { score: { kind: "scalar", value }, ...(response.note ? { feedback: response.note } : {}) };
  }
}

/** Default reader: prompt on the terminal and read one line. Fails fast with no TTY (e.g. CI). */
export const terminalRead: HumanRead = async (request) => {
  if (!process.stdin.isTTY) {
    throw new Error("HumanGrader needs an interactive terminal but stdin is not a TTY (e.g. CI). Run interactively or remove the human grader.");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\n${request.prompt}\n${request.artifact}\n`);
    if (request.scale) {
      const answer = await rl.question(`Rating (${request.scale.min}-${request.scale.max}), optional note after a space: `);
      const [head, ...rest] = answer.trim().split(" ");
      return { rating: Number(head), note: rest.join(" ") || undefined };
    }
    const answer = await rl.question("Pass? (y/n), optional note after a space: ");
    const [head, ...rest] = answer.trim().split(" ");
    return { pass: head.toLowerCase().startsWith("y"), note: rest.join(" ") || undefined };
  } finally {
    rl.close();
  }
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:run lib/optimize/grading/humanGrader.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/optimize/grading/humanGrader.ts lib/optimize/grading/humanGrader.test.ts
git commit -m "feat(optimize): add HumanGrader (constructor-configured, programmatic-only)"
```

---

### Task 2: Verification

- [ ] `pnpm test:run lib/optimize` — all green (HumanGrader + the rest).
- [ ] `pnpm typecheck` and `pnpm run lint:structure` — clean.
- [ ] Confirm no framework files changed (`git diff --name-only main...HEAD` shows only the two new grading files + this plan doc).
- [ ] Manual smoke (optional, interactive): construct a `HumanGrader` in a scratch optimize run and confirm it prompts on the terminal; pipe stdin from `/dev/null` and confirm it errors fast rather than hanging.
- [ ] Open PR "Phase 4 — HumanGrader".

## Self-Review (completed during planning)

- **Spec coverage:** human grader as a normal TS grader with constructor settings (prompt, scale/binary, injectable reader) → Task 1; CI fail-fast via the default `terminalRead`'s TTY check → Task 1; single human sample → `super({ ...options, samples: 1 })`; gate-ordering protection (a human only runs after cheap gates pass) is inherited from `BaseOptimizer.gradeInput` (gates run first), unchanged.
- **Placeholder scan:** Task 1 has complete code.
- **Type consistency:** `HumanRead`/`HumanReviewRequest`/`HumanReviewResponse` defined once in `humanGrader.ts` and used by the class + default reader + tests. No `GraderInput`/`BaseOptimizer`/CLI types touched.

## Follow-on

- **Phase 5:** GEPA. (Unaffected by this revision.)
- A `--human` CLI flag to add a `HumanGrader` to the default goal-based run is deliberately deferred (programmatic-only for now).
