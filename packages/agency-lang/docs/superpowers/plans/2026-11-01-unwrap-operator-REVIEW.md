# Review of the `?` operator plan

Reviewed: `docs/superpowers/plans/2026-11-01-unwrap-operator.md` against the spec and the code in this worktree on 2026-11-01.

## Verdict

The design is at the right altitude. It reuses the four things that already own these semantics: the hoist pass turns expressions into steps, `hoistPositions` says where that pass can lift from, the `is failure` pattern already lowers to the same `isFailure` call, and `isAssignable` does the return-type check. I looked for a cheaper place to do the lowering and there is none: a parse-time desugar cannot turn an expression into statements, and `hoistCalls` is the one pass that already does that.

Most of the plan's claims check out against the code. The type checker runs before the preprocessor, so it sees the `unwrap` elements (`lib/compiler/prepareProgram.ts:277`). Chain elements are parsed with no whitespace skipping, so adjacency comes for free as the plan says (`dotParser` at `lib/parsers/parsers.ts:3383` starts on the character itself). A `const` declared inside a `handle` block is a frame local and is visible after the block (`tests/typescriptGenerator/withModifier.mjs:380-382`), so the `with approve` expansion keeps the assigned name in scope. The diagnostic codes are free: AG1020 and AG2022 are the highest in use. The three `?.` hits outside the eight test files are a comment in `stdlib/data/news/gdelt.agency:47`, a comment in `tests/agency-js/stdlib-thread-messages/agent.agency:6`, and the string `"?.md"` in `tests/agency/stdlib/glob-question.agency:5`. None of them needs a change.

Four things have to be fixed before the plan is executed. They are listed first. The rest are smaller corrections.

## Must fix before executing

### 1. A bare `foo()?` statement is never lowered, and no diagnostic catches it

The spec promises that "a bare `foo()?` statement hoists `foo()` like any other piece". The plan's Task 5 only changes the `valueAccess` branch of `walk` and the tail rule. But a bare access-chain statement never reaches `walk`. The statement dispatcher has its own case for it (`lib/preprocessors/hoistCalls.ts:252-258`) which returns `recurseSlots(stmt, counter)` and does no extraction at all.

The position model does not save you either. In `hoistPositions`, a statement node is always recorded with the body's status, which is `liftable`, and only its own expressions are downgraded to `stuck` when the kind does not extract (`lib/preprocessors/hoistPositions.ts:67-75`). The bare statement is itself the `valueAccess` with the unwrap, so `checkUnwraps` sees it as `liftable` and reports nothing. The result is that `foo()?` on its own line compiles past the checker, is never split, and hits the codegen tripwire. That is exactly the "toolchain bug" throw the spec says a user can never reach.

Fix: give the dispatcher's `valueAccess` case an unwrap rule, the same shape as the `functionCall` case above it: when `hasUnwrap(stmt)`, call `walk(stmt, counter, false)` and return the temps followed by the rewritten expression. Then make the model agree: in `hoistPositions`, a `valueAccess` statement containing an unwrap extracts from its own expressions. Add a bare `foo(bar())?` program to the agreement test, because that is the case where the two would otherwise disagree (the pass would lift `bar()` while the model calls it stuck).

Note also that `foo()? with approve` does not parse today, because `withModifierParser` accepts only an assignment, a return, or a plain function call before `with` (`lib/parsers/parsers.ts:6688-6693`). That is probably fine, but the dev doc should say it, and Task 8 should not use that shape.

### 2. `?` inside a `parallel` arm needs a ruling, and the plan's expected output is wrong

The parallel design bans `return` at the top level of an arm (`docs/dev/language/parallel-blocks.md:370`). Each arm ends by returning an object of its bindings, and the compiler reads those bindings back after the fork (`parallel-blocks.md:142-152, 195-220`). The parallel desugar runs before the hoist pass (`lib/preprocessors/typescriptPreprocessor.ts:363` then `:379`), so the guard's `return __hoist_0` is inserted after the ban has been checked. An arm that takes that return hands back a failure object instead of `{ a }`, and the destructuring then reads `.a` off a failure.

The spec says "`?` returns the failure from the branch" and the plan's `parallelBranch` test expects "the def returned a failure". Neither matches how parallel works. An arm's failure never stops the enclosing function; the doc is explicit that "sibling arms keep running" and the function continues (`parallel-blocks.md:155`).

Pick one of two rulings and put it in the spec, the plan, and the dev doc:

- Refuse it. This is consistent with the `return` ban. `checkUnwraps` runs on the pre-desugar tree, so a `parallelBlock` ancestor is still visible to `walkNodes`, and the check is a few lines. The message can point at the same workaround the `return` ban implies: do the unwrap inside a `def` the arm calls.
- Define it as "the arm's bindings all become that failure". That needs a change to the desugar and a test that reads the bindings afterwards.

I recommend refusing. It is the smaller change, it matches an existing rule, and nothing in the stdlib count motivates `?` inside an arm.

### 3. An unwrap in an assignment target is unhandled

`obj?.field = 1` parses, because the assignment target is an access chain. The target chain is not an expression slot: `expressionSlots` for an assignment exposes only the index expressions inside the chain (`lib/utils/expressionSlots.ts:279-283`). So `hoistPositions` never lists the target, no AG1021 fires, the pass never lowers it, and codegen reaches the target emitter's chain switch (`lib/backends/typescriptBuilder/assignmentEmitter.ts:107`) with a kind it does not know.

Fix: have `checkUnwraps` walk every assignment's `accessChain` and refuse an `unwrap` element there with AG1021, and add a test for it. There is no sensible lowering for a `?` in a write target.

### 4. The agency-js fixture steps describe a prompt that does not exist

Task 1 Step 4 and Task 9 Step 3 say to run `agency test js` and "accept the new fixture when prompted", or delete `fixture.json` first "so it is written fresh". The runner does neither. When `fixture.json` is missing it prints the result and reports a failure (`lib/cli/test.ts:1419-1427`); when it exists it diffs and never writes. An executor following the plan literally will loop on a red test.

Fix: say what actually happens. Run the test, read the printed result (it is the content of the `__result.json` the test wrote), check every value by hand against the list in the task, and write it to `fixture.json` yourself. Then run the test once more to see the match pass.

## Should fix

### 5. The left side of `catch` is also a refused position

The spec lists "the fallback of a `catch`" among the positions the pass never rewrites. The left side is refused too: the whole `catch` expression is a boundary, and its left operand is `opaque` (`lib/utils/expressionSlots.ts:256-260`). So `parseName("x")? catch "fallback"` is AG1021. That is a line a model will write. The AG1021 message's advice ("move it to its own line") is right for it, but the spec, the dev doc, and the Task 4 `it.each` list should name the case so no one reports it as a bug later. The right side of `|>` is opaque as well (`expressionSlots.ts:263`).

### 6. One Task 5 test contradicts the tail rule

The test "hoists a trailing method call as a unit: `foo()?.name.trim()`" will not hold if it is written as `const x = foo()?.name.trim()`. In that position the chain is the statement tail, the dispatcher withholds `hoistSelf`, and the trailing `.name.trim()` stays inline on the `const`. The plan's own Step 3 says the trailing piece is "hoisted as a unit only if it contains a method call and `hoistSelf` is true". Either write the test in a non-tail position, such as `g(foo()?.name.trim())`, or change the expectation to "stays inline at the tail". Pin both shapes; they are the two readings an executor could take.

### 7. Files the plan names that do not exist, and files it misses

- `lib/backends/typescriptBuilder.test.ts` (Task 7) does not exist. Name the real file for the tripwire test before handing the task off.
- Two more switches over chain kinds need an `unwrap` case or a refusal: `lib/backends/typescriptGenerator/typeToString.ts:45` and `lib/backends/typescriptBuilder/assignmentEmitter.ts:107`. Do not count on `pnpm run typecheck` to find them; the chain code is mostly typed `any`.
- Task 1 should also update `docs/dev/language/null-and-undefined.md:114` and `:140-141`, which describe optional chaining as a deferred feature, and the builder comment at `lib/backends/typescriptBuilder.ts:1340-1355`, which explains the optional-index exception the task deletes.

### 8. Small gaps in the task text

- Task 9 Step 2 uses a node `pausedTwice()` that Step 1's agent source does not define. Add it to the source.
- Task 4 commits a skipped test and Task 6 unskips it. That is fine, but say so in the Task 4 commit message so the skip is not read as a forgotten test.
- Task 8's `handlers.agency` has `ask` bump a module-level `let`. That works, but the `rejected` node's "counter incremented after the `?`" check reads more clearly if the counter is bumped in `use` after the `?` line, which is the thing being tested.

## Checked and fine

These are the claims I went looking to break and could not.

- The `while` rewrite puts the condition's temps inside the loop body (`hoistCalls.ts:235-250`), so a guard emitted as a temp lands inside the loop and returns on the failing pass, as Review Focus item 4 wants.
- The `withModifier` AST carries `handlerName` as `"approve" | "reject" | "propagate"` (`lib/types/withModifier.ts:7`), which is what the `handleBlock` expansion needs.
- `bodyStatus` in `hoistPositions` is where the `with` opacity rule lives (`hoistPositions.ts:104-114`), and the plan's change there is the whole change the model needs.
- The ternary marker already excludes `?.` and `??` (`parsers.ts:4515`), so `a ?? b` and `cond ? a : b` are unaffected, and the plan's extension for `cond? a : b` is the one new case.
- The AG2024 check with `isAssignable(Result<any, any>, returnType)` is loose about the failure's data type, but the hand-written `return parsed` is no stricter in practice, and the message is right.

## Response (2026-11-01)

Every item was checked against the code and applied to the spec and the plan.

1. Bare `foo()?` statement: the dispatcher's `valueAccess` case gets an unwrap rule, `hoistPositions` treats such a statement as extracting, and `use(target())?` joins the agreement test (plan Task 5). The dev doc will say `foo()? with approve` does not parse (Task 10), and Task 8 uses only the assignment form.
2. `parallel` arms: refused with a new AG1024, checked on the pre-desugar tree (spec "Semantics" and the refusals list; plan Task 4). The `parallelBranch` execution test is replaced by a block-argument-inside-an-arm test.
3. Assignment targets: refused with a new AG1025 by walking every assignment's chain; `assignmentEmitter.ts` gets the codegen tripwire as well (Tasks 2, 4, 7).
4. Fixture recording: the plan now states what the runner does and tells the executor to write `fixture.json` by hand (Global Constraints, Task 1, Task 9).
5. Both sides of `catch` and the stages of `|>` are named in the spec, in the Task 4 `it.each`, and in the dev doc.
6. The trailing-method-call test is split into the tail and argument-position shapes.
7. The builder test is `lib/backends/unwrapTripwire.codegen.test.ts`; `typeToString.ts` and `assignmentEmitter.ts` are in Task 2; `null-and-undefined.md` and the builder comment are in Task 1.
8. `pausedTwice` is in the agent source; the Task 4 commit message names the skipped test; the handler test bumps its counter in `use` after the `?`.

## Second review (2026-11-01)

I re-read the revised plan and the revised spec and checked each change against the code. The four blocking items from the first round are resolved, and the fixes are the right ones:

- The bare-statement rule now lives in both the dispatcher and the position model, and the `use(target())?` agreement program is the test that would catch the two drifting apart.
- Refusing `?` at the top level of a `parallel` arm (AG1024) is consistent with the arm `return` ban, and the spec explains why in one paragraph. The replacement execution test (a block argument inside an arm) exercises the case that is allowed.
- AG1025 for assignment targets, plus the tripwire in `assignmentEmitter.ts`, closes the hole from both ends.
- The fixture steps now describe what the runner does.

Two refactors were added that I did not ask for, and both are good: `positionRefusals` takes the status loop out of `castPositions.ts`, which I checked fits (all three cast diagnostics take the same `{ cast }` params, `castPositions.ts:58-83`, so one params function covers them), and `chainPieces` makes the split a pure function with its own test. Exporting `resultCheckCall` instead of copying its shape is also right.

The plan is ready to execute once the small corrections below are made. None of them changes the design.

### Corrections

1. **Task 1, Step 4 names the wrong things in `index-missing-key-null`.** The `?.` lives in a whole node, `optChainNoThrow()` (`agent.agency:26-29`), not two fields in a larger object. `test.js:1` imports it and `test.js:8, 20, 22` read it into the fixture keys `optChainDeepIsNull` and `optNullIndexIsUndefined`. Delete the node, the comment block above it, the import and the three lines in `test.js`, and those two keys in `fixture.json`. The keys are not called `deep` and `optNull`.

2. **Stale line reference.** Task 4 points at `hoistPositions.ts:150-165` for `bodyStatus`. The file is 115 lines; the function is at `:104-114`.

3. **Counts and headings that still say five.** Task 4's heading says "AG1021 to AG1023" but the task adds AG1024 and AG1025. The Task 10 index line and the Task 11 PR description both say "five diagnostics"; there are seven. Fix the three places so the executor does not reconcile them on the fly.

4. **`lib/types/access.test.ts` does not exist yet.** Task 5 says to unit-test `chainPieces` there. Say "Create" so the executor knows it is new. There is precedent for functions in `lib/types/` (`binop.ts`, `comprehension.ts`), so the placement is fine.

5. **Task 8's `blockInsideParallel` snippet uses semicolons.** Agency statements are newline-separated. Write the arm on two lines in the task, or an executor copies the shape into the fixture and gets a parse error.

6. **Task 9 uses `reject("no")`.** The export is `reject(reason?: string)` from `lib/runtime/interruptResponse.ts:18`, so the call is right, but `restore-loop-after-resume/test.js` imports only `approve`. Say that `reject` comes from the same `./agent.js` import so the executor does not go looking.

### Checked and fine this round

- `typeToString.ts:40-50` prints an Agency expression as text; adding `case "unwrap"` that prints `?` is harmless there, because every position it renders is one AG1022 already refuses.
- The spec's refused-position list now names both sides of `catch` and the stages of `|>`, matching `expressionSlots.ts:256-263`.
- `frameClaims.test.ts` exists and is a reasonable model for the tripwire test.
- The AG1025 test uses `let o: any`, which keeps AG2023 quiet so the test counts only the target refusal.

## Response to the second review (2026-11-01)

All six corrections checked and applied to the plan: the `optChainNoThrow` node, its import, test lines, and the two fixture keys are named exactly (Task 1); `bodyStatus` is at `:104-114` (Task 4); the heading, the index line, and the PR description now say seven diagnostics; `lib/types/access.test.ts` is marked as a new file (Task 5); the `blockInsideParallel` arms are described on separate lines (Task 8); and `reject` is named as coming from `./agent.js` (Task 9).

## Response to the owner's notes (2026-11-01)

- Name: "the `?` operator" everywhere in prose, Rust's name; "try operator" and "unwrap operator" are gone. `unwrap` stays as the code name for the chain element because `?` cannot be an identifier, and both the spec ("Names") and the plan (Global Constraints) state that rule. The branch is now `adit/question-mark-operator` and the worktree `worktree-question-mark-operator`.
- Review Focus item 2 is reworded: the ternary line is a regression check that the existing "Agency has no ternary" refusal still fires, not an example of allowed syntax.
- Tarsec: Task 1 now has the implementer read the `?.` probes before deleting them and records what Task 2 copies (raw-input probe, plain `failure` on a miss, inside the `memo`'d `or`, no whitespace skipping, no committed failure). Task 2 points at the Task 1 commit for the pattern.
- `const foo = someFunc()?` was already the first lowering test in Task 5 and the spec's example. The spec now says that `let`, reassignment, compound assignment, and destructuring all share the assignment's value slot, and Task 5 pins each with a test.
