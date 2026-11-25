# Review: Workflows: `match` and `each` steps

The spec reviewed is `docs/superpowers/specs/2026-11-25-workflow-match-and-each.md`.

I read it against its own goals: a branch and a loop that a visual editor and the designer can write, and that a flowchart can draw from the JSON. I checked its claims against the code in `lib/stdlib/workflow/`, `lib/cli/workflow/toolImports.ts`, `stdlib/workflow.agency`, `docs/dev/stdlib/workflow.md`, and `docs/dev/runtime/interrupts.md`. I also type-checked a short hand-written program with the built CLI from the main checkout. That program had an LLM step inside a `for` loop, an if/else-if chain that included an impossible case, and a `for` over a number. I deleted the file afterwards.

## Summary

The design holds up. Each decision's reason checks out against the code:

- `return` inside a `match` arm returns from the arm (`docs/site/guide/match-expressions.md:82`), so decision 7 is needed.
- `return` inside a `guard` block returns from the guard (`shapes.ts:40-43`), so decision 9 is needed.
- An `if` and a `for` resume at the right branch, round, and statement (`interrupts.md:43-49` and `:107-126`), so the Checkpoints claim is true.
- Agent steps share `main`'s conversation today (`workflow.md` dev doc, the catalog section), so the second item under "Calls I made" is true.

The main problem is that the list of code that reads `workflow.steps` is incomplete. One of the readers it does name, `importsForSteps`, cannot use the proposed `allSteps` helper. After that, two kinds of change are missing: the new `each.` reference root needs changes in four places the spec does not name, and two of the "Left to the builder" items can be settled now. Details follow, most important first.

## 1. The `allSteps` list misses readers, and one named reader cannot use it

The spec says `toolSteps`, `importGroups`, `stepEffects`, and `importsForSteps` read `workflow.steps` directly and will move to `allSteps`. `grep -n "\.steps\b"` finds more readers. If any of these keeps reading only the top level, a nested step skips a check:

| Where | What it does | What goes wrong for a nested step |
| --- | --- | --- |
| `parse.ts:276` | Checks each step's `limits` against the workflow's | A step in a loop with `"limits": { "maxTime": 5000 }` and no workflow `maxTime` passes parse. The subprocess is then killed at `run`'s default, and the failure names no step. |
| `resolve.ts:263` (`collisionRule`) | Refuses two steps whose generated names collide | A nested step `note` with an argument `query`, next to a top-level step `note_query`, would not be refused, and template hygiene would rename a binder. |
| `resolve.ts:305-314` (`referencedSteps`) | Decides which untyped tools get a warning | A reference that appears only in a nested step's args, or in `on` or `over`, gives no warning. |
| `resolve.ts:404` | Builds the resolved steps | Becomes a tree walk. |
| `lower.ts:192` | Builds the `StepsById` map that `reference()` looks up | A reference to an enclosing scope's step is fine. But the map must hold every step, or `reference()` crashes on `steps[ref.step].value`. |

The spec does say that `guardLabels` and the LLM type declarations come from `allSteps`. I would turn the sentence "Each of them moves to the helper" into a complete list that includes the five rows above.

`importsForSteps` in `lib/cli/workflow/toolImports.ts` cannot use `allSteps(workflow: Workflow)`. It runs before parse, on raw JSON (`workflow: unknown`, line 156), because it describes the modules so that parse and resolve have signatures. Its own `toolSteps` has to walk `cases[n].steps`, `otherwise`, and an `each` step's `steps` defensively, skipping anything with the wrong shape, the way it does now. The spec should say so. Otherwise a builder will write `allSteps(workflow as Workflow)` and crash on a malformed file before parse can report it.

Suggested test: `agency workflow check` on a workflow whose only tool step is inside a case. Today that tool would not be imported, and the check would fail with "not among the tools passed".

## 2. The `each.` root needs changes in four places the spec does not name

The spec adds `each.<id>` as a reference root but only describes the resolve checks for it. These also change:

1. `REF_PATH` in `types.ts:53` accepts only `inputs|steps`. Parse refuses `each.note.id` as "not a well-formed path" until the regex changes.
2. `REF_PARTS` and `resolveRef` in `resolve.ts:103-110` split a path into two kinds. `ResolvedRef` (`types.ts:121-123`) needs a third kind for an item.
3. `reference()` in `lower.ts:44-57` writes a step reference as `step_<id>` plus `.value` when the step holds a `Result`. An item reference is written as `step_<id>_item` and never gets `.value`.
4. `refLabel` in `lower.ts:74-79` writes the label the model sees for a context value, such as `Context 1 (steps.text.body)`. An item reference would get no label unless it learns the new root.

These belong in the "Parse" and "Lower" sections.

## 3. Two "Left to the builder" items can be settled now

I type-checked a program with the shape the spec describes:

- **A `for` over a value that is not a list.** `for (x in bad)` with `const bad = 5` gives `AG2006: For-loop iterable must be an array or Record, got 'number'`, on the `for` line. That line is the one the spec gives to `over`, so the problem lands on the right field with no extra work. Two cases remain:
  - A Record passes the check and is iterated, so an `over` that points at an object runs its steps once per entry with no error.
  - An `over` into an untyped tool's value is not checked at all.

  Parse cannot see types, so the second case is covered only by the existing untyped warning, and then only once `referencedSteps` reads `over` (finding 1). I would write both facts into the spec and drop the item from the builder's list. Whether to refuse a Record is a design call. I lean toward leaving it, because the type checker cannot tell a Record from a list of unknown items.
- **A case whose `is` can never equal the value.** `step_route_on == "spam"`, where `step_route_on` has the type `"urgent" | "normal"`, type-checks with no diagnostic. So a typo in `is` produces no warning. When the step has no `otherwise`, a typo such as `"urgnet"` makes every urgent email fail the run with "no case matches", which a person will notice. When the step has `"otherwise": []`, the urgent case is skipped with no error and nothing reports it. The spec should say which behavior it accepts. One cheap option: when an `on` reference reads an LLM step whose `output` is a union of literals, resolve already has the type text and could compare each `is` against the union. If that is more than this change wants, the guide should warn about the typo case.

The `_toSource` item is already covered. `lower.test.ts:52` pins that a value holding `${evil} """ }` prints as an escaped literal, and every prompt and argument already relies on that. The spec can drop it.

The LLM-step item can also be dropped. A `let` of the output type and a `thread` block inside the `for` body type-checked cleanly. A run test is still worth having (finding 5).

## 4. The block lines add a fourth way text enters the program

The dev doc (`workflow.md`, "How workflow text enters the program") says workflow text reaches the source through three doors: `literal()` for values, `isIdentifier`-checked tokens through `statement()` for names, and `typeText.ts` for types. It also says every generated statement comes from `SHAPES` through `statement()`. The spec's block lines, such as `if ({{on}} == {{is}}) {`, are text joined outside `statement()`. The `{{is}}` piece is a printed literal placed in a name-shaped token. In `shapes.ts`, a `{{token}}` with no entry in `TOKEN_CHECKS` must pass `isIdentifier`, and `"urgent"` does not pass it.

The reason for the tree is sound. Filling the children into a `for ({{item}} in #over) { #body }` shape would make hygiene rename the loop variable, and it would lose each child's line range. A smaller change would keep the doors as they are:

- Build the condition with `expression()` from a new shape, `caseTest: "{{on}} == #is"`, with `is` filled by `literal(value)`. The value then enters through door 1, as every other value does.
- The only text outside a shape is the fixed punctuation: `if (`, `) {`, `} else if (`, `} else {`, `for (`, ` in `, and `}`. Render prints that text around printed expressions.

The `for` line needs only `{{item}}` and `{{over}}`, which are generated names. Then the dev doc's rule changes from "every statement comes from `SHAPES`" to "every statement and every block condition comes from `SHAPES`". That is easier to keep true than a separate token check for printed literals.

## 5. Tests the spec should add

The test list covers the main behaviors. These cases are missing, and each one matches a gap above or the motivating example:

- **A `match` inside an `each`, with `on` reading `each.<id>`.** "For every email, if it is urgent, text me" combines the spec's two problem examples, and it is the case most authors will write first. It also needs an LLM step inside the loop, which no listed test runs.
- **Nested loops.** The inner loop's `over` reads `each.outer.items`, and an inner step reads both `each.outer` and `each.inner`.
- **The nested-reader checks from finding 1.** A nested step with `limits.maxTime` and no workflow `maxTime` is refused. A nested name collision is refused. A nested tool is imported by `agency workflow check`.
- **`stepEffects` and `raises`.** A tool inside a case that raises an effect not in `raises` is reported on its own step.

## 6. Smaller points

- **The cost warning covers only LLM steps.** The first item under "Calls I made" warns when an LLM step sits inside an `each` with no `maxCost`. A tool step that calls an agent costs as much or more, and the catalog already knows which tools are `handoff` defs. Either the warning covers tool steps whose signature has `handoff: true`, or the spec says why it does not. Also, this warning is a new resolve output, and it belongs in the Resolve section's list next to the new problems.
- **The shared-conversation follow-up.** The spec says the `thread { }` follow-up "should merge before this change does" and also that it "stays its own change". A loop makes the cost grow with the square of the list length: round 10 resends rounds 1 to 9. I would state it as a prerequisite that the plan orders first, so a builder does not ship the loop without it.
- **A list from a model sets how many times a tool runs.** The "What changes for a reader of the first spec" section covers a model picking a route. An `each` over an LLM step's list also lets the model choose how many times a step's tool runs, and with which item each time. Each round still raises its own interrupt with that round's arguments, so the safety argument holds. The section should say this too, in the same words the guide will use.
- **The module doc comment.** `stdlib/workflow.agency:38-40` says "A workflow has tool steps, LLM steps, and references … Anything else belongs in an Agency function that a tool step calls." That comment generates `docs/site/stdlib/workflow.md`, so it needs the same rewrite as the guide sentence. The "Other places that change" list names only the guide.
- **Problem fields for a malformed nested step.** Today a step with no usable id gets the field `steps[3]` (`parse.ts:297`). The spec does not say what field a malformed step inside a case gets. `cases[1].steps[0]` on the `match` step would be consistent with the other new fields.
- **The owner of the "no case matches" lines.** The spec gives the `else` line to `otherwise` when there is one. With no `otherwise`, the `else { return failure(...) }` lines need an owner too. `on` or `cases` would both work, and the spec should pick one.
- **Recursive zod schema.** `step` is a `z.discriminatedUnion` (`parse.ts:199`). Making it recursive needs `z.lazy` or getter-defined objects, and how a discriminated union handles a lazy member in zod 4 is worth one quick check before the plan relies on it. This is a note for the plan, not a design question.

## What I did not question

The decisions the spec marks as the owner's (2a and 5) are not discussed here. The same goes for the decisions in the "Not in this change" list and the visualizer section. They are consistent with the rest of the spec, and I found nothing in the code that argues against them.
