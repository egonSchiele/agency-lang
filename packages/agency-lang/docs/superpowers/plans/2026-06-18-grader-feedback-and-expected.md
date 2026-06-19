# Expected outputs + grader feedback in optimizer reflection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. (Per the repo owner's standing preference, implement directly in the main session — no subagent-driven development.)

**Goal:** Make a custom grader (or labeled examples) able to steer the optimizer *without* a separate `--goal`, by adding a first-class `expected` output field to inputs and feeding both the per-input `expected` answer and each grader's `feedback` into the mutator's reflection (greedy) — GEPA already renders feedback and just needs `expected` added.

**Background:** A demo run showed greedy's mutator only sees `input.goal` + a scalar objective; with a metadata-only custom grader it had no idea the objective was "capitals" and polished the *area* prompt instead. The grader knew (it scored 0 and the judge explained why), but that signal never reached the mutator. DSPy avoids a goal flag by showing its instruction-proposer the labeled examples (gold outputs) and using metric feedback; this brings the same signals to our reflection.

**Tech Stack:** TypeScript (Node, ESM, `@/` alias, `.js` import extensions), vitest, Agency agents (`.agency` → recompiled with `make agents`).

---

## Global Constraints

- **Run `make agents` after editing any `.agency` agent** (`lib/agents/optimize/*.agency`) so the recompiled agent in `dist` has the new node signature; `pnpm run build` alone does not. For pure-TS tasks, `npx tsc --noEmit` is the typecheck.
- Code style (enforced by `pnpm run lint:structure`): objects not maps, arrays not sets, `type` not `interface`, no dynamic imports in lib (the existing CLI-layer `eslint-disable` exceptions stand). Run `pnpm run lint:structure` before each commit.
- Do not run the full agency execution suite locally. Run the specific vitest files named per task; save output with `… 2>&1 | tee /tmp/out.log`.
- Commit after every task; write the message to a file and `git commit -F`; end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- **Branch:** continue on `custom-graders-impl` (the open PR #312). These are follow-up commits on that PR.

**Decisions (settled with the owner):** `expected` is first-class on `Input`; built-in match graders default `matchOn` to `["expected"]`; feed **both** `expected` (grader-agnostic, static) and grader `feedback` (grader-produced, dynamic) into reflection; **no warning** when `expected` is fed without a validation set (the validation set remains the documented guardrail against answer-key hardcoding); add a "don't hardcode the expected answers" instruction to both mutator prompts.

---

## File Structure

- `lib/eval/runTypes.ts` — add `expected?` to `Input`.
- `lib/eval/loadInputs.ts` — pass `expected` through `normalizeInput`.
- `lib/optimize/grading/graders/builtinGraders.ts` — `matchOn` optional, defaults to `["expected"]`.
- `lib/optimize/gepaFeedback.ts` → rename `lib/optimize/reflectionFeedback.ts` (now shared by greedy + GEPA); add an `Expected:` line.
- `lib/optimize/mutator.ts` + `lib/agents/optimize/mutatePrompt.agency` — a `feedback` section + a don't-hardcode instruction (greedy/example path).
- `lib/optimize/optimizers/greedyReflective.ts` — render the champion's per-input feedback and pass it to the mutator.
- `lib/agents/optimize/gepaReflect.agency` — don't-hardcode instruction (GEPA already gets `expected` via the shared renderer).
- `docs/site/cli/eval.md` — document `expected`, the default `matchOn`, and the reflection signals.

---

## Task 1: First-class `expected` on Input + loader + default `matchOn`

**Files:**
- Modify: `lib/eval/runTypes.ts`, `lib/eval/loadInputs.ts`, `lib/eval/loadInputs.test.ts`
- Modify: `lib/optimize/grading/graders/builtinGraders.ts`, `lib/optimize/grading/graders/builtinGraders.test.ts`

- [ ] **Step 1: Add the field.** In `lib/eval/runTypes.ts`, add to `Input` (after `goal`):

```ts
  /** Gold/expected output for this input (any JSON). Read by match graders
   *  (default matchOn) and surfaced to the optimizer's reflection. */
  expected?: any;
```

- [ ] **Step 2: Failing loader test.** In `lib/eval/loadInputs.test.ts`, add:

```ts
  it("passes a first-class expected output through", () => {
    const suitePath = writeJson("with-expected.json", {
      inputs: [{ id: "india", args: { country: "India" }, expected: "New Delhi" }],
    });
    const inputs = loadInputsFromFile(suitePath, () => "india", { requireGoal: false });
    expect(inputs[0].expected).toBe("New Delhi");
  });
```

- [ ] **Step 3: Run; expect failure** (`expected` is dropped). Run: `pnpm test:run lib/eval/loadInputs.test.ts 2>&1 | tee /tmp/t1.log`

- [ ] **Step 4: Pass it through.** In `lib/eval/loadInputs.ts` `normalizeInput`, after the `working_dir` handling and before the `metadata` handling, add (no type restriction — any JSON is a valid gold value):

```ts
  if (spec.expected !== undefined) out.expected = spec.expected;
```

- [ ] **Step 5: Failing grader test.** In `lib/optimize/grading/graders/builtinGraders.test.ts`, add:

```ts
  it("defaults matchOn to ['expected']", async () => {
    const grader = new ExactMatchGrader({});   // no matchOn
    const input: Input = { id: "a", args: {}, expected: "New Delhi" };
    const grade = await grader.run({ input, run: { output: "New Delhi", recordPath: "" }, runAgency: stubRunner });
    expect(grade.score).toEqual({ kind: "binary", pass: true });
    expect(grader.describe()).toContain("expected");
  });
```

- [ ] **Step 6: Run; expect failure** (matchOn required). Run: `pnpm test:run lib/optimize/grading/graders/builtinGraders.test.ts 2>&1 | tee /tmp/t1b.log`

- [ ] **Step 7: Make matchOn optional with a default.** In `builtinGraders.ts`:
  - Change the type: `type MatchOptions = GraderOptions & { matchOn?: JSONPath };`
  - In `MatchGrader`, add a resolver and use it in `describe`/`validateInput`:

```ts
  protected matchPath(): JSONPath {
    return this.options.matchOn ?? ["expected"];
  }

  describe(): string {
    return `${this.name()} (matchOn ${stringify(this.matchPath())})`;
  }

  validateInput(input: Input): void {
    resolveMatch(input, this.matchPath(), this.name());   // throws if unresolved
  }
```
  - Replace the three `_run`/`reference` uses of `this.options.matchOn` with `this.matchPath()`:
    - `ExactMatchGrader.reference`: `return resolveMatch(input, this.matchPath(), this.name());`
    - `ContainsGrader._run`: `const needle = String(resolveMatch(input, this.matchPath(), this.name()));`
    - `SimilarityGrader._run`: `const expected = String(resolveMatch(input, this.matchPath(), this.name()));`

- [ ] **Step 8: Run + typecheck.**

Run: `pnpm test:run lib/eval/loadInputs.test.ts lib/optimize/grading/graders/builtinGraders.test.ts 2>&1 | tee /tmp/t1.log` → PASS
Run: `npx tsc --noEmit` → exit 0; `pnpm run lint:structure`

- [ ] **Step 9: Commit.** (`git commit -F`, msg: "Add first-class Input.expected and default match graders to it")

---

## Task 2: Share the reflection renderer + render `Expected:`

**Files:**
- Rename: `lib/optimize/gepaFeedback.ts` → `lib/optimize/reflectionFeedback.ts` (+ `gepaFeedback.test.ts` → `reflectionFeedback.test.ts`)
- Modify: `lib/optimize/optimizers/gepa.ts` (import path)

- [ ] **Step 1: Rename.** `git mv lib/optimize/gepaFeedback.ts lib/optimize/reflectionFeedback.ts` and `git mv lib/optimize/gepaFeedback.test.ts lib/optimize/reflectionFeedback.test.ts`. Update the test's import to `./reflectionFeedback.js`. In `lib/optimize/optimizers/gepa.ts`, change `from "../gepaFeedback.js"` → `from "../reflectionFeedback.js"`.

- [ ] **Step 2: Failing test for the Expected line.** In `reflectionFeedback.test.ts`, add (mirror the existing test setup for an `InputGrades` entry; the key assertion):

```ts
  it("renders the expected output when the input carries one", () => {
    const entry = {
      input: { id: "india", args: {}, expected: "New Delhi" },
      run: { output: "area is 3.2M km²", recordPath: "" },
      gatesPassed: true,
      grades: [],
    };
    const text = renderInputFeedback(entry as any);
    expect(text).toContain("Expected: New Delhi");
  });
```

- [ ] **Step 3: Run; expect failure.** Run: `pnpm test:run lib/optimize/reflectionFeedback.test.ts 2>&1 | tee /tmp/t2.log`

- [ ] **Step 4: Add the line.** In `reflectionFeedback.ts` `renderInputFeedback`, immediately after the `Output:` push:

```ts
  if (entry.input.expected !== undefined) {
    lines.push(`Expected: ${preview(stringifyOutput(entry.input.expected), 400)}`);
  }
```

- [ ] **Step 5: Run + typecheck + lint.**

Run: `pnpm test:run lib/optimize/reflectionFeedback.test.ts lib/optimize/optimizers/gepa.test.ts 2>&1 | tee /tmp/t2.log` → PASS
Run: `npx tsc --noEmit` → 0; `pnpm run lint:structure`

- [ ] **Step 6: Commit.** (msg: "Share reflection renderer (gepaFeedback→reflectionFeedback) and render Expected")

---

## Task 3: A `feedback` section in the greedy/example mutator prompt

**Files:**
- Modify: `lib/optimize/mutator.ts`, `lib/optimize/mutator.test.ts`
- Modify: `lib/agents/optimize/mutatePrompt.agency`

- [ ] **Step 1: Failing test.** In `lib/optimize/mutator.test.ts`, add (find the existing `buildMutatorSections` test for the exact import/shape and mirror it):

```ts
  it("includes a feedback section when feedback is provided", () => {
    const sections = buildMutatorSections({
      targets: [], inputs: [], history: "", feedback: "### Input india\nExpected: New Delhi",
    });
    expect(sections.feedback).toContain("Expected: New Delhi");
  });
```

- [ ] **Step 2: Run; expect failure** (`feedback` not on the type/sections). Run: `pnpm test:run lib/optimize/mutator.test.ts 2>&1 | tee /tmp/t3.log`

- [ ] **Step 3: Thread `feedback` through `mutator.ts`.**
  - `MutatorPromptInputs`: add `feedback?: string;`
  - `MutatorMessageSections`: add `feedback: string;`
  - `buildMutatorSections`: add `feedback: promptInputs.feedback ?? ""` to the returned object.
  - `defaultCallModel`: pass it as the new agent arg, **after `goals`** (must match the node param order in Step 4):

```ts
      argsString: [
        args.sections.targets,
        args.sections.goals,
        args.sections.feedback,
        args.sections.history,
        args.sections.diagnostics,
      ].map((value) => JSON.stringify(value)).join(", "),
```

- [ ] **Step 4: Update the agent.** In `lib/agents/optimize/mutatePrompt.agency`, add the `feedback` param (after `goals`) and a section + a don't-hardcode instruction:

```
node mutatePrompt(
  targets: string,
  goals: string,
  feedback: string = "",
  history: string,
  diagnostics: string = "",
): OptimizeMutationProposal {
  const prompt = """
  OPTIMIZE TARGETS:
  ${targets}

  GOALS:
  ${goals}

  PER-INPUT FEEDBACK FROM THE LAST RUN (expected answers and grader notes):
  ${feedback}

  ${history}

  YOUR TASK:
  Propose replacement values for one or more of the optimize targets listed above so the agent better achieves the goals and the per-input feedback. Return JSON with:
  - "operations": one record per target you change. Each record needs "target" and "kind" copied exactly from the list above, "op" set to "replaceInitializer", "value" with the replacement as Agency source text including the surrounding quotes, and "rationale" with one sentence on what you changed. The replacement must preserve every interpolation placeholder the current value uses (no drops, no additions).
  - "rationale": 2-4 sentences explaining the overall change.

  Write a general instruction that works for any input of this kind. Do NOT hard-code the specific expected answers shown in the feedback into the value — an answer that only works for these inputs will fail on held-out validation inputs.

  ${diagnostics}
  """
  const proposal: OptimizeMutationProposal = llm(prompt)
  return proposal
}
```

- [ ] **Step 5: Recompile the agent + verify.**

Run: `make agents 2>&1 | tail -3`
Run: `pnpm test:run lib/optimize/mutator.test.ts 2>&1 | tee /tmp/t3.log` → PASS
Run: `npx tsc --noEmit` → 0; `pnpm run lint:structure`

- [ ] **Step 6: Commit.** (msg: "Add a per-input feedback section + don't-hardcode instruction to the mutator prompt")

---

## Task 4: Greedy feeds the champion's expected + feedback to the mutator

**Files:**
- Modify: `lib/optimize/optimizers/greedyReflective.ts`, `lib/optimize/optimizers/greedyReflective.test.ts`

- [ ] **Step 1: Failing test.** In `greedyReflective.test.ts`, add:

```ts
  it("feeds the champion's per-input expected answers and grader feedback to the mutator", async () => {
    let captured: { feedback?: string } | undefined;
    const grader = new (class extends BaseGrader {
      protected readonly defaultName = "g";
      protected _run({ input }: GraderInput): Promise<Grade> {
        return Promise.resolve({ score: { kind: "scalar", value: 0 }, feedback: `wanted ${input.expected}` });
      }
    })();
    const propose = vi.fn(async (a: { feedback?: string }) => { captured = a; return { rationale: "x", operations: [] }; });
    const opt = new GreedyReflective(
      { graders: [grader], iterations: 1, config: {}, runsDir: root, runId: "fb", writeback: false },
      { ...deps(), propose },
    );
    await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: [{ id: "india", args: {}, expected: "New Delhi" }] });
    expect(captured?.feedback).toContain("New Delhi");        // the expected answer surfaced
    expect(captured?.feedback).toContain("wanted New Delhi"); // the grader's feedback surfaced
  });
```

- [ ] **Step 2: Run; expect failure** (`feedback` is undefined in the propose args). Run: `pnpm test:run lib/optimize/optimizers/greedyReflective.test.ts 2>&1 | tee /tmp/t4.log`

- [ ] **Step 3: Render + pass the feedback.** In `greedyReflective.ts`:
  - Import: `import { renderReflectionFeedback } from "../reflectionFeedback.js";`
  - In `attempt(...)`, in the `proposeMutation` args (the call inside `proposeValidMutation`), add `feedback`:

```ts
      (diagnostics) => (this.greedyDeps.propose ?? proposeMutation)({
        config: this.config.config,
        targets: champion.targetSet.targets,
        inputs,
        feedback: renderReflectionFeedback(champion.scorecard.perInput),
        history: renderHistory(history),
        model: this.config.mutatorModel,
        diagnostics,
      }),
```

(`renderReflectionFeedback` degrades gracefully when a trace path is missing — it logs and renders grades-only, so the test's empty `recordPath` is fine.)

- [ ] **Step 4: Run + typecheck + lint.**

Run: `pnpm test:run lib/optimize/optimizers/greedyReflective.test.ts 2>&1 | tee /tmp/t4.log` → PASS
Run: `npx tsc --noEmit` → 0; `pnpm run lint:structure`

- [ ] **Step 5: Commit.** (msg: "Greedy feeds champion expected + grader feedback into the mutator")

---

## Task 5: Don't-hardcode instruction in the GEPA reflect prompt

GEPA already renders `feedback` (now including `Expected:` via Task 2), so it needs only the same guardrail instruction.

**Files:**
- Modify: `lib/agents/optimize/gepaReflect.agency`

- [ ] **Step 1: Add the instruction.** In `lib/agents/optimize/gepaReflect.agency`, in the task/instructions portion of the prompt, add a sentence:

```
Write a general instruction that works for any input of this kind. Do NOT hard-code the specific expected answers shown in the feedback into the value — an answer that only works for these inputs will fail on held-out validation inputs.
```

(Match the surrounding prompt's wording/placement; read the file first to find the instruction block.)

- [ ] **Step 2: Recompile + verify.**

Run: `make agents 2>&1 | tail -3`
Run: `pnpm test:run lib/optimize/optimizers/gepa.test.ts 2>&1 | tee /tmp/t5.log` → PASS (behavior unchanged; this is a prompt-text edit)
Run: `npx tsc --noEmit` → 0

- [ ] **Step 3: Commit.** (msg: "Add don't-hardcode instruction to the GEPA reflect prompt")

---

## Task 6: Docs

**Files:**
- Modify: `docs/site/cli/eval.md`

- [ ] **Step 1: Document the field + behavior.** In `docs/site/cli/eval.md`:
  - In the input-suite description, document `expected` (the gold output for an input; any JSON). Show an input with `expected`:

```json
{ "inputs": [{ "id": "india", "args": { "country": "India" }, "expected": "New Delhi" }] }
```
  - In the Custom graders section, note built-in match graders default `matchOn` to `["expected"]` (so `new ExactMatch({})` compares the output to `input.expected`), and custom graders read `ctx.input.expected`.
  - Add a short paragraph: the optimizer's reflection is fed each input's `expected` answer and each grader's `feedback`, so a self-explaining grader (or labeled `expected` outputs) can drive the search **without** a `--goal`; `--goal` remains an optional steer. Pair with a validation set — the mutator is told not to hard-code expected answers, and held-out validation catches a prompt that memorizes them anyway.

- [ ] **Step 2: Commit.** (msg: "Document Input.expected and reflection signals for the optimizer")

---

## Self-Review

**1. Spec coverage:** `expected` first-class (Task 1) ✓; default `matchOn:["expected"]` (Task 1) ✓; both signals to reflection — `expected` via the shared renderer for GEPA + greedy (Tasks 2, 4), grader `feedback` via the same renderer (Task 4) and already in GEPA ✓; don't-hardcode instruction in both prompts (Tasks 3, 5) ✓; no warning on missing validation (omitted by decision) ✓; docs (Task 6) ✓.

**2. Placeholder scan:** every code step shows full code or the exact edit; agent edits flagged with `make agents`; no "TBD".

**3. Type consistency:** `Input.expected?: any`; `MatchOptions.matchOn?`; `MatchGrader.matchPath()`; `MutatorPromptInputs.feedback?`/`MutatorMessageSections.feedback`; `renderReflectionFeedback` (from `reflectionFeedback.js`); `mutatePrompt(targets, goals, feedback, history, diagnostics)` param order matches `defaultCallModel`'s argsString — consistent across tasks.

**4. Anti-patterns:** reuses the shared `renderReflectionFeedback` for both optimizers (no duplication); `matchPath()` is one accessor (no repeated `?? ["expected"]`); `expected` is read grader-agnostically while `feedback` flows through the existing uniform `Grade.feedback` channel (no per-grader branching).

**Note:** Tasks 3 and 5 both edit `.agency` agents and run `make agents` — that recompile is the easy step to forget; each task includes it explicitly.
