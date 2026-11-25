# Workflow `match` and `each` steps: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workflow can branch on a value with a `match` step and repeat steps for every item of a list with an `each` step.

**Architecture:** A workflow's steps become a tree. The four generator stages in `lib/stdlib/workflow/` each learn to walk it: parse checks the nested shape, resolve checks references against a scope, lower writes each block's own lines and its steps into one flat list where every item has a depth, and render indents each item by its depth. The generated program uses an if/else-if chain for a `match` and a `for` loop with a `thread` block for an `each`. No runtime code changes.

**Tech Stack:** TypeScript, zod 4, vitest, Agency tests in `tests/agency/workflow/`.

**Spec:** `docs/superpowers/specs/2026-11-25-workflow-match-and-each.md`. Its review is `docs/superpowers/specs/2026-11-25-workflow-match-and-each-review.md`. Read the spec before starting. This plan does not repeat its reasons.

**Reviews:** `docs/superpowers/plans/2026-11-25-workflow-match-and-each-architecture-review.md`. This version of the plan includes its findings 1 to 3 and its three cuts. The owner set finding 4 aside. `docs/superpowers/plans/2026-11-25-workflow-match-and-each-review.md` is the plan review, and this version includes every finding in it.

---

## Background

A reader who knows `docs/dev/stdlib/workflow.md` can skip to "Global Constraints".

### What a workflow is today

A workflow is JSON with a flat list of steps. A tool step calls a function. An LLM step asks a model for a typed value. A later step reads an earlier value through `{ "$ref": "steps.note[0].id" }`.

Four pure functions turn the JSON into an Agency program. Each is one file in `lib/stdlib/workflow/`:

1. `parse.ts` checks the JSON's shape with a zod schema. It returns a typed `Workflow` or a list of problems.
2. `resolve.ts` checks tools and references. It returns a `ResolvedWorkflow` in which every step carries the names its statements will declare.
3. `lower.ts` builds each generated statement as a `Fragment`: a piece of code and the step and field that own it.
4. `render.ts` prints the fragments into a fixed program text. It also records which lines each step and field own, so a type error can be reported on its step.

Every generated statement comes from the `SHAPES` table in `shapes.ts`. A name goes into a shape only after it passes `isIdentifier`. A workflow value goes in as a literal node and is never parsed.

### What changes

Two new step kinds hold step lists of their own:

```json
{ "id": "route", "kind": "match", "on": { "$ref": "steps.triage.level" },
  "cases": [ { "is": "urgent", "steps": [ ... ] }, { "is": "normal", "steps": [] } ],
  "otherwise": [ ... ] }

{ "id": "note", "kind": "each", "over": { "$ref": "steps.search" },
  "steps": [ ... ] }
```

Inside the `note` loop, `{ "$ref": "each.note.id" }` reads the current item.

The code today assumes the list is flat in many places. The spec's table under "How each stage changes" lists every one. The first task adds a helper that walks the tree, and the later tasks move each reader to it.

### What the generated program looks like

A `match` step:

```
const step_route_on = step_triage.level
const step_route_case1 = step_route_on == "urgent"
const step_route_case2 = step_route_on == "normal"
if (step_route_case1) {
  ...the first case's steps...
} else if (step_route_case2) {
} else {
  return failure("step route: no case matches ${JSON.stringify(step_route_on)}", { step: "route" })
}
```

An `each` step:

```
const step_note_over = step_search.value
for (step_note_item in step_note_over) {
  thread {
    ...the loop's steps...
  }
}
```

Two programs of this shape were written by hand and run on 2026-11-25. Both passed the type checker, and a failure inside the loop ended `main` at that round.

---

## Global Constraints

- Work in the worktree `packages/agency-lang/.worktrees/workflow-match-each`, on the branch `workflow-match-each`. Paths in this plan are relative to `packages/agency-lang` inside it.
- Run `pnpm install` in the worktree once before the first task.
- Types, not interfaces. Arrays, not sets. Objects, not maps. No dynamic imports.
- No new statement text outside `SHAPES`. A block's own lines hold generated names that pass `isIdentifier`, and nothing else.
- `format` stays `1`.
- Change files with the Edit and Write tools only.
- Format only the TypeScript files a task names: `pnpm exec prettier --write <files>`. Do not run `pnpm run fmt:ts` over the repo.
- Do not run `agency fmt` on an existing `.agency` file. Run it only on files this plan creates.
- Do not hand-edit `docs/site/stdlib/workflow.md`. `make` regenerates it from `stdlib/workflow.agency`.
- Do not edit `CHANGELOG.md`.
- Type-check with `pnpm run typecheck`. Do not run bare `tsc`.
- Save every test run's output to a file under `.agency-tmp/` and read the file.
- Write each commit message to a file and commit with `git commit -F <file>`. Never amend and never force push.
- Run `make` once, in Task 8. Tasks 1 to 7 need only vitest on the files they name.
- Do not run the whole Agency test suite. Run the files this plan names, with `--check-capabilities`.

## Review Focus

These inputs are not in the spec's test list and are likely to reach a real user. Each has a test in the task that owns the code.

1. **A case whose `is` holds a quote or `${`.** The program must hold the same string as a literal. Test in Task 5.
2. **A case `is` of the number `1` against the string `"1"`.** A reasonable author expects no match. Test in Task 9.
3. **A step id that equals a block's generated name**, such as a tool step `route_on` beside a match `route`. The check must refuse it. Test in Task 4.
4. **A type error three levels down**, in a tool step inside a case inside a loop. The problem must name that step and its argument. Task 6 tests the half that changed: a diagnostic on that line maps to the step and argument. Task 9's `nestedTypeErrorNamesItsStep` shows the type checker reports on that line.
5. **Malformed nesting in a file the CLI reads**, such as `"cases": "x"` or a case with no `steps`. `agency workflow check` must report a problem and must not crash. Test in Task 7.

---

## File Structure

| File | Change |
| --- | --- |
| `lib/stdlib/workflow/types.ts` | The new step types, `locatedSteps`, `allSteps`, the `each` root in `REF_PATH`, the resolved tree types, a fragment's depth |
| `lib/stdlib/workflow/parse.ts` | Recursive schema, whole-tree id and limits checks, `problemAt` walks nested paths |
| `lib/stdlib/workflow/resolve.ts` | Scope-based reference rule, new names, tree-shaped output, two warnings |
| `lib/stdlib/workflow/effects.ts` | Reads every tool step in the tree |
| `lib/stdlib/workflow/shapes.ts` | Two shapes, and the functions that write a block's own lines |
| `lib/stdlib/workflow/lower.ts` | Lowers the two kinds to lines and statements with depths; item references |
| `lib/stdlib/workflow/render.ts` | Indents each fragment by its depth |
| `lib/cli/workflow/toolImports.ts` | Finds tool steps through `locatedSteps` |
| `stdlib/workflow.agency` | Module doc comment, `DESIGN_TUTORIAL` |
| `tests/agency/workflow/matchEach.agency` and `.test.json` | New run tests |
| `tests/agency/workflow/fixtures/tools/flow.agency` | New fixture tools |
| `docs/site/guide/workflows.md`, `docs/dev/stdlib/workflow.md` | Guide sections and the mechanism |

Each `.ts` file above has a `.test.ts` beside it, which the same task extends.

---

### Task 1: The step tree in `types.ts`

**Files:**
- Modify: `lib/stdlib/workflow/types.ts`
- Create: `lib/stdlib/workflow/types.test.ts`
- Modify: `lib/stdlib/workflow/testFixtures.ts`

**Interfaces:**
- Produces:

```ts
export type CaseValue = string | number | boolean;
export type MatchCase = { is: CaseValue; steps: Step[] };
/** `otherwise` reads null as absent. */
export type MatchStep = {
  id: string; kind: "match"; on: Ref; cases: MatchCase[]; otherwise?: Step[] | null;
};
export type EachStep = { id: string; kind: "each"; over: Ref; steps: Step[] };
export type ValueStep = ToolStep | LlmStep;
export type BlockStep = MatchStep | EachStep;
export type Step = ValueStep | BlockStep;

/** An object found in a step list, and its JSON path from the workflow,
 *  such as ["steps", 2, "cases", 0, "steps", 1]. */
export type Located = { step: Record<string, unknown>; path: (string | number)[] };
/** Every object in every step list of a workflow that may not be well
 *  formed. Anything that is not an object or not a list is skipped. */
export function locatedSteps(workflow: unknown): Located[];
/** The same walk over a parsed workflow, typed. */
export function allSteps(workflow: Workflow): Step[];
export function isBlockStep(step: Step): step is BlockStep;
```

- `locatedSteps` is the one function that knows where a step list can be: the workflow's `steps`, a case's `steps`, a match's `otherwise`, and an each's `steps`. Parse, resolve, and the CLI all read steps through it or through `allSteps`.
- It takes `unknown` because two of its callers run on JSON nobody has checked yet: `problemAt` in parse, and the CLI's import planner. It never throws.
- It returns steps in document order. A block comes before the steps inside it. A match's cases come in order, then `otherwise`.
- `REF_PATH` accepts `each` as a third root: `/^(inputs|steps|each)\.…/`, the rest unchanged.
- `testFixtures.ts` gains two exported workflows the later tasks share. Five tasks assert exact text that comes from them, so write them exactly as below:

```ts
export const eachPlan: Workflow = {
  format: 1,
  name: "copyNotes",
  description: "Add every matching note's text to a list.",
  inputs: "{ query: string; listId: string }",
  steps: [
    { id: "search", kind: "tool", module: "./notes.agency", tool: "searchNotes",
      args: { query: { $ref: "inputs.query" } } },
    { id: "note", kind: "each", over: { $ref: "steps.search" },
      steps: [
        { id: "text", kind: "tool", module: "./notes.agency", tool: "readNote",
          args: { id: { $ref: "each.note.id" } } },
        { id: "add", kind: "tool", module: "./lists.agency", tool: "addListItems",
          args: { listId: { $ref: "inputs.listId" }, items: [{ $ref: "steps.text.body" }], section: "Notes" } },
      ] },
    { id: "done", kind: "tool", module: "./lists.agency", tool: "findLists", args: { query: "done" } },
  ],
  result: { $ref: "steps.done" },
};

export const matchPlan: Workflow = {
  format: 1,
  name: "routeByLevel",
  description: "Add an item to a list when the level is urgent.",
  inputs: "{ level: string; listId: string }",
  steps: [
    { id: "note", kind: "tool", module: "./notes.agency", tool: "searchNotes", args: { query: "plan" } },
    { id: "route", kind: "match", on: { $ref: "inputs.level" },
      cases: [
        { is: "urgent",
          steps: [
            { id: "add", kind: "tool", module: "./lists.agency", tool: "addListItems",
              args: { listId: { $ref: "inputs.listId" }, items: ["urgent"], section: "Inbox" } },
          ] },
        { is: "normal", steps: [] },
      ] },
    { id: "done", kind: "tool", module: "./lists.agency", tool: "findLists", args: { query: "done" } },
  ],
  result: { $ref: "steps.done" },
};
```

In `matchPlan`, `addListItems` is called only inside a case. A test that checks a nested tool is imported, or that its effects are counted, can therefore fail.

- [ ] **Step 1: Write the failing tests** in `types.test.ts`:

```ts
it("lists every step in document order, a block before its steps", () => {
  expect(allSteps(eachPlan).map((step) => step.id)).toEqual(["search", "note", "text", "add", "done"]);
});
it("lists a match's cases in order, then otherwise", () => {
  const wf = withOtherwise(matchPlan, [toolStep("fallback")]);
  expect(allSteps(wf).map((step) => step.id)).toEqual(["note", "route", "add", "fallback", "done"]);
});
it("records each step's path", () => {
  const text = locatedSteps(eachPlan).find((entry) => entry.step.id === "text")!;
  expect(text.path).toEqual(["steps", 1, "steps", 0]);
});
it("skips malformed nesting without throwing", () => {
  // Review Focus 5
  for (const steps of [
    "x",
    [null, 3, "x"],
    [{ id: "r", kind: "match", cases: "x" }],
    [{ id: "r", kind: "match", cases: [{ is: "a" }], otherwise: 5 }],
    [{ id: "n", kind: "each", steps: null }],
  ]) {
    expect(() => locatedSteps({ steps })).not.toThrow();
  }
  expect(locatedSteps(null)).toEqual([]);
  expect(locatedSteps({ steps: [null, { id: "a" }] }).map((entry) => entry.path)).toEqual([["steps", 1]]);
});
it("accepts each as a reference root", () => {
  expect(REF_PATH.test("each.note.items[0].id")).toBe(true);
  expect(REF_PATH.test("every.note")).toBe(false);
});
```

`withOtherwise` and `toolStep` are small local helpers in the test file.

- [ ] **Step 2: Run** `pnpm exec vitest run lib/stdlib/workflow/types.test.ts > .agency-tmp/t1.txt 2>&1`. Expected: FAIL, `allSteps` is not exported.
- [ ] **Step 3: Implement** the types and functions above. Existing code that narrows on `step.kind === "tool"` keeps compiling, because the new kinds are new union members.
- [ ] **Step 4: Run** the same command, then `pnpm run typecheck > .agency-tmp/t1-tc.txt 2>&1`. Expected: both PASS before the commit. Widening `Step` breaks `stepFields`, `stepLimits`, and `declaredBy` in `resolve.ts`, and code in `lower.ts` and `effects.ts`, wherever a branch reads `step.limits` or `step.context`. Narrow each to `ValueStep`, with no behavior change, until the type check is clean.
- [ ] **Step 5: Commit** `types.ts`, `types.test.ts`, `testFixtures.ts`, and any narrowing fix.

---

### Task 2: Parse the nested shape

**Files:**
- Modify: `lib/stdlib/workflow/parse.ts`
- Test: `lib/stdlib/workflow/parse.test.ts`

**Interfaces:**
- Consumes: `locatedSteps`, `Step`, `MatchStep`, `EachStep`, `isRef` from Task 1.
- Produces: `parseWorkflow` accepts the two kinds. Its signature does not change.

**Decisions:**
- The step schema is recursive through its list fields: `z.array(z.lazy(() => step))`. The union members stay plain `z.object` schemas, so `z.discriminatedUnion("kind", [...])` keeps working. Declare `const step: z.ZodType<Step>`.
- `on` and `over` use one schema, `reference`, that accepts only a value `isRef` accepts and whose path passes `REF_PATH`.
- A `match` or `each` object that has a `limits` key is refused. zod strips unknown keys by default, so the schema must name `limits` to refuse it.
- The duplicate-id check and the step-limit check move from the top-level `steps` list to the workflow's `superRefine`, and read `locatedSteps(parsed)`. Each issue's `path` is the located step's `path` plus the field.
- `problemAt` calls `locatedSteps(raw)`. The owner is the located step with a string `id` whose path is the longest prefix of the issue's path. The field is the rest of the issue's path after that prefix, printed by `fieldText`. With no such step, the problem belongs to the workflow, as it does today. A top-level step with no id keeps today's field, `steps[3]`.
- When the issue's path ends exactly at the owner, there is no rest. The field is then the step's place in its list: `steps[3]` for a top-level step, and its path from the enclosing step for a nested one, such as `cases[0].steps[1]`.

**Messages** (exact text):

| Condition | Field | Message |
| --- | --- | --- |
| unknown kind | `kind`, on the step's id | `kind must be "tool", "llm", "match", or "each", got "shell"` |
| `on` is not a reference | `on` | `on must be a reference, such as { "$ref": "steps.triage.level" }` |
| `over` is not a reference | `over` | `over must be a reference to a list, such as { "$ref": "steps.search" }` |
| `cases` missing or empty | `cases` | `cases must hold at least one case` |
| bad `is` | `cases[1].is` | `is must be a string, a number, or true or false` |
| repeated `is` | `cases[1].is` | `case "urgent" is already handled by an earlier case` |
| `each` with no steps | `steps` | `steps must hold at least one step` |
| `limits` on a block | `limits` | `a match step takes no limits; set limits on the steps inside it` (and `an each step …`) |
| repeated id anywhere | `id` | `step id "text" is used by an earlier step` (unchanged text) |

Two `is` values are the same when they are `===`. `1` and `"1"` are different cases.

- [ ] **Step 1: Write the failing tests.** One `it` per row of the table, each asserting the full `{ step, field, message }`. The unknown-kind row is an existing test, near `parse.test.ts:75`. Edit its message and keep its step and field. Also:

```ts
it("accepts the each and match fixtures", () => {
  expect(parseWorkflow(eachPlan).problems).toEqual([]);
  expect(parseWorkflow(matchPlan).problems).toEqual([]);
});
it("names a nested step by its own id", () => {
  // eachPlan with the text step's args.id set to { $ref: "bad path" }
  expect(problems).toEqual([
    { step: "text", field: "args.id", message: 'reference "bad path" is not a well-formed path' },
  ]);
});
it("reports a nested step with no id on the block that holds it", () => {
  // matchPlan with cases[0].steps[0] replaced by { kind: "tool" }
  expect(problems[0].step).toBe("route");
  expect(problems[0].field).toMatch(/^cases\[0\]\.steps\[0\]/);
});
it("refuses a duplicate id across levels", () => { /* a top-level step named "text" in eachPlan */ });
it("refuses a nested step maxTime when the workflow sets none", () => {
  // eachPlan, text step with limits { maxTime: 5000 }, no workflow limits
  expect(problems).toEqual([{ step: "text", field: "limits.maxTime", message: expect.stringContaining("needs the workflow to set a maxTime") }]);
});
it("accepts an empty case and an empty otherwise", () => {
  // matchPlan with "otherwise": []; its second case is already empty
  expect(parseWorkflow(wf).problems).toEqual([]);
});
```

- [ ] **Step 2: Run** `pnpm exec vitest run lib/stdlib/workflow/parse.test.ts > .agency-tmp/t2.txt 2>&1`. Expected: the new tests FAIL, the existing ones PASS.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `pnpm run typecheck`.
- [ ] **Step 5: Commit.**

---

### Task 3: Resolve references against a scope

**Files:**
- Modify: `lib/stdlib/workflow/types.ts` (resolved types)
- Modify: `lib/stdlib/workflow/resolve.ts`
- Modify: `lib/stdlib/workflow/effects.ts`
- Test: `lib/stdlib/workflow/resolve.test.ts`, `lib/stdlib/workflow/effects.test.ts`

**Interfaces:**
- Produces, in `types.ts`:

```ts
export type ItemRef = { kind: "item"; loop: string; path: string };
export type ResolvedRef = InputRef | StepRef | ItemRef;

export type ResolvedCase = { is: CaseValue; test: string; steps: ResolvedStep[] };
/** `on` binds the tested value to `step_<id>_on`. `test` on each case is
 *  the local that holds its comparison, `step_<id>_case<n>`. */
export type ResolvedMatchStep = {
  id: string; kind: "match"; on: Binding; cases: ResolvedCase[]; otherwise: ResolvedStep[] | null;
};
/** `over` binds the list to `step_<id>_over`. `item` is the loop variable. */
export type ResolvedEachStep = {
  id: string; kind: "each"; over: Binding; item: string; steps: ResolvedStep[];
};
export type ResolvedValueStep = ResolvedToolStep | ResolvedLlmStep;
export type ResolvedStep = ResolvedValueStep | ResolvedMatchStep | ResolvedEachStep;
export function allResolved(steps: ResolvedStep[]): ResolvedStep[]; // document order
```

- `names(id)` gains `on: step_<id>_on`, `caseTest: (index) => step_<id>_case<index + 1>`, `over: step_<id>_over`, `item: step_<id>_item`.
- `ResolvedWorkflow.steps` is the tree. `Binding.field` is `"on"` or `"over"` for the two block bindings.

**Decisions:**
- `stepFields(step)` returns `[["on", step.on]]` for a match and `[["over", step.over]]` for an each. Every rule that reads a step's references goes through it.
- `referenceRule` walks the tree with a scope:

```ts
type Scope = { visible: string[]; loops: string[] };
```

`visible` holds the ids of the tool and LLM steps a reference may name. `loops` holds the ids of the enclosing `each` steps. A step's own fields are checked with the scope as it stands before the step. After a tool or LLM step, its id joins `visible` for the rest of its list. A block's child lists each start from the scope at the block, and an each adds its id to `loops`. What a child list adds to `visible` does not leave the list.
- `result` is checked with the scope after the top-level list, and with no loops.
- `toolSteps`, `importGroups`, `collisionRule`, `referencedSteps`, and `stepEffects` read `allSteps(workflow)`.
- `declaredBy` returns, for a match, the `on` name and one name per case, and for an each, the `over` and `item` names.

**Messages** (exact text; `path` is the reference as written):

| Condition | Message |
| --- | --- |
| step ref to a match or each | `reference "steps.route" names step "route", a match step, which has no value` |
| step ref to a step that is not visible yet and is later in this step's own list or in an enclosing list | `… names step "x", which comes after this step` (unchanged) |
| step ref to any other step that exists and is not visible | `reference "steps.text" names step "text", which is inside a block this step is not in` |
| `each.x` where `x` is not an each step | `reference "each.x.id" names no each step` |
| `each.x` outside loop `x` | `reference "each.note.id" names loop "note", which this step is not inside` |
| no `result`, last top-level step is a block | step `null`, field `result`: `the last step, "route", is a match step and has no value; set result` |
| cost warning, on the each step, field `over` | `this loop runs a model once per item, and the workflow sets no limits.maxCost, so its cost depends on the length of the list` |

The two "not visible" rows are checked in that order. A step in one case that reads a step in another case gets the "inside a block" message in both directions, because the other case's list does not enclose it.

The cost warning is reported when `workflow.limits?.maxCost` is not a number, on each top-level `each` step whose subtree holds an LLM step or a tool step whose signature has `handoff: true`. A loop inside another loop gets no warning of its own, so a nested pair warns once.

The designer's prompt tells the model not to add limits, so a drafted loop with an LLM step reaches the person with this warning. That is intended. The person reads it in the review prompt and decides whether to set a limit.

- [ ] **Step 1: Write the failing tests** in `resolve.test.ts`. One `it` per row of the table. Also:

```ts
it("lets a step read an earlier step in its list, an enclosing list, and its loop's item", () => {
  expect(resolveWorkflow(eachPlan, mealRefs, mealSignatures).problems).toEqual([]);
});
it("lets a step in an inner loop read both loops' items", () => {
  // outer loop `group` over inputs.groups, inner loop `item` over
  // each.group.items, one step reading each.group.name and each.item
  expect(problems).toEqual([]);
});
it("refuses a reference from one case into another, in both directions", () => {
  // matchPlan with a tool step `later` in the second case. `add` reading
  // steps.later, and `later` reading steps.add, each get:
  // 'reference "steps.later" names step "later", which is inside a block this step is not in'
});
it("refuses a reference from result into a loop", () => {
  // eachPlan with result { $ref: "steps.add" }: step null, field "result",
  // the "inside a block this step is not in" message
});
it("resolves an each step to a tree with its names", () => {
  const each = resolved(eachPlan).steps[1] as ResolvedEachStep;
  expect(each.over.local).toBe("step_note_over");
  expect(each.item).toBe("step_note_item");
  expect(each.steps.map((step) => step.id)).toEqual(["text", "add"]);
});
it("resolves each.note.id to an item reference", () => {
  // the text step's args.id binding
  expect(binding.value).toEqual({ kind: "item", loop: "note", path: ".id" });
});
it("refuses a step id that equals a block's generated name", () => {
  // Review Focus 3: matchPlan plus a top-level tool step with id "route_on"
  expect(problems[0].message).toContain("produces the same local as");
});
it("refuses a nested step whose generated name collides with a top-level one", () => {
  // eachPlan plus a top-level tool step with id "text_id": the `text`
  // step's argument `id` and the new step both declare step_text_id
  expect(problems[0].message).toContain("produces the same local as");
});
it("imports a tool used only inside a case", () => {
  expect(resolved(matchPlan).imports).toContainEqual({
    module: "./lists.agency", names: ["addListItems", "findLists"],
  });
});
it("warns about an untyped tool that only an over reads", () => {
  // eachPlan with searchNotes' signature given returnType "Json" and
  // returnsResult false. Nothing but `over` reads steps.search.
  expect(warnings).toContainEqual({ step: "search", field: "tool", message: expect.stringContaining("searchNotes returns Json") });
});
it("warns once, on the outer loop, for an LLM step in a nested loop", () => {
  // field "over" on the outer each, and no warning on the inner one
});
it("warns for a handoff tool in a loop", () => {
  // eachPlan with readNote's signature given handoff: true
});
it("gives no cost warning when the workflow sets maxCost", () => {
  // the handoff case above with limits: { maxCost: 1 }
  expect(warnings).toEqual([]);
});
it("gives no cost warning for a loop of plain tools", () => {
  expect(resolved(eachPlan).warnings).toEqual([]);
});
```

`mealSignatures` has no untyped tool and no handoff tool, so those three tests each pass a copy of it with one signature changed.

In `effects.test.ts`:

```ts
it("lists a tool step inside a case", () => {
  expect(stepEffects(matchPlan, mealSignatures).map((entry) => entry.step)).toEqual(["note", "add", "done"]);
});
```

And in `resolve.test.ts`, the `raises` rule on a nested step:

```ts
it("reports a tool inside a loop that raises an effect raises does not allow", () => {
  // eachPlan with raises: [] and addListItems raising "test::lists::add"
  expect(problems).toContainEqual({ step: "add", field: "tool", message: expect.stringContaining('raises "test::lists::add"') });
});
```

- [ ] **Step 2: Run** `pnpm exec vitest run lib/stdlib/workflow/resolve.test.ts lib/stdlib/workflow/effects.test.ts > .agency-tmp/t3.txt 2>&1`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** `lower.ts` reads `resolved.steps` as a flat list of value steps today. Until Task 5, make it compile by lowering only top-level value steps and throwing `new Error("block steps are lowered in a later task")` for a block.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `pnpm run typecheck`.
- [ ] **Step 5: Commit.**

---

### Task 4: Block lines and the two shapes

**Files:**
- Modify: `lib/stdlib/workflow/shapes.ts`
- Test: `lib/stdlib/workflow/shapes.test.ts`

**Interfaces:**
- Produces:

```ts
// in SHAPES
caseTest: "const {{local}} = {{on}} == #is",
noCase:
  'return failure("step {{id}}: no case matches ${JSON.stringify({{on}})}", { step: #id })',

/** `if (<test>) {` for the first case, `} else if (<test>) {` after it. */
export function ifLine(test: string, first: boolean): string;
export const ELSE_LINE = "} else {";
/** `for (<item> in <over>) {`. */
export function forLine(item: string, over: string): string;
export const THREAD_LINE = "thread {";
export const CLOSE_LINE = "}";
```

- `ifLine` and `forLine` throw an `Error` when a name does not pass `isIdentifier`, the way `substitute` does for a shape.

- [ ] **Step 1: Write the failing tests:**

```ts
it("writes a case test with the value as a literal", () => {
  const code = statement("caseTest", { local: "step_r_case1", on: "step_r_on" }, { is: literal("urgent") });
  expect(_toSource(code)).toBe('const step_r_case1 = step_r_on == "urgent"\n');
});
it("keeps a quote and an interpolation in a case value as text", () => {
  // Review Focus 1
  const code = statement("caseTest", { local: "a", on: "b" }, { is: literal('${evil} " }') });
  expect(_toSource(code)).toBe('const a = b == "\\${evil} \\" }"\n');
});
it("writes a boolean and a number case", () => {
  expect(_toSource(statement("caseTest", { local: "a", on: "b" }, { is: literal(true) }))).toBe("const a = b == true\n");
  expect(_toSource(statement("caseTest", { local: "a", on: "b" }, { is: literal(3) }))).toBe("const a = b == 3\n");
});
it("writes the no-case failure", () => {
  const text = _toSource(statement("noCase", { id: "route", on: "step_route_on" }, { id: literal("route") }));
  expect(text).toContain('"step route: no case matches ${JSON.stringify(step_route_on)}"');
  expect(text).toContain('step: "route"');
});
it("writes block lines from identifiers only", () => {
  expect(ifLine("step_r_case1", true)).toBe("if (step_r_case1) {");
  expect(ifLine("step_r_case2", false)).toBe("} else if (step_r_case2) {");
  expect(forLine("step_n_item", "step_n_over")).toBe("for (step_n_item in step_n_over) {");
  expect(() => ifLine("a) { evil() } if (b", true)).toThrow();
  expect(() => forLine("a", "b) { evil(")).toThrow();
});
```

If the printer wraps the `noCase` call over several lines, as it does for the `check` shape, the two `toContain` assertions still hold.

- [ ] **Step 2: Run** `pnpm exec vitest run lib/stdlib/workflow/shapes.test.ts > .agency-tmp/t4.txt 2>&1`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 5: Lower blocks

**Files:**
- Modify: `lib/stdlib/workflow/types.ts` (a fragment's depth)
- Modify: `lib/stdlib/workflow/lower.ts`
- Test: `lib/stdlib/workflow/lower.test.ts`

**Interfaces:**
- Consumes: Task 3's resolved tree, Task 4's shapes and lines.
- Produces, in `types.ts`:

```ts
/** A statement, and how many blocks it is inside. */
export type CodeFragment = { code: Code; owner: Owner | null; depth: number };
/** One line of a block's own text, such as `for (a in b) {` or `}`. */
export type LineFragment = { line: string; owner: Owner | null; depth: number };
export type Fragment = CodeFragment | LineFragment;
export function isLine(fragment: Fragment): fragment is LineFragment;
// Lowered.body stays Fragment[], a flat list
```

A block's opening line does not parse without its body, so it cannot be a `Code` value. It is a line of fixed text in the same flat list, and `depth` says how far to indent each item. There is no tree of fragments.

**What each kind lowers to**, in order, for a step at depth `d`:

A match step `route` with two cases:

| Item | Depth | Owner field |
| --- | --- | --- |
| `binding` statement for `on` | `d` | `on` |
| one `caseTest` statement per case | `d` | `cases[n].is` |
| line `ifLine(case.test, true)` | `d` | `cases[0].is` |
| the first case's steps | `d + 1` | their own |
| line `ifLine(case.test, false)` | `d` | `cases[1].is` |
| the second case's steps | `d + 1` | their own |
| line `ELSE_LINE` | `d` | `otherwise`, or `cases` when there is none |
| the `otherwise` steps, or one `noCase` statement owned by `cases` | `d + 1` | |
| line `CLOSE_LINE` | `d` | none |

An each step `note`:

| Item | Depth | Owner field |
| --- | --- | --- |
| `binding` statement for `over` | `d` | `over` |
| line `forLine(item, over.local)` | `d` | `over` |
| line `THREAD_LINE` | `d + 1` | `over` |
| the loop's steps | `d + 2` | their own |
| line `CLOSE_LINE` | `d + 1` | none |
| line `CLOSE_LINE` | `d` | none |

Top-level steps are at depth 0.

**Other decisions:**
- `reference()` writes an `ItemRef` as the loop's `item` name followed by the path. It never adds `.value`. It finds the loop in a `Record<string, ResolvedEachStep>` built from `allResolved`.
- `StepsById` is built from `allResolved(resolved.steps)` and holds only value steps.
- `refLabel` returns ` (each.<loop><path>)` for an item reference.
- `guardLabels` and `typeDecls` read `allResolved`.
- The default result, used when the workflow has none, is the last top-level step. Resolve has already refused a block there.

- [ ] **Step 1: Write the failing tests.** Change the test file's `print` and `printAll` helpers to read a fragment's text through one new helper, `textOf(f) => (isLine(f) ? f.line + "\n" : _toSource(f.code))`. Add `lines(body)`, which returns `[f.line, f.depth, f.owner]` for every line fragment.

```ts
it("lowers a match to a binding, one test per case, and an if chain", () => {
  const body = lowerWorkflow(resolved(matchPlan)).body;
  const texts = body.map(textOf);
  expect(texts).toContain("const step_route_on = inputs.level\n");
  expect(texts).toContain('const step_route_case1 = step_route_on == "urgent"\n');
  expect(texts).toContain('const step_route_case2 = step_route_on == "normal"\n');
  expect(lines(body)).toEqual([
    ["if (step_route_case1) {", 0, { step: "route", field: "cases[0].is" }],
    ["} else if (step_route_case2) {", 0, { step: "route", field: "cases[1].is" }],
    ["} else {", 0, { step: "route", field: "cases" }],
    ["}", 0, null],
  ]);
});
it("puts a case's steps one level deeper than the match", () => {
  // the `add` step's call in matchPlan's first case
  expect(fragmentFor("const step_add =").depth).toBe(1);
});
it("gives otherwise the last else and writes no failure line", () => {
  // matchPlan with "otherwise": [] 
  expect(lines(body)[2]).toEqual(["} else {", 0, { step: "route", field: "otherwise" }]);
  expect(body.map(textOf).join("")).not.toContain("no case matches");
});
it("lowers an each to a for line holding a thread line", () => {
  const body = lowerWorkflow(resolved(eachPlan)).body;
  expect(lines(body)).toEqual([
    ["for (step_note_item in step_note_over) {", 0, { step: "note", field: "over" }],
    ["thread {", 1, { step: "note", field: "over" }],
    ["}", 1, null],
    ["}", 0, null],
  ]);
  expect(fragmentFor("const step_text_id =").depth).toBe(2);
});
it("writes an item reference with no .value", () => {
  expect(printAll(resolved(eachPlan))).toContain("const step_text_id = step_note_item.id\n");
});
it("labels a context value read from an item", () => {
  // an LLM step inside the loop with context [{ $ref: "each.note.body" }]
  expect(printAll(...)).toContain("(each.note.body)");
});
it("collects guard labels and output types from nested steps", () => {
  // eachPlan with limits on the add step, and an LLM step inside the loop
  expect(lowered.guardLabels).toContain("add");
  expect(lowered.types.map((decl) => decl.name)).toContain("Step_meals_output");
});
```

`fragmentFor(text)` is a local helper that finds the code fragment whose print starts with `text`.

- [ ] **Step 2: Run** `pnpm exec vitest run lib/stdlib/workflow/lower.test.ts > .agency-tmp/t5.txt 2>&1`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** `render.ts` reads `fragment.code` on every fragment. Until Task 6, make it compile by throwing for a line fragment.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `pnpm run typecheck`.
- [ ] **Step 5: Commit.**

---

### Task 6: Render fragments at their depth

**Files:**
- Modify: `lib/stdlib/workflow/render.ts`
- Test: `lib/stdlib/workflow/render.test.ts`, `lib/stdlib/workflow/index.test.ts`

**Interfaces:**
- Consumes: `Fragment`, `isLine`.
- Produces: `renderWorkflow` is unchanged in signature.

**Decisions:**
- A line fragment prints as its one line. A code fragment prints through `printLines`, as today.
- Each fragment's lines are indented by the scaffold's depth plus the fragment's own `depth`. Today every line gets the scaffold's depth.
- The ranges still come from `rangesOf` over one flat list, built from the same prints as the text. The existing `Block` type in `render.ts` and `rangesOf` do not change. A closing `}` has no owner, so it produces no range.

- [ ] **Step 1: Write the failing tests.** In `render.test.ts`:

```ts
it("prints an each block with its steps two levels deeper", () => {
  const { source } = render(eachPlan);
  expect(source).toContain(
    [
      "    for (step_note_item in step_note_over) {",
      "      thread {",
      "        const step_text_id = step_note_item.id",
    ].join("\n"),
  );
});
it("prints a match as an if/else-if chain that closes once", () => {
  const { source } = render(matchPlan);
  expect(source).toMatch(/if \(step_route_case1\) \{[\s\S]*\} else if \(step_route_case2\) \{\n\s*\} else \{[\s\S]*no case matches/);
});
it("gives every owned line the right owner", () => {
  const { source, ranges } = render(eachPlan);
  const lines = source.split("\n");
  const ownerOf = (text: string) => {
    const line = lines.findIndex((entry) => entry.includes(text)) + 1;
    return ranges.find((range) => range.from <= line && line <= range.to)?.owner;
  };
  expect(ownerOf("const step_note_over =")).toEqual({ step: "note", field: "over" });
  expect(ownerOf("for (step_note_item")).toEqual({ step: "note", field: "over" });
  expect(ownerOf("const step_text_id =")).toEqual({ step: "text", field: "args.id" });
  expect(ownerOf("return success(")).toEqual({ step: null, field: "result" });
});
```

In `index.test.ts`, Review Focus 4, named "maps a diagnostic on a nested argument's line to its step and argument". Build a workflow with a tool step inside a case inside a loop. Compile it with `compileWorkflowSource`, find the 1-based line of that step's argument binding in `compiled.source`, and assert that `problemsFromDiagnostics` maps a diagnostic on that line (0-based, so subtract one) to `{ step: "<inner id>", field: "args.<name>" }`. Use the diagnostic shape the file's existing tests use.

- [ ] **Step 2: Run** `pnpm exec vitest run lib/stdlib/workflow/render.test.ts lib/stdlib/workflow/index.test.ts > .agency-tmp/t6.txt 2>&1`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm exec vitest run lib/stdlib/workflow > .agency-tmp/t6-all.txt 2>&1`. Expected: every file in the folder PASSES. Then `pnpm run typecheck`.
- [ ] **Step 5: Commit.**

---

### Task 7: The CLI finds nested tool steps

**Files:**
- Modify: `lib/cli/workflow/toolImports.ts` (`toolSteps`, around line 156)
- Test: `lib/cli/workflow/toolImports.test.ts`

**Interfaces:**
- Consumes: `locatedSteps(workflow: unknown)` from Task 1.
- `toolSteps(workflow: unknown)` keeps its signature and stays private. It returns every tool step in the tree.

**Decisions:**
- `toolSteps` reads `locatedSteps(workflow)` and keeps the entries whose `kind` is `"tool"` and whose `id`, `module`, and `tool` are strings, as it does today for the top-level list. It has no walk of its own.

- [ ] **Step 1: Write the failing tests** through `importsForSteps`, the function the file's existing tests call:

```ts
it("imports a tool used only inside a case", () => {
  // a workflow whose only step is a match with one std::math `add` step in a case
  expect(plan.imports).toEqual([{ module: "std::math", names: ["add"] }]);
});
it("imports a tool used only inside a loop inside a case", () => {
  // the same `add` step, inside an each inside the case: the same imports
});
it("plans no import for a workflow with malformed nesting, and does not throw", () => {
  expect(() => importsForSteps({ steps: [{ id: "r", kind: "match", cases: "x" }] }, dir, [])).not.toThrow();
});
```

Task 1 pins the walker's other malformed cases.

Match the argument list `importsForSteps` has in the file.

- [ ] **Step 2: Run** `pnpm exec vitest run lib/cli/workflow/toolImports.test.ts > .agency-tmp/t7.txt 2>&1`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Format and commit.** Run `pnpm exec prettier --write` on every `.ts` file Tasks 1 to 7 changed, then `pnpm run lint:structure > .agency-tmp/t7-lint.txt 2>&1`. Commit.

---

### Task 8: The designer's tutorial and the module comment

**Files:**
- Modify: `stdlib/workflow.agency` (the module doc comment near line 38, and `DESIGN_TUTORIAL` near line 839)
- Test: `tests/agency/workflow/design-brief.agency` and its `.test.json`, only if an existing assertion quotes text this task changes

**Decisions:**
- The module doc comment's sentence becomes: "A workflow has tool steps, LLM steps, `match` steps that branch on a value, `each` steps that repeat for every item of a list, and references from one step to an earlier step's result. Any other logic belongs in an Agency function that a tool step calls."
- `DESIGN_TUTORIAL`'s first sentence becomes: "A workflow is a list of steps written as JSON. A step is a tool call, an LLM call, a `match` that branches on a value, or an `each` that repeats steps for every item of a list."
- The tutorial gains two sections after the references section, each with one bare workflow example and the rules as a numbered list:
  - "Branching with `match`": an example that asks an LLM step for `"refund" | "question"` and matches on it. The rules: `on` is a reference; each `is` is a string, a number, or `true`/`false`; when no case fits and there is no `otherwise`, the workflow fails; write `"otherwise": []` to ignore other values; a step inside a case can be read only inside that case; a `match` has no value.
  - "Repeating with `each`": an example that loops over `inputs.orders` with the loop id `order` and reads `each.order.id`. The rules: `over` is a reference to a list; name the loop after one item; read the item as `each.<loop id>`; a step inside the loop can be read only inside it; an `each` has no value, so set `result` to a step outside it.
- The examples use tool names and step ids no test fixture uses. A literal `${` in the tutorial is written `\${`.

- [ ] **Step 1: Edit** the two places.
- [ ] **Step 2: Run** `make > .agency-tmp/t8-make.txt 2>&1`. Expected: exit 0. `make` hides diagnostics on success, so read the file's tail.
- [ ] **Step 3: Run** `pnpm run agency test tests/agency/workflow/design-brief.agency --check-capabilities > .agency-tmp/t8-brief.txt 2>&1`. Expected: PASS. If an assertion quoted the old first sentence, update that assertion.
- [ ] **Step 4: Commit** `stdlib/workflow.agency`, the regenerated `docs/site/stdlib/workflow.md`, and any test change.

---

### Task 9: Run tests

**Files:**
- Create: `tests/agency/workflow/fixtures/tools/flow.agency`
- Create: `tests/agency/workflow/matchEach.agency`, `tests/agency/workflow/matchEach.test.json`
- Modify: `lib/cli/workflow/workflow.spawn.test.ts`

**Fixture tools** in `flow.agency`. A block has no value, so the tests observe a run through a module-level list that a last top-level step returns.

```
effect test::flow::record { text: string }

export def record(text: string): Result<string>     // appends text to the module's list
export def recordAsking(text: string): Result<string> // raises test::flow::record first, then appends
export def recorded(): string[]                      // returns the list
export def failOn(text: string, bad: string): Result<string> // failure("bad item: <text>") when text == bad
export def freshThreadOnly(text: string): Result<string>
```

`freshThreadOnly` fails with `"the thread already holds a message"` when its current thread holds any message, and otherwise adds one user message and succeeds. Build it from `currentThreadId`, `getThread`, and `userMessage` in `std::thread`. Give every def a docstring with `@param` lines, as `lists.agency` does.

**Test nodes** in `matchEach.agency`. Each builds a `Workflow`, calls `runWorkflow` inside a handler that approves everything except where the row says otherwise, and returns the value in the last column. Follow `runMealPlan.agency` for the handler and the `.test.json` entries.

| Node | Workflow | Expected output |
| --- | --- | --- |
| `matchTakesTheFittingCase` | LLM step returns `{ level: "urgent" }` from a mock; match records `"urgent"` or `"normal"`; result `recorded()` | `["urgent"]` |
| `matchWithNoCaseFails` | match on `inputs.level` = `"1"`, cases `is: 1` and `is: "urgent"`. The number `1` must not match the string `"1"` (Review Focus 2) | `[true, "route"]` for `error.startsWith('step route: no case matches "1"')` and `data.step` |
| `matchOtherwiseEmptyContinues` | the same with `"otherwise": []`, then `record("after")` | `["after"]` |
| `eachRunsInOrder` | each over `inputs.items`, `record(each.item)`. The node runs the workflow twice, with `["a","b","c"]` and with `[]` | `[["a","b","c"],[]]` |
| `eachFailureStops` | each over `["a","b","c"]`: `failOn(each.item, "b")` then `record` | `[true, "check"]` for `error.startsWith("step check (failOn): bad item: b")` and `data.step` |
| `eachResumesMidLoop` | each over `["a","b","c"]` with `recordAsking`; the handler approves only the plumbing effects, so each round's interrupt reaches the test runner | `["a","b","c"]` |
| `eachStepLimitIsHard` | each over one item running `busyEcho` with `limits: { maxTime: 100 }`, workflow `maxTime: 5000`; the handler approves `std::guard` with more time | the same pair `stepLimitIsHard` returns |
| `matchInsideEach` | each over three emails; an LLM step reads `each.email.body` and returns `{ urgent: boolean }`; match on it records the email's id when true | `["e1","e3"]` with mocks true, false, true |
| `eachRoundHasItsOwnThread` | each over `["a","b"]` running `freshThreadOnly`, then `record("ok")`; result `recorded()` | `["ok"]` |
| `nestedTypeErrorNamesItsStep` | calls `checkWorkflow`, not `runWorkflow`: a `record` step inside a case inside a loop, with `text` set to the number `5` | `["save", "args.text"]` for the first problem's `step` and `field` |

`eachResumesMidLoop` needs one `{ "action": "approve" }` entry in `interruptHandlers` for each of the three rounds. Its expected output has each item once, which shows a resumed run did not repeat a finished round.

**Spawn test** in `workflow.spawn.test.ts`: write a workflow file whose only tool step is inside a case, run `agency workflow check` on it the way the file's existing tests do, and assert exit code 0 and that the "can raise" listing names the nested step.

- [ ] **Step 1: Write** `flow.agency`, `matchEach.agency`, and `matchEach.test.json`. Run `pnpm run fmt` on the two new `.agency` files only.
- [ ] **Step 2: Run** `pnpm run agency test tests/agency/workflow/matchEach.agency --check-capabilities > .agency-tmp/t9.txt 2>&1`. Expected: PASS for all ten nodes. A node that fails names a real defect in Tasks 2 to 6, or a wrong assumption in this plan. Fix the generator for the first. For the second, stop and report. `eachRoundHasItsOwnThread` is the one row that rests on run-time behavior no spike covered: whether a round's thread starts with no messages.

The Agency tests and the spawn test run the built `dist`. After any change to a `.ts` file, run `pnpm run build` before rerunning a test, or the rerun shows the old behavior.

Three existing files to copy from:

- `pausedWorkflowResumes` in `runMealPlan.agency` already shows an interrupt from the workflow's child reaching the test runner and resuming through `interruptHandlers`. `eachResumesMidLoop` is that test with three rounds.
- `tests/agency/decorators/stacked-rebind-resumes.agency` has a module-level `let` list that a def appends to and that survives a resume. The fixture's recording list follows it.
- `==` compiles to `__eq` in `lib/runtime/eq.ts`, which is `===` except that `null` equals `undefined`. So the number `1` does not equal the string `"1"`, and `matchWithNoCaseFails` rests on that.
- [ ] **Step 3: Write and run the spawn test:** `pnpm exec vitest run lib/cli/workflow/workflow.spawn.test.ts > .agency-tmp/t9-spawn.txt 2>&1`. Expected: PASS.
- [ ] **Step 4: Run the existing workflow run tests once**, since the generator changed under them: `pnpm run agency test tests/agency/workflow/runMealPlan.agency --check-capabilities > .agency-tmp/t9-meal.txt 2>&1` and the same for `check.agency` and `compile.agency`. Expected: PASS with no fixture change, because a workflow with no block generates the same source as before.
- [ ] **Step 5: Commit.**

---

### Task 10: Docs

**Files:**
- Modify: `docs/site/guide/workflows.md`
- Modify: `docs/dev/stdlib/workflow.md`

**Guide** (`docs/site/guide/workflows.md`):
- Rewrite the sentence that sends branches and loops to a function. It now says that a workflow can branch with `match` and repeat with `each`, and that retries and any other logic belong in a function.
- Add a section "Branching with `match`" and a section "Repeating with `each`". Each shows one workflow first and explains it after, with the same rules the tutorial lists in Task 8.
- Beside the `otherwise` example, add the warning the spec's third call asks for: a misspelt `is` is not reported, and with `"otherwise": []` the misspelt case is skipped.
- Add one paragraph on what a model decides: with a `match` on an LLM step's value, a model picks among the routes the author wrote. With an `each` over a list an LLM step produced, a model sets how many times the loop's steps run. Each action still asks for its own approval when it runs.

**Dev doc** (`docs/dev/stdlib/workflow.md`). Mechanism and rules only, no history:
- A section "Blocks: `match` and `each`" with one step of each kind and the code it becomes.
- The scope rule and where it lives (`referenceRule`'s `Scope`).
- Why a `match` is an if/else-if chain: `return` inside an Agency `match` arm returns from the arm.
- Why each round is in a `thread` block, and why a block has no value.
- That a block's own lines are line fragments in the same flat list as the statements, and that each fragment's `depth` sets its indent.
- That `locatedSteps` is the one function that knows where a step list can be, and why it accepts unchecked JSON.
- That `outputSchemas` from `checkWorkflowWithSchemas` now holds LLM steps inside blocks, so a host's editor has to apply the scope rule before it offers one to another step.
- In "Interrupts and checkpoints": a step in a loop raises once per round, and a paused run resumes at its round and statement.
- Remove the sentence that names wrapping tool steps in `thread { }` as the follow-up for agent steps, and say what is true now: top-level agent steps share `main`'s conversation, and each round of a loop has its own.
- The index line for this doc in `CLAUDE.md` still describes it. Leave it.

- [ ] **Step 1: Write** both docs. Check the prose against `~/.claude/skills/simplify-speech/general-writing-tips.md` and `verbal-tics.md`.
- [ ] **Step 2: Run** `pnpm run lint:structure > .agency-tmp/t10-lint.txt 2>&1`. Expected: PASS.
- [ ] **Step 3: Commit.**

---

### Task 11: Check and open the PR

- [ ] **Step 1:** Read the whole diff against `docs/dev/contributing/anti-patterns.md` and fix what it finds.
- [ ] **Step 2:** Run `pnpm run typecheck`, `pnpm run lint:structure`, and `pnpm exec vitest run lib/stdlib/workflow lib/cli/workflow > .agency-tmp/t11.txt 2>&1`. Expected: all PASS. Push only when they do. If Step 1 changed a `.ts` file, run `pnpm run build` first, because the vitest run includes the spawn test.
- [ ] **Step 3:** Commit the spec, the plan, and the three reviews beside them with the branch.
- [ ] **Step 4:** Write the PR description to a file and open the PR with `gh pr create --body-file <file>`, base `main`. The description says what a person can now write, shows one `match` and one `each` example, and lists the spec's five "Calls I made". Do not merge. The owner merges.

---

## What this plan leaves out

The spec's "Not in this change" list stands: a value out of a block, "repeat until", comparison operators, `limits` on a block, continuing after a failed round, parallel rounds, and the visualizer.
