# Review: destructive pre-flip coverage plan

Plan: `docs/superpowers/plans/2026-10-26-destructive-preflip-coverage.md`

## Verdict

The approach is right and the plan can be executed after the fixes below. The core claim holds: outside an inline handler body, every statement body the builder compiles goes through `processBodyAsParts`, so a tracked assignment in any of those bodies really does get its own post-flip. I checked each body kind:

- `if`, `for`, `while`, `match`: `processIfElseWithSteps`, `processForLoopWithSteps`, `processWhileLoopWithSteps`, and `processMatchBlockWithSteps` all call `processBodyAsParts` (`lib/backends/typescriptBuilder.ts:1576`, `:1628`, `:1671`, `:1692`).
- `thread`: `processMessageThread` calls it (`:4003`).
- `handle` body and `with`: both call it (`:4284`, `:4292`).
- Block arguments: compiled with `stepped(() => processBodyAsParts(...))` (`:3106`), which turns flips back on even inside a handler body.
- Plain compilation (`processBlockPlain`, `processPlainBranching`) only happens when `insideHandlerBody` is true (`:725-767`), and skipping the inline handler slot already excludes everything under it.
- `finalize`, `guard`, `parallel`, and `seq` never reach `statementFlips` as statements. `finalize` is split off by `FinalizeCodegen` and its body is compiled with `processBodyAsParts`. The other three are desugared before codegen.

The `try` detail is also right: `walkNodes` descends into `tryExpression.call` (`lib/utils/node.ts:498`), so both nodes have to be in the `except` list, and the `callTarget` comment is stale.

Removing the pre-flip does not open a new gap when the callee throws. A tracked assignment at the top level of a function already depends on the post-flip alone today. The callee's own catch path turns a throw into a failure stamped with its flag, and the caller's post-flip reads that failure.

## Findings

### 1. The unit tests check an AST that codegen never sees for iterables and conditions (medium)

`setup` in `destructiveTracking.test.ts` only parses. Codegen runs on the preprocessed AST, and `hoistCalls` moves calls out of `for` iterables and `if` conditions into `const __hoist_N = ...` statements placed before the compound statement (`docs/dev/compiler/hoist-calls.md`, the position table). So in a real compile:

- `for (x in items()) { ... }` reaches `statementFlips` as `const __hoist_0 = items()` followed by `for (x in __hoist_0)`. The hoisted line is a tracked assignment and gets a post-flip. The loop has no destructive call left in it.
- `inCondition_` in `destructive-in-blocks.agency` probably passes today because of the hoisted temp's post-flip, not because of the `if` statement's pre-flip. Its comment ("the only flip that covers it is the conservative one on the `if` statement") is probably stale.

Effects on the plan:

- Unit test "a loop whose ITERABLE is a destructive call keeps the pre-flip" is still correct for the function, but it tests a shape that never reaches it. Keep it, but don't count it as a guard.
- Runtime case `destructiveIterable_` will print `[true]`, but through the hoisted post-flip, not the loop's pre-flip. It does not test what its table row says it tests.
- Review Focus item 2 and the "keeps the pre-flip" list in "The fix" name iterables and conditions as cases the pre-flip still handles. After hoisting, the cases where the pre-flip actually matters are the positions hoisting treats as opaque: the right side of `&&`/`||`, `catch` expressions, `try` operands that are not a plain tracked assignment, and bare call statements.

Fix: build once and run `pnpm run preprocess` on a function with a destructive iterable and a destructive `if` condition to confirm the hoisting. Then swap `destructiveIterable_` for a runtime case that really depends on the pre-flip: a loop body with `if (b && burn() > 0) { return failure("inside") }`, expected `[true]`. Reword Review Focus item 2 and the doc sentence in Task 3 so they don't credit the pre-flip with the iterable and condition cases.

### 2. `with` statements change behaviour, and the plan doesn't mention it (medium)

`withModifier` is in `COMPOUND_STATEMENT_TYPES`, and `bodySlots` gives it one slot, the wrapped statement. So after this change, `const r = rm(x) with approve` loses its pre-flip and depends on the inner post-flip alone. That happens everywhere, at the top level of a function too, not only inside a loop. The result is correct, because `processWithModifier` compiles the inner statement with `processBodyAsParts` (`:4292`), so the post-flip is there. But it is a visible change: a refusal under `with approve` used to report `true` and will now report `false`.

`with` positions are opaque to hoisting, so this shape reaches codegen as written. The existing `with approve` uses in `destructive-tracking.agency` (lines 89 and 103) wrap `handle` blocks. Check whether any of their expected outputs move.

Fix: add a unit test (`const r = rm("x") with approve` gets no pre-flip) and a runtime case (a refusal under `with approve` prints `[false]`). Add `with` to the Goal line, to the list in "The bug", to the dev doc sentence, and to the PR body.

### 3. `thread` and block arguments are in the goal but have no test (low)

The Goal names `thread`, and "The bug" names block arguments. Neither has a unit test or a runtime case. Add unit tests for:

- `thread { const r = rm("x") }`, which should get no pre-flip.
- `run() { const r = rm("x") }` as a bare call statement, which should get no pre-flip. `bodySlots(functionCall)` returns the block body.

Also write down one limitation, so nobody files it as a bug later. When the same constructs sit in value position, `const t = thread { ... }` or `const x = run() { ... }`, they keep the pre-flip, because `bodySlots` returns nothing for an `assignment`. That direction is safe, and the plan should say so in a sentence.

### 4. Two verification commands cannot fail (low)

- Task 2 Step 4 loops over five test files with output redirected, then greps for `FAIL`. The loop's exit status is only the last file's, and the grep depends on the runner's wording. Gate each file on its exit code instead: `pnpm run agency test tests/agency/$f.test.json || echo "FAILED: $f"`, then grep for `FAILED:`.
- Task 3 Step 1 says "expected: only `-` lines for `__destructiveRan = true`, no `+` lines", but the command prints a count with `grep -c`, and a count can't show that. Use two greps that must print nothing: `git diff tests/typescriptGenerator | grep '^+.*__destructiveRan = true'` and `git diff tests/typescriptGenerator | grep '^-.*isFailure('`.

### 5. Small things

- `ifRefused_` in the Task 2 table puts two statements on one line with `;`. Write them on separate lines, as `destructive-in-blocks.agency` does.
- `coveredCalls` finds the inline handler slot by `stmt.type === "handleBlock" && slot.retargetsReturn`. That works, but it relies on `retargetsReturn` meaning "the handler" for this node type. Comparing by identity, `slot.body === (stmt as HandleBlock).handler.body` when `handler.kind === "inline"`, says what it means and won't break if a future handle slot also retargets returns.
- There is no unit test with a `match` arm. The runtime case covers it, but a unit test costs one line and fails faster.
- Not in scope, but noticed: `processBodyAsParts` takes a `continue` for pipe chains before it calls `statementFlips` (`typescriptBuilder.ts:4356-4367`), so a pipe chain statement never gets a flip of its own. I did not check whether a destructive pipe stage is caught anywhere else. It may be worth a follow-up issue. It does not block this plan.
