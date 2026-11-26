# Review: Workflow `match` and `each` steps, implementation plan

The plan reviewed is `docs/superpowers/plans/2026-11-25-workflow-match-and-each.md`.

I read it against the revised spec and the architecture review, and checked its claims against the code in `lib/stdlib/workflow/`, `lib/cli/workflow/toolImports.ts`, `lib/runtime/eq.ts`, `stdlib/thread.agency`, and the existing workflow tests. I also type-checked one hand-written program with the built CLI from the main checkout, then deleted it. The program held an if/else-if chain that compares a string to the number `1`, and a `for` loop whose body is a `thread` block holding an LLM step's own `thread` block and a `return failure(...)`.

## Summary

The plan is ready to build after small fixes. It covers every reader of the step list that the spec names, it puts each Review Focus input in a named test, and the task order lets each task type-check on its own. The architecture review's three accepted findings are in it.

Three findings would make a task fail as written: an expected field that contradicts an existing test, a test that cannot fail, and a missing rebuild. The rest are smaller.

## 1. Task 2's unknown-kind row contradicts an existing test

The message table says an unknown kind is reported with the field `steps[i]`. Today it is reported on the step's id with the field `kind`. `parse.test.ts:75-79` asserts:

```ts
{ step: "note", field: "kind", message: 'kind must be "tool" or "llm", got "shell"' }
```

Two changes follow:

- The table row should read: field `kind`, on the step's id.
- The existing test's message changes to `kind must be "tool", "llm", "match", or "each", got "shell"`. Task 2 should name that test as one it edits. Otherwise Step 4's "Expected: PASS" fails on it, and a builder may "fix" the field to match the table.

A related gap is in the new `problemAt` rule. The plan says the field is "the rest of the issue's path after that prefix". When an issue's path ends exactly at a step that has an id, the rest is empty and the field prints as `""`. Say what the field is then. The nearest existing behavior is `steps[i]` for a top-level step, and the matching path for a nested one, such as `cases[0].steps[1]`.

## 2. Task 3's import test cannot fail as the fixture is described

`it("imports a tool used only inside a case")` checks that `findLists` from `./lists.agency` is imported for `matchPlan`. Task 1 describes `matchPlan` as "note → match … { "urgent": [list], "normal": [] } → done". It says both fixtures end in `done`, and that `eachPlan`'s `done` calls `findLists`. In `mealPlan`, the `list` step also calls `findLists` (`testFixtures.ts:24-29`). If `matchPlan`'s `done` calls `findLists` too, the tool is imported through the top-level step, and the test passes with or without the change.

The fix is to give the case a tool that no other step in `matchPlan` calls. `addListItems` is one choice: it also lets the `stepEffects` test check that `test::lists::add` comes from a nested step.

More generally, five tasks assert exact text that depends on these two fixtures. Examples are the id order in Task 1, `const step_route_on = inputs.level` in Task 5, the `list` step's depth, and the render test's lines. Write both fixtures out in full in Task 1, as JSON or TypeScript, instead of as one-line sketches. Two details need pinning:

- `matchPlan`'s `inputs` must declare `level`.
- `eachPlan`'s `add` step calls `addListItems`, which needs a `listId`. The only step that finds a list, `done`, comes after the loop, so `listId` has to be a literal or an input.

## 3. A generator fix in Task 9 needs a rebuild before the rerun

The Global Constraints say to run `make` once, in Task 8. Task 9 then says that a failing node "names a real defect in Tasks 2 to 6", and that the builder should fix the generator. The Agency tests and the spawn test run the built `dist`, so a fix to a `.ts` file under `lib/stdlib/workflow/` does nothing until it is built again. A builder who reruns the test without building will see the same failure and may chase it in the wrong place.

Add one line to Task 9 Step 2: after any `.ts` change, run `pnpm run build` before rerunning a test. The same applies to an anti-pattern fix in Task 11 before its vitest run of `lib/cli/workflow`, which includes the spawn test.

## 4. Two of Task 9's "no spike covered this" rows are now covered

Task 9 Step 2 tells the builder to stop and report if `matchWithNoCaseFails` or `eachRoundHasItsOwnThread` fails, because no spike covered them. The first is now settled, and part of the second:

- **`1` against `"1"`.** `const c = step_route_on == 1`, where `step_route_on` is a `string`, type-checks with no diagnostic. At run time, `==` lowers to `__eq` (`typescriptBuilder.ts:1418-1430`). `__eq` is `===` except that `null` and `undefined` are equal (`lib/runtime/eq.ts:12-14`). So `1 == "1"` is false, and the run fails with "no case matches", as the node expects.
- **A `thread` block per round.** A `for` body that is a `thread` block holding an LLM step's `let` and inner `thread`, then a `match` chain with a `return failure(...)`, type-checks cleanly. Whether the round's thread starts with no messages is still a run-time fact that only the node shows. So `eachRoundHasItsOwnThread` stays on the stop-and-report list, and `matchWithNoCaseFails` can come off it.

Two more facts help the builder of Task 9:

- `pausedWorkflowResumes` in `runMealPlan.agency` already shows an interrupt from the workflow's child process reaching the test runner and resuming through `interruptHandlers`. `eachResumesMidLoop` is that test with three rounds. Point the builder at it.
- A module-level `let seen: string[] = []` that a def appends to, and that survives a resume, has precedent in `tests/agency/decorators/stacked-rebind-resumes.agency`. So the fixture's recording list is an established pattern.

## 5. Task 1 should end with a clean type check

Task 1 Step 4 says "Expected: PASS, and type errors only in files later tasks change", then says to fix any error in `resolve.ts`, `lower.ts`, or `effects.ts` by narrowing. Read one way, Task 1 commits with type errors. Widening `Step` breaks `stepFields`, `stepLimits`, and `declaredBy` in `resolve.ts`, because each reads `step.context` or `step.limits` on a branch that now includes the block kinds. Step 4 should say that `pnpm run typecheck` passes before the commit, and that the narrowing is how it gets there.

## 6. Tests with no stated expectation

Several tests in the plan have empty bodies:

- Task 2: "accepts an empty case and an empty otherwise".
- Task 3: "refuses a reference from one case into another", "refuses a reference from result into a loop", "refuses a nested step whose generated name collides with a top-level one", "warns about an untyped tool that only an over reads", "gives no cost warning when the workflow sets maxCost", "warns for a handoff tool in a loop".
- Task 5: "gives otherwise the last else and writes no failure line".
- Task 6: "renders the same source twice".
- Task 7: the two import tests.

Most of them can point at a row of the message table they assert. Two need more than that:

- **"renders the same source twice".** `renderWorkflow` is a pure function of its input, so the test cannot fail. Cut it.
- **"warns about an untyped tool that only an over reads".** Every signature in `mealSignatures` has a typed return, so the test needs a signature whose `returnType` is `null` or `Json`. Say so, and say which tool. Likewise, "warns for a handoff tool" needs a signature with `handoff: true`, and none exists today.

## 7. The cost warning against the designer's instructions

`draftFrom`'s prompt tells the designer "do not add limits" (`stdlib/workflow.agency`, the Rules list after the catalog). Task 3 adds a warning on every `each` that holds an LLM step when the workflow has no `limits.maxCost`. So every drafted loop with an LLM step comes back carrying a warning that the designer was told not to fix. The warning passes through to the person. It does not trigger a redraft, so nothing breaks. But the person is the one who has to act on it, and the plan should say that is intended. The alternative is to let the tutorial say that a loop with an LLM step may set `limits.maxCost`.

A smaller point on the same warning: with nested loops, an LLM step in the inner loop makes both loops warn. One warning, on the outermost loop, says the same thing once.

## 8. Smaller points

- **The message for a cross-case reference.** A step in case 0 that reads a step in case 1 reads a step "later in the document", so the plan's table gives it "comes after this step". The author's mistake is reading across cases. The "inside a block this step is not in" message fits better. That needs the rule to check visibility before document order for a step outside the current scope chain. The test "refuses a reference from one case into another" should say which direction it checks.
- **Task 11 Step 3** commits the spec, its review, and the plan. The architecture review and this review are in the same folders, untracked, and belong in the same commit.
- **Task 6's Review Focus 4 test** feeds `problemsFromDiagnostics` a hand-made diagnostic on a computed line. That tests the new range mapping, which is the part that changed. It does not show that the type checker reports a nested argument's error on that line, and the plan's wording ("A type error three levels down") suggests it does. Either call the test what it is, or add one `checkWorkflow` call in an Agency test with a mistyped nested argument.

## What I did not question

The plan's structure (the flat list of fragments with a depth, the one `locatedSteps` walker, and the nine run nodes) follows the architecture review, and the owner accepted those changes. The owner set aside the review's finding 4 on hosts that draft workflows, so I did not reopen it.
