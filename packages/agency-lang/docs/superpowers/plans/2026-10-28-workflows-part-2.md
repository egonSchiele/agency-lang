# Workflows, Part 2: Running a Workflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The owner prefers one agent working inline, so do not use subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `runWorkflow` runs a checked workflow's generated program in a subprocess, behind a `std::workflow::run` prompt. The generated program checks its inputs with `!`, sends string context to the model as text, and puts a guard around any step that has its own limits.

**Architecture:** Part 1's four stages stay as they are. Parse learns step limits and refuses limits that are not positive. Resolve records two new facts per step: whether its local holds a `Result`, and its limits. Lower writes a guarded call from new rows in the `SHAPES` table. `stdlib/workflow.agency` gains `runWorkflow`, which runs the program that the check compiled, through `run` from `std::agency`. No new runtime code. Task 1, a type checker fix, is done and open as its own PR, #1298.

**Tech Stack:** Agency stdlib conventions, Template Agency's TypeScript twins (`lib/stdlib/template.ts`), `std::agency`'s `compile`, `typecheck`, and `run`, zod v4 in parse, vitest for the TypeScript stages, Agency execution tests for the Agency side, and the deterministic LLM client (`useTestLLMProvider` with `llmMocks`) for the one LLM step.

**Spec:** [/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-workflows-2/packages/agency-lang/docs/superpowers/specs/2026-10-26-workflows-design.md](/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-workflows-2/packages/agency-lang/docs/superpowers/specs/2026-10-26-workflows-design.md) (`docs/superpowers/specs/2026-10-26-workflows-design.md` in the repo). Read decisions 16 to 25, "The generated program", "Running a workflow", and "The parts" before starting. Part 1's plan, `docs/superpowers/plans/2026-10-27-workflows-mvp.md`, explains the stages, and `docs/dev/stdlib/workflow.md` is their dev doc.

## Before you start

Both prerequisite fixes are done:

1. **#1297, nodes check `!` parameters.** Merged into main. Without it, `main(inputs: Inputs!)` would compile but check nothing. Tasks 6 and 7 need it, and this branch was cut before it merged, so merge main into this branch before Task 6.
2. **Task 1 of this plan, the guard type.** Done, and open for review as #1298 (branch `adit/guard-result-type`). Task 5 needs it merged.

Tasks 2, 3, and 4 need neither and can start at once. Build the worktree with `make` once before the first Agency test.

## Background for someone new to this codebase

- **How part 1 builds a program.** `compileWorkflowSource` in `lib/stdlib/workflow/index.ts` runs parse, resolve, lower, and render. Every statement the generator writes comes from a row of `SHAPES` in `lib/stdlib/workflow/shapes.ts`, through `statement()` or `expression()`. A `{{name}}` token takes a name and is checked as an identifier (or against a fixed list of forms, such as `TOKEN_CHECKS.options`). A `#name` hole takes a `Code` value, and `literal(value)` lifts workflow data so it is never parsed. Every name the program declares comes from `names(id)` in `lib/stdlib/workflow/resolve.ts` and must also be listed by `declaredBy`, so `collisionRule` can refuse two that coincide. That is what keeps template hygiene from renaming anything (`docs/dev/stdlib/workflow.md`, "Why the scaffold is fixed text").
- **How `run` returns.** `run(compiled, node, args, wallClock: ...)` in `stdlib/agency.agency:178` raises `std::run`, starts the child, and succeeds with an envelope whose `.data` is what the node returned. `runTool` in `stdlib/toolbox.agency:1853` shows the unwrap: `if (ran is success(finished)) { result = finished.data }`. The node's `Result` crosses the process boundary as JSON, and `is failure` works on it. The default wall clock is 60 seconds and the ceiling is one hour (`_runOptions`, `stdlib/agency.agency:118`).
- **How a child's interrupt reaches a person.** `docs/dev/runtime/subprocess-ipc.md`. The parent's handlers answer the child's interrupts. One that no handler answers pauses the child, which saves a checkpoint and exits. The interrupt then surfaces like any other, and a resume starts a fresh child from the checkpoint. A handler that returns nothing passes (`docs/site/guide/handlers.md:207`), so a test can approve the gates it expects and let everything else surface.
- **How a guard behaves.** `docs/site/guide/guards.md`. `guard(label: "x", time: 120000, cost: 5) { ... }` returns a `Result`. At run time a block that returns a `Result` passes it through unchanged, and any other value is wrapped in `success(...)`. A trip raises `std::guard`. Rejecting it makes the guard return a failure whose `data.type` is `"timeoutFailure"` or `"guardFailure"`. A negative limit turns that dimension off (`stdlib/agency.agency:259`), which is why parse refuses one. Checked on 2026-10-28: the type checker types a guard around a `Result`-returning call as `Result<Result<T>>`, while the runtime gives the call's own `Result`. Task 1 (#1298) fixes the type checker, including a `Result` named by a type alias and a block that returns a `Result` on one path and a plain value on another.
- **How effects get "always" answers.** `@alwaysUnder(dir)` and `@always(name)` above an `effect` declaration pick the fields an "always" answer pins. `std::uploadImage` (`stdlib/image.agency:37`) carries both kinds, which is the precedent for `std::workflow::run`.
- **Context values as text.** Checked on 2026-10-28: `if v is string then v else JSON.stringify(v)` typechecks for a `string`, a `string[]`, an object, and a value read through a narrowed `Result`. It produces the text itself for a string (line breaks intact) and JSON for anything else.
- **Mocking the model in a test.** `docs/misc/TESTING.md`, "Deterministic LLM mode". A test case with `"useTestLLMProvider": true` and `"llmMocks": [{ "return": ["soup", "salad"] }]` answers each `llm()` call in order, including calls made in a child process (`tests/agency/subprocess/cost-child-spend-in-getcost.test.json`).
- **Counting what a handler saw.** `tests/helpers/mutableVar.js` exports `getMutable(key, default)` and `setMutable(key, value)`, which a test handler uses to record effects and payloads in the parent process.

## Global Constraints

- The format version stays `1`. Step `limits` is a new optional field, not a new kind.
- A limit is a positive finite number. `maxTime` is at most 3570000 (one hour less 30 seconds). The subprocess wall clock is `maxTime + 30000`, or `null` when the workflow has no `maxTime`, which gives `run` its own default of 60 seconds. The workflow code never restates `run`'s default or ceiling: both come from `LIMIT_CEILINGS` and `run`.
- `std::workflow::run` is declared `{ name: string; dir: string; inputs: Json }` with `@alwaysUnder(dir)` and `@always(name)`.
- `runWorkflow` checks, then raises `std::workflow::run`, then calls `run` on the program the check compiled. It never compiles twice.
- Every generated statement comes from a `SHAPES` row through `statement()` or `expression()`. Every generated name comes from `names(id)` and is listed by `declaredBy`. The text of a guard's limits is written by one helper, `guardArgs` in `shapes.ts`, for the workflow guard and the step guard alike.
- No new code under `lib/runtime/`, except exporting the existing `LIMIT_CEILINGS` from `lib/runtime/ipc.ts`. No `fs` import in `lib/stdlib/workflow/`.
- No test makes a real model call. An LLM step in a test runs under `useTestLLMProvider` with `llmMocks`.
- Before each commit: `pnpm run typecheck`, `pnpm run lint:structure`, and `npx prettier --check` on the changed TypeScript files. Run `make` after a change to a `stdlib/*.agency` file and before an Agency test that imports it.
- Save every test run's output to a file and read the file. Run only the tests named in a step, plus the workflow tests (`npx vitest run lib/stdlib/workflow`, `tests/agency/workflow/`). CI runs the rest.

## Review Focus

1. **Inputs that are not an object.** `runWorkflow(wf, "x", ...)` or `null` must fail before the first step, with the message naming `inputs`. Pinned in Task 7 (`inputsThatAreNotAnObject`).
2. **A limit at the cap.** `maxTime: 3570000` is accepted and gives a wall clock of exactly 3600000, `run`'s ceiling. `3570001` is refused. Pinned in Task 2.
3. **A reference into a guarded step whose tool returns a plain value.** The guard wraps the value, so `steps.lines[0]` must read `step_lines.value[0]` and typecheck. Pinned in Task 5 (`guardedPlainStepIsReadThroughValue`).
4. **A resume re-running finished steps.** After a pause in the last step, a resume must not repeat the LLM step. The test gives exactly one mock, so a second model call fails the test. Pinned in Task 8 (`pausedWorkflowResumes`).
5. **A rejected run prompt.** Rejecting `std::workflow::run` must start no subprocess, so `std::run` is never raised. Pinned in Task 7 (`rejectedRunStartsNothing`).

---

## File structure

- Modify `lib/typeChecker/synthesizer.ts` and `lib/typeChecker/guardConstruct.test.ts` (Task 1, its own PR), plus one sentence in `docs/dev/runtime/interrupts.md`.
- Create `lib/stdlib/workflow/limits.ts` and `limits.test.ts`: `MAX_TIME`, `WALL_CLOCK_HEADROOM`, and `wallClockFor`. Export `LIMIT_CEILINGS` from `lib/runtime/ipc.ts`.
- Modify `lib/stdlib/workflow/types.ts`, `parse.ts`, `tools.ts`, `resolve.ts`, `shapes.ts`, `lower.ts`, `render.ts`, `index.ts`, and their tests.
- Modify `stdlib/workflow.agency`: the `std::workflow::run` effect, `_checked`, `checkWorkflow` on top of it, and `runWorkflow`.
- Modify `tests/agency/workflow/fixtures/tools/lists.agency` (`addListItems` raises an interrupt). Create `tests/agency/workflow/fixtures/tools/slow.agency`.
- Create `tests/agency/workflow/run.agency` and `run.test.json`, and `runMealPlan.agency` and `runMealPlan.test.json`. Extend `compile.agency`, `compile.test.json`, `check.agency`, and `check.test.json`.
- Modify `docs/dev/stdlib/workflow.md`, its line in `CLAUDE.md`, and its line in `.claude/skills/agency-stdlib-docs/SKILL.md`.

---

### Task 1: A guard around a `Result` has that `Result`'s type (its own PR)

**Status: done.** Open for review as #1298 (branch `adit/guard-result-type`, worktree `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-guard-type`). The PR goes further than Step 3: `guardSuccessType` resolves type aliases and takes the success type from each `Result` among the block's returns, and the failure side stays `any`, because a trip fails with the guard's own data.

**Files:**
- Modify: `lib/typeChecker/synthesizer.ts:873` (the `_guard` row of `BLOCK_CALL_RESULT`)
- Test: `lib/typeChecker/guardConstruct.test.ts`
- Doc: `docs/dev/runtime/interrupts.md`, section "The guard construct (guard keyword)"

Branch `adit/guard-result-type` from main, in its own worktree under `packages/agency-lang`.

**Interfaces:**
- Produces: a `guard` whose block returns a `Result<T>` has type `Result<T>`. A block returning anything else, including `any`, keeps today's `Result<element>`.

- [x] **Step 1: Write the failing test** in the `describe("guard construct — Result<T> typing ...")` block:

```ts
it("passes a Result the block returns through, as try does", () => {
  const src = (annotation: string) => `def f(): Result<number> { return success(1) }
node main() {
  const r = guard(cost: $1) { return f() }
  if (isSuccess(r)) { const v: ${annotation} = r.value\n return "ok" }
  return "f"
}`;
  expect(matching(src("number"), /not assignable/)).toHaveLength(0);
  expect(matching(src("string"), /not assignable/).length).toBeGreaterThan(0);
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/typeChecker/guardConstruct.test.ts > /tmp/wf2-t1.txt 2>&1; tail -20 /tmp/wf2-t1.txt`
Expected: FAIL. The `number` case reports `Result<number>` is not assignable to `number`.

- [x] **Step 3: Change the `_guard` row** to return `element` unchanged when `element.type === "resultType"`, the way `synthTryExpression` does at `synthesizer.ts:625`. Keep the wrap for every other element. Update the row's comment to say a returned `Result` passes through, matching the runtime.

- [x] **Step 4: Run the type checker tests, rebuild, and run the guard Agency tests**

Run: `npx vitest run lib/typeChecker > /tmp/wf2-t1.txt 2>&1; tail -5 /tmp/wf2-t1.txt; make > /tmp/wf2-make.txt 2>&1; tail -3 /tmp/wf2-make.txt; pnpm run agency test tests/agency/guards > /tmp/wf2-t1-agency.txt 2>&1; tail -5 /tmp/wf2-t1-agency.txt`
Expected: all pass. `make` typechecks the stdlib, so a stdlib file that relied on the nested type shows up here.

- [x] **Step 5: Add one sentence to the guard construct section** of `docs/dev/runtime/interrupts.md`: the construct's type is `Result<T>` with `T` from the block's returns, and a block that returns a `Result` gives that `Result`'s type, because the runtime passes it through, as `try` does.

- [x] **Step 6: Commit, push, and open the PR.** Write the message and the PR description to files and pass them with `-F` and `--body-file`.

---

### Task 2: Limits are positive, capped, and allowed on a step

**Files:**
- Create: `lib/stdlib/workflow/limits.ts`, `lib/stdlib/workflow/limits.test.ts`
- Modify: `lib/stdlib/workflow/types.ts` (`ToolStep`, `LlmStep`), `lib/stdlib/workflow/parse.ts` (the `limits` schema, `toolStep`, `llmStep`)
- Test: `lib/stdlib/workflow/parse.test.ts`

**Interfaces:**
- Produces in `limits.ts`: `export const WALL_CLOCK_HEADROOM = 30000`, `export const MAX_TIME = LIMIT_CEILINGS.wallClock - WALL_CLOCK_HEADROOM` (so the cap follows `run`'s ceiling instead of restating it), and `export function wallClockFor(limits: Limits | null): number | null`, which returns `limits.maxTime + WALL_CLOCK_HEADROOM` when `maxTime` is set and `null` otherwise. `run` reads `null` as its default, so the 60-second default is stated once, in `run`. `LIMIT_CEILINGS` in `lib/runtime/ipc.ts` becomes `export const`; nothing else there changes.
- Produces in `types.ts`: `ToolStep.limits?: Limits | null` and `LlmStep.limits?: Limits | null`.
- Parse rules: each limit field is a finite number greater than 0, and `maxTime` is at most `MAX_TIME`. The same schema checks the workflow's `limits` and a step's. Messages: `limits.<field> must be a positive number` and `limits.maxTime must be at most 3570000 (one hour less 30 seconds)`. A step's problem names that step and the field `limits.<field>`.

- [ ] **Step 1: Write the failing tests**

In `limits.test.ts`: `wallClockFor({ maxTime: 300000 })` is `330000`, `wallClockFor({ maxCost: 1 })` is `null`, `wallClockFor(null)` is `null`, `wallClockFor({ maxTime: MAX_TIME })` is `LIMIT_CEILINGS.wallClock`, and `MAX_TIME` is `3570000`.

In `parse.test.ts`, using part 1's `withStep` helper:
- `limits: { maxCost: -1 }` gives `{ step: null, field: "limits.maxCost", message: "limits.maxCost must be a positive number" }`.
- `limits: { maxTime: 0 }` gives the same message for `maxTime`.
- `limits: { maxTime: 3570001 }` gives `limits.maxTime must be at most 3570000 (one hour less 30 seconds)`, and `3570000` parses.
- A tool step with `limits: { maxTime: 120000, maxCost: 5 }` parses, and the parsed step carries them.
- A step with `limits: { maxTime: -5 }` gives `{ step: "add", field: "limits.maxTime", ... }`.
- A step with `limits: { retries: 3 }` gives part 1's unknown-field message on that step.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/stdlib/workflow/limits.test.ts lib/stdlib/workflow/parse.test.ts > /tmp/wf2-t2.txt 2>&1; tail -30 /tmp/wf2-t2.txt`
Expected: FAIL. `limits.ts` does not exist, negative limits parse, and a step's `limits` is stripped.

- [ ] **Step 3: Implement.** Write `limits.ts`. In `parse.ts`, replace `finite` with a refinement for a positive finite number, add the `MAX_TIME` refinement for `maxTime`, and add `limits` (the same schema) to `toolStep` and `llmStep`.

- [ ] **Step 4: Run the workflow unit tests**

Run: `npx vitest run lib/stdlib/workflow > /tmp/wf2-t2.txt 2>&1; tail -5 /tmp/wf2-t2.txt`
Expected: PASS.

- [ ] **Step 5: Format, typecheck, lint, and commit.**

---

### Task 3: The check reports every bad tool, and warns on a `Json` return

**Files:**
- Modify: `lib/stdlib/workflow/tools.ts` (`toolRefs`), `lib/stdlib/workflow/index.ts` (`_toolRefs`), `lib/stdlib/workflow/resolve.ts` (`UNTYPED_RETURNS`, `untypedWarnings`), `stdlib/workflow.agency` (`_compileWithRanges`)
- Test: `lib/stdlib/workflow/tools.test.ts`, `lib/stdlib/workflow/resolve.test.ts`, `tests/agency/workflow/check.agency` and `check.test.json`

**Interfaces:**
- Produces in `tools.ts`: `export type ToolRefsResult = { refs: ToolRef[]; problems: [] } | { refs: null; problems: Problem[] }`, the same shape as `ParseResult` and `ResolveResult`, and `toolRefs(tools: unknown[], dir: string, cwd: string): ToolRefsResult`. Each tool that cannot be imported adds one problem, `{ step: null, field: null, message }`, with part 1's message for that tool. When every tool can be imported, the duplicate-name check runs, and its message becomes one problem.
- Produces in `index.ts`: `_toolRefs(tools: unknown[], dir: string): ResultSuccess | ResultFailure`, a success with the refs or `_problemsFailure(problems)`, the same turn `_compileWorkflowSource` makes for `CompileResult`.
- `stdlib/workflow.agency`: `_compileWithRanges` calls `_toolRefs` without `try`, and passes a failure through with `failure(refs.error, refs.data)`.
- Resolve: `UNTYPED_RETURNS` becomes `[null, "any", "Json"]`. The warning for `null` keeps its words. For `any` and `Json` the message is `step "<id>": "<tool>" returns <type>, so references into its value are checked at run time`.

- [ ] **Step 1: Write the failing tests**

In `tools.test.ts`, with part 1's `fn(name, module)` helper: `toolRefs([fn("a", "agent/a.agency").partial({ q: "x" }), fn("b", "agent/b.agency").rename("c")], DIR, CWD).problems` holds two problems, with the messages `tool "a" is a partial; pass the original def` and `tool "c" is renamed from "b"; pass the original def`, in that order. Part 1's tests that expect `toThrow` (`tools.test.ts:62-110`) become the same kind of assertion on `problems`.

In `resolve.test.ts`: a tool whose signature has `returnType: "Json"` gets the warning `step "note": "searchNotes" returns Json, so references into its value are checked at run time`.

In `check.agency`, a node `everyBadToolIsReported` that checks a workflow with two bad tools in the list and returns the problem count. In `check.test.json`, expect `2`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/stdlib/workflow/tools.test.ts lib/stdlib/workflow/resolve.test.ts > /tmp/wf2-t3.txt 2>&1; tail -30 /tmp/wf2-t3.txt`
Expected: FAIL. `toolRefs` throws on the first tool, and `Json` gets no warning.

- [ ] **Step 3: Implement** the interfaces above.

- [ ] **Step 4: Rebuild and run the tests**

Run: `make > /tmp/wf2-make.txt 2>&1; tail -3 /tmp/wf2-make.txt; npx vitest run lib/stdlib/workflow > /tmp/wf2-t3.txt 2>&1; tail -5 /tmp/wf2-t3.txt; pnpm run agency test tests/agency/workflow/check.agency > /tmp/wf2-t3-agency.txt 2>&1; tail -5 /tmp/wf2-t3-agency.txt`
Expected: PASS.

- [ ] **Step 5: Format, typecheck, lint, and commit.**

---

### Task 4: A string context value reaches the model as its text

**Files:**
- Modify: `lib/stdlib/workflow/types.ts` (`ResolvedLlmStep.bindings`), `lib/stdlib/workflow/resolve.ts` (`names`, `declaredBy`, `resolveLlmStep`), `lib/stdlib/workflow/shapes.ts` (`SHAPES`), `lib/stdlib/workflow/lower.ts` (`llmFragments`, `promptCode`)
- Test: `lib/stdlib/workflow/lower.test.ts`, `lib/stdlib/workflow/resolve.test.ts`, `lib/stdlib/workflow/index.test.ts`, `tests/agency/workflow/compile.agency` and `compile.test.json`

**Interfaces:**
- Produces in `types.ts`: `export type ContextBinding = Binding & { text: string }`, and `ResolvedLlmStep.bindings: ContextBinding[]`.
- Produces in `resolve.ts`: `names(id).contextText(index)` is `step_<id>_context<index + 1>_text`. `declaredBy` lists each text local with field `context[<index>]` and the description `the text of context value <index + 1> of step "<id>"`.
- `SHAPES.contextText`: `const {{local}} = if {{value}} is string then {{value}} else JSON.stringify({{value}})`. Delete `SHAPES.stringify`, which nothing else uses.
- Lower: after each context binding's fragment, a `contextText` fragment with the same owner. The prompt fold appends the text local in place of `JSON.stringify(<local>)`.

- [ ] **Step 1: Write the failing tests**

`lower.test.ts`: the meal plan's `meals` step lowers to `const step_meals_context1 = step_text.value.body`, then `const step_meals_context1_text = if step_meals_context1 is string then step_meals_context1 else JSON.stringify(step_meals_context1)`, then the `thread` whose prompt ends `+ step_meals_context1_text`. Update part 1's expected lines in `lower.test.ts:86` and `index.test.ts:53` to match.

`resolve.test.ts`: a step with id `meals_context1_text`, after a step `meals` with one context value, is refused with the message `step id "meals_context1_text" produces the same local as the text of context value 1 of step "meals"`.

`compile.agency`: a node `contextTextTypechecks` that gives the `meals` step three context values (`steps.text.body`, a string; `steps.list`, a list; `steps.text`, an object) and returns `typechecks(sourceOf(workflow))`. Expect `true` in `compile.test.json`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/stdlib/workflow > /tmp/wf2-t4.txt 2>&1; tail -30 /tmp/wf2-t4.txt`
Expected: FAIL on the new expected lines and the collision.

- [ ] **Step 3: Implement** the interfaces above.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/stdlib/workflow > /tmp/wf2-t4.txt 2>&1; tail -5 /tmp/wf2-t4.txt; pnpm run agency test tests/agency/workflow/compile.agency > /tmp/wf2-t4-agency.txt 2>&1; tail -5 /tmp/wf2-t4-agency.txt`
Expected: PASS.

- [ ] **Step 5: Format, typecheck, lint, and commit.**

---

### Task 5: A step with limits runs inside a guard

Needs #1298 (Task 1) merged into main, and main merged into this branch.

**Files:**
- Modify: `lib/stdlib/workflow/types.ts`, `lib/stdlib/workflow/resolve.ts`, `lib/stdlib/workflow/shapes.ts`, `lib/stdlib/workflow/lower.ts`, `lib/stdlib/workflow/render.ts` (`guardArgs` moves out)
- Test: `lib/stdlib/workflow/resolve.test.ts`, `lib/stdlib/workflow/shapes.test.ts`, `lib/stdlib/workflow/lower.test.ts`, `tests/agency/workflow/compile.agency` and `compile.test.json`

**Interfaces:**
- Produces in `types.ts`: `ResolvedToolStep` replaces `returnsResult` with `holdsResult: boolean` and gains `limits: Limits | null`. `ResolvedLlmStep` gains `holdsResult: boolean`, `limits: Limits | null`, and `reply: string`. `holdsResult` means the step's local holds a `Result`: for a tool step, the tool returns one or the step has limits; for an LLM step, the step has limits.
- Resolve: a step's `limits` with neither field is `null`. `names(id).reply` is `step_<id>_reply`, listed by `declaredBy` (field `limits`) for an LLM step with limits. Add `"guard"` to `PROGRAM_NAMES`.
- `guardArgs(limits: Limits): string[]` moves from `render.ts` to `shapes.ts` and is exported. It returns the pieces `time: <n>` and `cost: <n>` for the limits that are set, each number printed through `literal`, as today. Render joins them with `, ` for the workflow guard, as it does now. Lower prefixes each with `, ` for a step guard. This is the one place that writes a limit into code.
- `SHAPES` gains three small rows that compose with the rows part 1 has:
  - `guarded`: `const {{value}} = guard(label: #label{{limits}}) {\n  #body\n}`. `#body` is a statements hole; `_fill` spreads a multi-statement `Code` into a block body (`docs/dev/language/template-agency.md`, "substituteInArray").
  - `returnCall`: `return {{tool}}({{args}})`
  - `returnLocal`: `return {{name}}`
- `TOKEN_CHECKS.limits` accepts the empty string or `, ` followed by what `guardArgs` prints: each piece `time: <n>` or `cost: <n>`, `<n>` a text `Number()` reads as a finite number, joined by `, `. `#label` is `literal(step.id)`.
- Lower: the body of a guarded tool step is `returnCall`. The body of a guarded LLM step is part 1's `llm` statement with `value: step.reply`, then `returnLocal` with `name: step.reply`; the reply is declared inside the guard so the structured-output schema still comes from the output type. Both bodies go into `guarded` as `#body`. A guarded step always holds a `Result`, so both are followed by part 1's `check`, with `tool` set to the tool's name for a tool step and to `llm` for an LLM step, so the message reads `step meals (llm): ...`. There is no separate guarded check shape. A tool step's two fragments are owned by `{ step, field: "args" }`; an LLM step's by `{ step, field: "prompt" }`. A reference into a step reads `.value` when `target.holdsResult`. The check after an unguarded tool call picks `check` or `checkPlain` by `holdsResult`, as it did by `returnsResult`.
- Hygiene: `guarded` binds only `{{value}}`. A body never mentions its own step's value local (a tool body names arg locals, an LLM body names the reply and context locals, and `collisionRule` keeps `step_<id>_reply` distinct from `step_<id>`), so `fill` renames nothing. The shapes test below pins the printed text so a hygiene rename would show up as a changed line.

- [ ] **Step 1: Write the failing tests**

`shapes.test.ts`: `guardArgs({ maxTime: 120000, maxCost: 5 })` is `["time: 120000", "cost: 5"]`. `statement("guarded", { value: "step_add", limits: ", time: 120000" }, { label: literal("add"), body: statement("returnCall", { tool: "addListItems", args: "items: step_add_items" }, {}) })` prints `const step_add = guard(label: "add", time: 120000) {` then `  return addListItems(items: step_add_items)` then `}`. The same with a two-statement body (an `llm` statement then `returnLocal`) prints both statements inside the braces, which pins that `_fill` spreads the body. `limits: ", retries: 3"` and `limits: ", time: abc"` throw.

`lower.test.ts`: the meal plan with `limits: { maxTime: 120000, maxCost: 5 }` on `add` lowers that step to the guarded call and a `check`. With `limits: { maxTime: 60000 }` on `meals`, it lowers to a guard whose body declares `step_meals_reply` and returns it, then a `check` whose message starts `step meals (llm):`. `guardedPlainStepIsReadThroughValue`: a step `lines` calling `splitLines` with limits, then a step whose argument is `steps.lines[0]`, binds `const step_next_text = step_lines.value[0]`.

`resolve.test.ts`: `limits: {}` resolves to `null`. `splitLines` with limits has `holdsResult: true`, and without limits `holdsResult: false`.

`compile.agency`: a node `guardedStepsTypecheck` with limits on `add`, on `meals`, and on a `lines` step calling `splitLines` that a later step reads as `steps.lines[0]`. It returns `typechecks(sourceOf(workflow))`. Expect `true`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/stdlib/workflow > /tmp/wf2-t5.txt 2>&1; tail -30 /tmp/wf2-t5.txt`
Expected: FAIL. The shapes do not exist, and `holdsResult` is undefined.

- [ ] **Step 3: Implement** the interfaces above. Rename part 1's uses of `ResolvedToolStep.returnsResult` in `lower.ts` and the tests. `Signature.returnsResult` keeps its name, because it is `describe`'s fact about the tool.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/stdlib/workflow > /tmp/wf2-t5.txt 2>&1; tail -5 /tmp/wf2-t5.txt; pnpm run agency test tests/agency/workflow/compile.agency > /tmp/wf2-t5-agency.txt 2>&1; tail -5 /tmp/wf2-t5-agency.txt`
Expected: PASS. If `guardedStepsTypecheck` fails with a `Result<Result<...>>` error, #1298 is not on this branch.

- [ ] **Step 5: Format, typecheck, lint, and commit.**

---

### Task 6: `main` checks its inputs

#1297 is merged into main. This branch was cut before it, so merge main into this branch before this task.

**Files:**
- Modify: `lib/stdlib/workflow/render.ts` (`SCAFFOLD`, `GUARDED_SCAFFOLD`)
- Test: `lib/stdlib/workflow/render.test.ts`, `lib/stdlib/workflow/index.test.ts`, `tests/agency/workflow/compile.agency`

**Interfaces:**
- Produces: both scaffolds declare `export node main(inputs: Inputs!): Result {`.

- [ ] **Step 1: Update the expected lines** in `render.test.ts:43`, `render.test.ts:79`, `index.test.ts:15`, and the pieces in `compile.agency:116` to `export node main(inputs: Inputs!): Result {`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/stdlib/workflow/render.test.ts lib/stdlib/workflow/index.test.ts > /tmp/wf2-t6.txt 2>&1; tail -20 /tmp/wf2-t6.txt`
Expected: FAIL on the scaffold line.

- [ ] **Step 3: Change both scaffolds.**

- [ ] **Step 4: Run the workflow unit tests and both Agency workflow tests**

Run: `npx vitest run lib/stdlib/workflow > /tmp/wf2-t6.txt 2>&1; tail -5 /tmp/wf2-t6.txt; pnpm run agency test tests/agency/workflow > /tmp/wf2-t6-agency.txt 2>&1; tail -5 /tmp/wf2-t6-agency.txt`
Expected: PASS. Task 7 tests that the check runs.

- [ ] **Step 5: Format, typecheck, lint, and commit.**

---

### Task 7: `runWorkflow`

**Files:**
- Modify: `lib/stdlib/workflow/index.ts` (`Compiled`, `compileWorkflowSource`), `stdlib/workflow.agency`
- Test: `lib/stdlib/workflow/index.test.ts`, `tests/agency/workflow/run.agency`, `tests/agency/workflow/run.test.json`

**Interfaces:**
- Produces in `index.ts`: `Compiled.wallClock: number | null`, set to `wallClockFor(resolved.limits)`.
- Produces in `stdlib/workflow.agency`:
  - The effect, declared after the imports with a comment saying what an "always" answer pins:

    ```ts
    @alwaysUnder(dir)
    @always(name)
    effect std::workflow::run {
      name: string;
      dir: string;
      inputs: Json
    }
    ```

  - The import from `std::agency` adds `run` and `CompiledProgram`.
  - `type Checked = { program: CompiledProgram; warnings: WorkflowProblem[]; wallClock: number | null }`, and the Agency `Compiled` type gains `wallClock: number | null`.
  - `@hidden @capabilities(fileRead) export def _checked(workflow: Workflow, tools: any[], dir: string): Result<Checked, WorkflowFailure>`: today's `checkWorkflow` body, succeeding with the compiled program, the warnings, and the wall clock.
  - `checkWorkflow` becomes `_checked` plus `success(checked.value.warnings)`. Its signature and behavior do not change.
  - `@capabilities(fileRead, fileWrite, subprocess) export def runWorkflow(workflow: Workflow, inputs: Json, tools: any[], dir: string = ""): Result<Json>`. It calls `_checked` and passes a failure through. Then it raises `return interrupt std::workflow::run("Run the workflow ${workflow.name}?", { name: workflow.name, dir: dir, inputs: inputs })`. Then it calls `run(compiled: checked.value.program, node: "main", args: { inputs: inputs }, wallClock: checked.value.wallClock)` and returns `finished.data` from a success, or the failure. The docstring's first line: `Run a workflow: check it, ask to run it, and run its program in a subprocess.` Then one `@param` line each.

- [ ] **Step 1: Write the failing tests**

`index.test.ts`: the compiled meal plan has `wallClock: 330000`, and with no limits `null`.

`run.agency` imports `runWorkflow` and `Workflow` from `std::workflow`, `add` and `multiply` from `std::math`, and the mutable helpers. A helper `doubleSum(limits: Json): Workflow` builds `{ format: 1, name: "doubleSum", description: "Add two numbers and double the sum.", inputs: "{ a: number; b: number }", steps: [sum, doubled], result: { "$ref": "steps.doubled" } }`, with `limits` when given. Step `sum` calls `add` from `std::math` with `{ a: { "$ref": "inputs.a" }, b: { "$ref": "inputs.b" } }`. Step `doubled` calls `multiply` with `{ a: { "$ref": "steps.sum" }, b: 2 }`. Every node starts with `setMutable("effects", [])`, since cases may share a process, and wraps its call in `handle { ... } with (intr) { ... }`, which appends `intr.effect` to the mutable list `"effects"`, saves `intr.data` under its effect name, and approves.

| Node | What it does | Expected output |
| --- | --- | --- |
| `mathWorkflowRuns` | run with `{ a: 2, b: 3 }`, return `result.value` | `10` |
| `runPayload` | return the saved `std::workflow::run` data | `{"name":"doubleSum","dir":"","inputs":{"a":2,"b":3}}` |
| `wallClockFromMaxTime` | run with `limits: { maxTime: 300000 }`, return the saved `std::run` `limits.wallClock` | `330000` |
| `defaultWallClock` | run with no limits, same read; `run` fills its default before it raises `std::run` (`stdlib/agency.agency:241`) | `60000` |
| `badWorkflowAsksNothing` | run a workflow whose step names `subtract`, which is not passed; return `[isFailure(result), getMutable("effects", [])]` | `[true,[]]` |
| `rejectedRunStartsNothing` | the handler rejects `std::workflow::run`; return `[isFailure(result), getMutable("effects", [])]` | `[true,["std::workflow::run"]]` |
| `badInputsFailBeforeFirstStep` | run with `{ a: "two", b: 3 }`; return whether the error starts with `Argument "inputs" of main` | `true` |
| `inputsThatAreNotAnObject` | run with `"x"`; same check | `true` |

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/stdlib/workflow/index.test.ts > /tmp/wf2-t7.txt 2>&1; tail -20 /tmp/wf2-t7.txt; pnpm run agency test tests/agency/workflow/run.agency > /tmp/wf2-t7-agency.txt 2>&1; tail -20 /tmp/wf2-t7-agency.txt`
Expected: FAIL. `wallClock` is missing, and `runWorkflow` does not exist.

- [ ] **Step 3: Implement** the interfaces above, then run `make`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/stdlib/workflow > /tmp/wf2-t7.txt 2>&1; tail -5 /tmp/wf2-t7.txt; pnpm run agency test tests/agency/workflow > /tmp/wf2-t7-agency.txt 2>&1; tail -8 /tmp/wf2-t7-agency.txt`
Expected: PASS. If the two input tests fail with a success, #1297 is not on this branch.

- [ ] **Step 5: Format, typecheck, lint, and commit.**

---

### Task 8: The meal plan runs, stops on a rejection, pauses and resumes, and a step limit trips

**Files:**
- Modify: `tests/agency/workflow/fixtures/tools/lists.agency`
- Create: `tests/agency/workflow/fixtures/tools/slow.agency`, `tests/agency/workflow/runMealPlan.agency`, `tests/agency/workflow/runMealPlan.test.json`

**Interfaces:**
- `lists.agency` declares `effect test::lists::add { listId: string; section: string }`. `addListItems` raises `return interrupt test::lists::add("Add ${items.length} items to ${listId}?", { listId: listId, section: section })` before it returns.
- `slow.agency` exports `def slowEcho(text: string): string`, which calls `sleep(2000)` and returns `text`. Its docstring says it exists to outlast a step's time limit. The fake clock (`_advanceTime`) does not reach a child process, so the test leaves a wide margin: 2 seconds of sleep against a 100 ms limit.

- [ ] **Step 1: Write the tests.** `runMealPlan.agency` reuses the meal plan from `compile.agency` with `limits` removed. Every node approves `std::read`, `std::workflow::run`, and `std::run`, and answers the rest as the row says. The two meal-plan cases set `"useTestLLMProvider": true` and `"llmMocks": [{ "return": ["soup", "salad"] }]`. `stepLimitTrips` has no LLM step and needs neither.

| Node | Handler for the rest | Returns | Expected |
| --- | --- | --- | --- |
| `rejectedStepStopsTheWorkflow` | rejects `test::lists::add` | `[result.error.startsWith("step add (addListItems):"), result.data.step]` | `[true,"add"]` |
| `pausedWorkflowResumes` | passes everything else; the case has `"interruptHandlers": [{ "action": "approve" }]` | `result.value` | `"added 2 items to l1/Meals"` |
| `stepLimitTrips` | rejects `std::guard`; the workflow is one step `slow` calling `slowEcho` with `limits: { maxTime: 100 }` | `[result.data.step, result.data.cause.data.type]` | `["slow","timeoutFailure"]` |

`pausedWorkflowResumes` also pins Review Focus 4: it has one mock, so a resume that called the model again would fail.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm run agency test tests/agency/workflow/runMealPlan.agency > /tmp/wf2-t8.txt 2>&1; tail -30 /tmp/wf2-t8.txt`
Expected: `rejectedStepStopsTheWorkflow` and `pausedWorkflowResumes` fail until `lists.agency` raises its interrupt. Change the fixture. `stepLimitTrips` passes once Task 5 is in.

- [ ] **Step 3: Run part 1's Agency tests again**, since `lists.agency` changed:

Run: `pnpm run agency test tests/agency/workflow > /tmp/wf2-t8-all.txt 2>&1; tail -8 /tmp/wf2-t8-all.txt`
Expected: PASS. Part 1's tests only compile and typecheck the tools, and an interrupt does not change either.

- [ ] **Step 4: Commit.**

---

### Task 9: Docs

**Files:**
- Modify: `docs/dev/stdlib/workflow.md`, `CLAUDE.md` (its `workflow.md` line), `.claude/skills/agency-stdlib-docs/SKILL.md` (the same line), `stdlib/workflow.agency` (the module doc comment)

- [ ] **Step 1: Update the dev doc.** Mechanism and rules only. Add a section on running: the order (check, ask, run the program the check compiled), the effect and what an "always" answer pins, the wall clock rule, the unwrap of `run`'s envelope, and how interrupts and checkpoints work (each step's interrupts go up the parent's handlers, an unanswered one pauses the child, and a resume starts a fresh child). Add a section on limits: positive and capped, the step guard and its two shapes, `holdsResult` and why a guarded plain value is read through `.value`, and the reply declared inside the guard. Add the text-or-JSON rule for context values to "How workflow text enters the program". Replace "Not built yet" with part 3's list: saving and loading, `workflowTool`, `workflowTools`, `catalog`, and the `scan` and `save` effects.
- [ ] **Step 2: Update the index line** in `CLAUDE.md` and in the skill file to mention running, step limits, and context text.
- [ ] **Step 3: Update the module doc comment** in `stdlib/workflow.agency` to show `runWorkflow`, then run `make` to regenerate `docs/site/stdlib/workflow.md`. Do not edit that page by hand.
- [ ] **Step 4: Check the prose** against `~/.claude/skills/simplify-speech/verbal-tics.md`, then commit.

---

## Self-review notes

**Spec coverage, for this part.** Decision 16 (two prompts): Task 7. Decision 17 (`Inputs!`): Tasks 6 and 7. Decision 18 (context text): Task 4. Decision 19 (partials refused): unchanged from part 1, and Task 3 reports them together. Decision 20 (step limits and the guard type): Tasks 1 and 5. Decision 21 (positive limits, the cap, the wall clock): Tasks 2 and 7. Decision 22 (check, ask, run once): Task 7. "Typed returns matter" (`Json` warning): Task 3. The spec's MVP tests: two `std::` functions run (Task 7), the meal plan stopped by a rejection (Task 8), a paused workflow resumed (Task 8). Part 3 covers decisions 23 and 24. Decision 25 and `allowedImports` are changes to `run`, outside the workflow PRs.

**Type consistency.** `ToolRefsResult` is defined in Task 3. `ContextBinding` in Task 4. `holdsResult`, `limits`, and `reply` on the resolved steps in Task 5. `Compiled.wallClock` and `Checked` in Task 7. Later tasks use these names.

**Departures from part 1 to watch for in review.** `ResolvedToolStep.returnsResult` becomes `holdsResult`. `_toolRefs` returns a `Result` instead of throwing. `SHAPES.stringify` is deleted. `guardArgs` moves from `render.ts` to `shapes.ts`, and `LIMIT_CEILINGS` in `lib/runtime/ipc.ts` is exported.
