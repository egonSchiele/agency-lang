# Architecture review: workflow `match` and `each` steps

The plan reviewed is `docs/superpowers/plans/2026-11-25-workflow-match-and-each.md`.

The plan is sound in its main shape. Four findings would change it. They come first, and the checklist follows.

## Findings that change the plan

### 1. The plan writes the "where is a step list" rule three times

A step list can be in four places: the workflow's `steps`, a case's `steps`, a match's `otherwise`, and an each's `steps`. The plan gives that knowledge to three walkers:

- `locatedSteps` in `types.ts` (Task 1), over a typed `Workflow`;
- `problemAt` in `parse.ts` (Task 2), over raw JSON, to find which step owns an issue's path;
- `toolSteps` in `lib/cli/workflow/toolImports.ts` (Task 7), over raw JSON, to find tools to import.

A future step kind that holds a step list has to be added to all three. If the CLI's walker is missed, `agency workflow check` says a nested tool "is not among the tools passed", which points a person at the wrong mistake.

One walker can serve all three if it accepts unchecked JSON:

```ts
/** Every step-shaped object in the tree, in document order, with its JSON
 *  path. Skips anything that is not an object or not a list. */
export function locatedSteps(workflow: unknown): { step: Record<string, unknown>; path: (string | number)[] }[];
export function allSteps(workflow: Workflow): Step[]; // the same walk, typed
```

- `toolSteps` in the CLI filters its result for `kind === "tool"`.
- `problemAt` picks the located step whose path is the longest prefix of the issue's path and whose `id` is a string. The plan's paragraph that describes a path walk goes away.

This is a case where tying the code together is right. The three walkers must agree, and nothing gains from letting them drift.

### 2. A flat list with a depth is simpler than a block tree

Tasks 5 and 6 add three types (`Block`, `BlockSection`, `BodyItem`) and a recursive printer. The tree exists for one reason: a block's opening line, such as `for (a in b) {`, does not parse alone, so it cannot be a `Fragment`.

A smaller change gives the same output. Keep `Lowered.body` a flat list, and let an item be either code or one line of fixed text, each with a depth:

```ts
export type Fragment =
  | { code: Code; owner: Owner | null; depth: number }
  | { line: string; owner: Owner | null; depth: number };
```

Lower writes the opening line at depth `d`, the children at `d + 1`, and the closing `}` at `d`. Render stays almost as it is: it already prints each fragment, indents the lines, and builds ranges from a flat list with `rangesOf`. The only change is that the indent comes from the fragment and a `line` item prints as itself.

What this saves: three types, the recursive `printBody`, and the rewrite of the existing lower tests that index into `lowered.body`.

### 3. `Block` is already a type name in `render.ts`

`render.ts:111` declares `type Block = { lines: number; owner: Owner | null }`, a run of printed lines. The plan adds a different `Block` in `types.ts` and a `Printed` type in `render.ts` that is nearly the existing `Block`. Finding 2 removes the new `Block`. If the tree stays, the plan should name it something else and reuse the existing type for printed lines.

### 4. The tutorial change reaches every host that drafts workflows

Task 8 teaches `DESIGN_TUTORIAL` the two kinds. From that release on, `designWorkflow` and `draftWorkflow` can return a workflow with a `match` or an `each` for any request that reads like a branch or a loop.

BMO calls `draftWorkflow` and shows the draft in its own editor. An editor that draws a flat list of steps will get a step kind it does not know. No function signature changes, so nothing fails at compile time.

The plan should say this, and the owner should pick an order: BMO's editor learns to draw or refuse the two kinds before it takes the release, or Task 8's tutorial change waits for it. A parameter on `draftWorkflow` that turns the kinds off is not worth adding.

## Checklist

### Major features and API

`std::workflow`'s public functions keep their signatures: `checkWorkflow`, `compileWorkflow`, `runWorkflow`, `writeWorkflow`, `workflowTool`, `catalog`, `designWorkflow`, `draftWorkflow`, `checkWorkflowWithSchemas`. The format stays `1`. A workflow with no block generates the same source as today, and Task 9 step 4 checks that.

The language, the runtime, and the handler scaffold are not touched. The scaffold's handler still wraps the whole body, so every block is inside it. Task 9's `eachStepLimitIsHard` pins that for a step inside a loop.

Two downstream effects, both small:

- `checkWorkflowWithSchemas` returns `outputSchemas` keyed by step id. It will now include LLM steps inside blocks. An editor that offers every key to every later step will offer some the check refuses. The dev doc section in Task 10 should say that a host applies the scope rule too.
- Finding 4.

### Effort and impact

| Task | Effort | Impact | Verdict |
| --- | --- | --- | --- |
| 1 Step tree | Small | Required by all | Keep, with finding 1 |
| 2 Parse | Medium | Required | Keep |
| 3 Resolve | Medium to large | Required. The scope rule is the feature's main rule | Keep |
| 4 Shapes and lines | Small | Required | Keep |
| 5 Lower | Medium | Required | Keep, smaller with finding 2 |
| 6 Render | Medium | Required | Small with finding 2 |
| 7 CLI walk | Small | Required, or the CLI refuses any nested tool | Keep, smaller with finding 1 |
| 8 Tutorial | Small | The designer is how most workflows get written | Keep, see finding 4 |
| 9 Run tests | Medium, and it costs CI time on every run | Mixed | Trim, see below |
| 10 Docs | Small | Proportionate | Keep |

Three items are low impact for their cost:

- **`Located.loops`** (Task 1). Nothing reads it. Resolve tracks enclosing loops in its own `Scope`. Drop the field.
- **Thirteen run nodes** (Task 9). Each node starts a subprocess and compiles a program. Workflows are one stdlib module with one host today, so thirteen nodes is more CI time than the feature should take. Four can go with no loss:
  - `matchOnBoolean`: Task 4's shape test already pins a boolean case.
  - `eachOverEmptyList`: run it as a second call inside `eachRunsInOrder`.
  - `nestedLoops`: the references are pinned in resolve and lower. A `for` inside a `for` is the language's to test.
  - `matchDoesNotCoerce`: fold it into `matchWithNoCaseFails` by giving that node a case `is: 1` and the input `"1"`.

  That leaves nine nodes.
- **The cost warning** (Task 3). It is cheap, so it can stay. It is the one rule in the plan that names a tool property, `handoff`. If it grows a second special case, cut it.

Docs are sized correctly. The guide page is the workflows page, so two sections there are in the right place. The dev doc gets one section in a doc that already exists.

### The 80/20 rule

The goal is that a visual editor and the designer can write a branch and a loop, and that a flowchart can show them.

I looked for a cheaper route and did not find one that keeps the goal:

- **Only one of the two kinds first.** Tasks 1, 2, 3, 5, and 6 are the tree, and both kinds need it. The second kind adds about a fifth to the work.
- **A flat list with a `when` field.** Already set aside in the spec, because a flowchart cannot draw it.
- **A block that calls another saved workflow.** The list would stay flat, but each round would start a subprocess and ask `std::workflow::run`, and the flowchart would span files.

The savings are inside the plan: findings 1 and 2, and the test trim.

The lasting cost is that every later change to the generator has to handle nested steps. That cost is contained in `lib/stdlib/workflow/`, and the first spec reserved it.

### Reusing code

- `ResolvedMatchStep.on` and `ResolvedEachStep.over` reuse `Binding`. Good.
- `caseTest` and `noCase` go through `statement()` like every other shape. Good.
- The duplicate `Block` name and the near-copy `Printed` type are finding 3.
- The three walkers are finding 1.

### Reusing and unifying concepts

A person learns four new things: the `match` step, the `each` step, the `each.` reference root, and the rule that a step inside a block is read only inside it. `each.<id>` reuses the step id, so there is no second name to learn. `otherwise` is the only new word beyond the two kinds. I see nothing further to merge.

### Tying concepts together

- The walkers should be tied. See finding 1.
- The tutorial and the guide state the same rules in two files, as they do today for the existing step kinds. The plan keeps that arrangement and does not add a third copy.
- The tutorial ties an Agency release to what a host's editor can draw. See finding 4.
