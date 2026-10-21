# Must-Pass Graders Need a Threshold: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A must-pass grader that returns a score and has no threshold stops grading with an error, instead of passing silently. Every such grader in the suites gets a threshold.

**Architecture:** One check in `BaseGrader.passes()`, which is the only place a gate's verdict is decided. The error is rethrown with the test id by the gate loop in `gradeRun.ts`, the only caller. Then a sweep over the suites' `graders.ts` files.

**Tech Stack:** TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-20-graders-as-data-and-eval-edit-design.md`, section "Must-pass judges in TypeScript". Linear: ADI-28.

## Background

A grader is a class that extends `BaseGrader` in `lib/eval/grading/baseGrader.ts`. It returns a `Grade`, whose `score` is either `{ kind: "binary", pass }` or `{ kind: "scalar", value }`. A grader with `mustPass: true` in its options is a gate. The gate loop in `gradeInput` in `lib/eval/grading/gradeRun.ts` runs every gate first and calls `grader.passes(grade)`. If a gate fails, the test scores zero and the other graders never run.

`passes()` is:

```ts
passes(grade: Grade): boolean {
  if (grade.score.kind === "binary") return grade.score.pass;
  return grade.score.value >= (this.options.threshold ?? 0);
}
```

A scalar gate with no threshold passes a score of 0. Every LLM judge returns a scalar. So a must-pass judge with no threshold is a gate that cannot close. Fourteen files under `evals/` set `mustPass: true`. Twelve build a binary grade, which is fine. Two are scalar, both through `judges.goal`: `asks-for-the-missing-facts` in `evals/agency-agent/ask-before-tool/graders.ts` and `takes-a-position` in `evals/agency-agent/packaging-decision/graders.ts`. No file under `evals/` sets `threshold` at all.

`passes()` has two callers: the gate loop at `gradeRun.ts:415` and the optimizer's `failingGraders` at `lib/optimize/baseOptimizer.ts:504`. The optimizer runs over a scorecard that `gradeRun` already produced, so `gradeRun` throws first on the same grade and the optimizer needs no change.

The gate loop runs the grader before it asks `passes()`, so the check in `passes()` fires after the judge has been paid for. `BaseGrader.validateInput(test)` at `baseGrader.ts:46-50` is a pre-flight hook that runs before any grader does, and `validateGraders` at `gradeRun.ts:135-142` calls it over a grader list. Today only the optimizer calls `validateGraders`; `eval run` and `eval grade` do not, and wiring them is a separate change. An `LlmJudge` that is not `binary` always returns a scalar, so it can refuse in `validateInput`. The two agent-suite judges are function graders, which cannot know their score kind ahead of time, so for them the `passes()` check is the only one. The graders.json plan builds every goal grader as an `LlmJudge`, so it gets the pre-flight.

The comment above `runGrader` in `gradeRun.ts` says "a gate with no threshold passes a scalar 0" and relies on it to explain why a crashed grader returns a binary fail. After this change the sentence is no longer true and the reason for the binary fail stands on its own.

## Global Constraints

- Run `pnpm run typecheck` after every edit. Vitest does not type check.
- Save test output to a file and read it from there.
- Format with `pnpm run fmt:ts` before committing.
- Do not run the full agency test suite locally.

## Review Focus

- A scalar gate with `threshold: 0` set on purpose must still pass a score of 0. The check must look for an absent threshold, not a falsy one. Pinned by the test in Task 1.
- A non-gate grader with no threshold must keep working. `passes()` must not throw when `mustPass` is false. Pinned by the test in Task 1.
- A binary gate with no threshold must keep working. Pinned by the test in Task 1.
- The error must name the test, since one grading pass covers many tests. Pinned by the test in Task 2.
- A must-pass `LlmJudge` built by `goalJudge()` in `gradeRun.ts` is not a gate (no `mustPass`), so it is unaffected. No test needed; noted so the implementer does not add a threshold there.

---

### Task 1: `passes()` refuses to decide a scalar gate with no threshold

**Files:**
- Modify: `lib/eval/grading/baseGrader.ts:74-77`
- Test: `lib/eval/grading/baseGrader.test.ts`

**Interfaces:**
- Produces: `passes(grade: Grade): boolean` throws `Error` with message `` `${this.name()}: must-pass grader returned a score but has no threshold; set threshold in its options` `` when `this.mustPass()` is true, `grade.score.kind === "scalar"`, and `this.options.threshold === undefined`.

- [ ] **Step 1: Write the failing tests**

Add to the `describe` in `baseGrader.test.ts`, beside the existing `passes()` test at line 67:

```ts
it("passes() throws for a must-pass scalar grader with no threshold", () => {
  const g = new StubGrader(() => ({ score: { kind: "scalar", value: 1 } }), {
    name: "judge",
    mustPass: true,
  });
  expect(() => g.passes({ score: { kind: "scalar", value: 1 } })).toThrow(
    "judge: must-pass grader returned a score but has no threshold; set threshold in its options",
  );
});

it("passes() accepts a must-pass scalar grader whose threshold is 0", () => {
  const g = new StubGrader(() => ({ score: { kind: "scalar", value: 0 } }), {
    mustPass: true,
    threshold: 0,
  });
  expect(g.passes({ score: { kind: "scalar", value: 0 } })).toBe(true);
});

it("passes() still reads a scalar against threshold 0 when the grader is not a gate", () => {
  const g = new StubGrader(() => ({ score: { kind: "scalar", value: 0 } }), {});
  expect(g.passes({ score: { kind: "scalar", value: 0 } })).toBe(true);
});

it("passes() reads a binary must-pass grader with no threshold", () => {
  const g = new StubGrader(() => ({ score: { kind: "binary", pass: true } }), {
    mustPass: true,
  });
  expect(g.passes({ score: { kind: "binary", pass: false } })).toBe(false);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run lib/eval/grading/baseGrader.test.ts > /tmp/claude-501/baseGrader.txt 2>&1; tail -30 /tmp/claude-501/baseGrader.txt`
Expected: the first new test fails because nothing throws. The other three pass already.

- [ ] **Step 3: Implement the check in `passes()`**

In `lib/eval/grading/baseGrader.ts`, before the scalar comparison, throw when the grader is a gate and `this.options.threshold === undefined`. Update the doc comment on `threshold` in `GraderOptions` in `lib/eval/grading/types.ts:34` to say a must-pass scalar grader requires it.

- [ ] **Step 4: Write the failing pre-flight test for `LlmJudge`**

In `lib/eval/grading/graders/llmJudge.test.ts`:

```ts
it("validateInput refuses a must-pass judge with no threshold before any call", () => {
  const judge = new LlmJudge({ name: "goal", goal: "g", mustPass: true });
  expect(() => judge.validateInput({ id: "t" })).toThrow("goal: a must-pass judge needs a threshold");
});

it("validateInput accepts a must-pass binary judge with no threshold", () => {
  const judge = new LlmJudge({ name: "goal", goal: "g", mustPass: true, binary: true });
  expect(() => judge.validateInput({ id: "t" })).not.toThrow();
});
```

- [ ] **Step 5: Implement `validateInput` on `LlmJudge`**

One rule, two call sites. Put the rule in one place on `BaseGrader`: `protected missingThreshold(): boolean`, true when `this.mustPass()` and `this.options.threshold === undefined`. `passes()` from Step 3 calls it for a scalar grade. In `lib/eval/grading/graders/llmJudge.ts`, override `validateInput(_test: Test): void` to throw `` `${this.name()}: a must-pass judge needs a threshold` `` when `this.missingThreshold()` and `this.options.binary` is not true. Neither site repeats the condition.

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm vitest run lib/eval/grading/baseGrader.test.ts lib/eval/grading/graders/llmJudge.test.ts > /tmp/claude-501/baseGrader.txt 2>&1; tail -5 /tmp/claude-501/baseGrader.txt && pnpm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add lib/eval/grading/baseGrader.ts lib/eval/grading/baseGrader.test.ts lib/eval/grading/types.ts lib/eval/grading/graders/llmJudge.ts lib/eval/grading/graders/llmJudge.test.ts
git commit -F /tmp/claude-501/msg.txt
```

Commit message: `Grading: a must-pass grader that returns a score needs a threshold (ADI-28)`.

---

### Task 2: The gate loop names the test in the error

**Files:**
- Modify: `lib/eval/grading/gradeRun.ts:407-420` (the gate loop in `gradeInput`) and the comment at `gradeRun.ts:430-433`
- Test: `lib/eval/grading/gradeRun.test.ts`

**Interfaces:**
- Consumes: `passes()` from Task 1.
- Produces: the error from `passes()` leaves `gradeInput` with the test id in front: `` `${test.id}: ${message}` ``.

- [ ] **Step 1: Write the failing test**

Read the top of `gradeRun.test.ts` for how it builds a run and a grader list, and add a test with this shape:

```ts
it("stops with an error naming the test when a must-pass scalar grader has no threshold", async () => {
  // a test "t1", a run with an output, and one grader built with
  // grader(() => 1, { name: "judge", mustPass: true })
  await expect(gradeRunDirectory(/* as the other tests do */)).rejects.toThrow(
    "t1: judge: must-pass grader returned a score but has no threshold",
  );
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm vitest run lib/eval/grading/gradeRun.test.ts > /tmp/claude-501/gradeRun.txt 2>&1; tail -30 /tmp/claude-501/gradeRun.txt`
Expected: fails because the message has no test id. `passes()` is called at `gradeRun.ts:415`, outside the `try` in `runGrader`, so the error is never turned into a binary fail.

- [ ] **Step 3: Rethrow with the test id**

In `gradeInput`, wrap the `grader.passes(grade)` call so an error from it is rethrown as `new Error(`${test.id ?? "(no id)"}: ${message}`)`. `Test.id` is optional, and `snapshotGraderFilesDir` at `gradeRun.ts:182` already uses that fallback. Do not catch it in `runGrader`: that function catches only `grader.run`, and this error must end the pass. Rewrite the comment above `runGrader` so it no longer says a gate with no threshold passes a scalar 0. Say instead that a crashed grader returns a binary fail so the gate loop can short-circuit on it.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm vitest run lib/eval/grading/gradeRun.test.ts > /tmp/claude-501/gradeRun.txt 2>&1; tail -5 /tmp/claude-501/gradeRun.txt && pnpm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add lib/eval/grading/gradeRun.ts lib/eval/grading/gradeRun.test.ts
git commit -F /tmp/claude-501/msg.txt
```

Commit message: `Grading: name the test when a gate has no threshold (ADI-28)`.

---

### Task 3: Add thresholds to the suites' must-pass judges

**Files:**
- Modify: `evals/agency-agent/ask-before-tool/graders.ts:14`
- Modify: `evals/agency-agent/packaging-decision/graders.ts:20`
- Check, no change expected: every other file under `evals/` that sets `mustPass: true`, including the shared builders `evals/agency-agent/lib/checks.ts` and `evals/writing-rewrite/lib/rewriteGraders.ts`, which both return `binary(...)`.

- [ ] **Step 1: List every must-pass grader in the suites**

Run: `grep -rln "mustPass: true" evals` and read each hit. The glob `evals/*/*/graders.ts` misses the two shared builders named above.

For each `mustPass: true`, decide whether the grader returns a scalar. A grader returns a scalar when it calls `judges.goal`, `judges.rubric`, `scalar(...)`, is an `LlmJudge`, or returns a number. Write the list of scalar gates to `/tmp/claude-501/gates.txt`. Expected: the two files above and no others.

- [ ] **Step 2: Add `threshold: 0.5` to each scalar gate**

If the list in Step 1 has more than the two, add the threshold there too, and say so in the commit message.

- [ ] **Step 3: Typecheck the evals**

Run: `pnpm run typecheck`
Expected: clean. The evals tsconfig is part of that script.

- [ ] **Step 4: Commit**

```bash
git add evals/agency-agent/ask-before-tool/graders.ts evals/agency-agent/packaging-decision/graders.ts
git commit -F /tmp/claude-501/msg.txt
```

Commit message: `Agent suite: must-pass judges pass at 0.5 (ADI-28)`.

---

### Task 4: One sentence in the grading doc

**Files:**
- Modify: `docs/dev/evals/eval-grading.md`

- [ ] **Step 1: Add the rule**

The doc has no section on gates. The nearest mention is the `harnessMustPass` paragraph near line 244. Add a short heading, "Gates", above that paragraph, and under it: "A must-pass grader that returns a score must set `threshold`. Without one, grading stops with an error naming the test and the grader, because a scalar gate with no threshold would pass a score of 0. An `LlmJudge` refuses up front, in `validateInput`; a function grader is caught when its grade comes back."

- [ ] **Step 2: Commit**

```bash
git add docs/dev/evals/eval-grading.md
git commit -F /tmp/claude-501/msg.txt
```

Commit message: `Docs: must-pass scalar graders need a threshold (ADI-28)`.
