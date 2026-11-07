# Review of the plan "Compile a handler function as a block (issue #1373)"

Plan under review: `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-handler-nested/packages/agency-lang/docs/superpowers/plans/2026-11-06-handler-function-as-block.md`

I read the plan, the spike diffs still in the worktree, the two new test files, and the compiler and runtime code the plan names. Every claim below that says "verified" is one I checked against a file and line in this worktree. Paths below are relative to `packages/agency-lang` in the worktree unless written in full.

## Verdict

The approach is sound and the plan is close to ready. The block candidate reuses machinery that already works for a named function handler and for `map(xs) as x { }`, and I found nothing in the runtime that the new shape would trip. Four things need fixing before the plan is executed. The first one would make a whole verification step pass without testing anything.

1. The stdlib has to be recompiled with `make` after the builder change, or Task 5 checks stale code.
2. The test-suite script the plan depends on lives in another session's scratch directory and will not exist for the executor.
3. A top-level `handle` is refused by the compiler today, so Task 2 item 6 and review focus 1 have a definite answer the plan can state.
4. The shadowing case the issue asks for has no test.

The rest are smaller corrections and a few facts worth recording in the dev doc.

## What I verified and agree with

- **The shape.** `HandleBlock.handler.body` is `AgencyNode[]` and `BlockArgument` is a member of `AgencyNode` (`lib/types.ts:108`), so the lowered body `[block]` needs no cast. The spike's `as unknown as AgencyNode` can go.
- **The pass position.** `hoistCallsInProgram` runs at `lib/preprocessors/typescriptPreprocessor.ts:387` and `resolveVariableScopes` at the end of `preprocess()`. Nothing between them walks a handler body. Every other consumer of `handler.body` runs before `preprocess()` or on a fresh parse: the type checker (`lib/compiler/compile.ts:194` checks before `generateTypescript`), `bodyFacts`, `effects`, the symbol table, `interruptAnalysis`, `parallelDesugar`, `asyncDesugar`, `injectSchemaArgs`, `liftCallbacks`, `patternLowering`, the formatter, and the LSP. So the constraint "the type checker and the formatter see the same tree" holds, and it holds because of where the pass sits. Say that in the dev doc section: it is the reason a later pass can change the tree without touching any of those.
- **Scope resolution.** `resolveBlockScopes` (`typescriptPreprocessor.ts:650`) registers a block frame per `blockArgument` ancestor, puts `let` and `const` declarations in the innermost block (pass A), and stamps `blockArgs` for a block parameter and `block` for a block local (`resolveInChain`). A bare assignment to a name owned by no block falls through to `lookupScope`, so `out = seen` inside the handler resolves to the enclosing function's `local`. The Task 3 test 6 assertions match what the resolver produces.
- **The block template.** `lib/templates/backends/typescriptGenerator/blockSetup.mustache` returns `runner.haltResult` after a `return` and `undefined` when the body falls off the end. `runHandlerChain` (`lib/runtime/interrupts.ts`, just after line 400) treats `undefined` as "pass", so a handler block that returns nothing votes the same way a named function handler does. A block does not return its last expression, so there is no risk of a trailing `print(...)` becoming the verdict.
- **The call.** `__call` on the block pushes a frame on the current stack through `setupFunction(__run)` and pops the same stack in `finally`. That is what the plan's "pushed on the raising stack when the handler starts and popped when it ends" means, and the template comment explains why the pop uses `__bsetup.stateStack` and not `__ctx.stateStack`.
- **The step hooks are gated.** `pauseIfRequested` (`lib/runtime/runner.ts:384`) and `maybeDebugHook` (`runner.ts:432`) both return early when `stack.hasExecutingHandlers()` is true. `runHandlerChain` also wraps every handler call in `ctx.enterToolCall()`, and `pauseIfRequested` returns early inside a tool call too, so a pause inside a handler is refused twice over. The guard-trip gate is at `lib/runtime/guardTripInterrupt.ts:93`, which reads `executingHandlerEntries` and throws the trip error instead of surfacing it.
- **Only one builder entry point.** `TypeScriptBuilder` is constructed in exactly one place, `lib/backends/typescriptGenerator.ts:74`, and that function runs `preprocess()` first. So the internal error Task 4 step 2 throws when `handlerFunctionBlock` returns `undefined` is a true invariant, not a path some other caller can reach. Say so in the plan so the implementer does not go looking for other callers.
- **Review focus 4 and 5 are covered by existing tests.** `tests/agency/handlers/handler-propagate-refused.agency` calls `read` inside a handler under a propagating outer handler, and the refusal at `interrupts.ts:612` turns it into a failed `Result`. The guard-trip and budget-scoping tests exist under `tests/agency/handlers/`.

## Must fix

### 1. `make` is needed after Task 4, or Task 5 tests the old stdlib

The plan says "`make` is not needed in this plan". That is wrong for this change, and the consequence is a check that cannot fail.

The stdlib's compiled `.js` siblings (`stdlib/**/*.js`) are produced by `make compile-agency`, which runs `agency compile stdlib/` (`Makefile:135-137`). Compiling a test file never recompiles the stdlib: the incremental-build doc says the closure walker excludes `std::` imports (`docs/dev/compiler/incremental-builds.md`, the `stdlibHash` row). `pnpm run build` only runs tsc. So after Task 4 changes the builder, `stdlib/supervise.agency`, `stdlib/decorators.agency`, `stdlib/policy.agency`, `stdlib/agency.agency`, and `stdlib/agents/agency/coding.agency` keep their old plain-mode handler code until `make` runs. Task 5 step 2 would then "pass" while exercising code the change never touched. The same is true of the compiled agents under `lib/agents` (`make agents`).

The manifest's `compilerStamp` row says a changed compiler does invalidate stdlib entries, so one `make compile-agency` after Task 4 step 3 is enough; it does not need `make clean`. Put it in Task 4 step 3 ("`pnpm run typecheck`, `pnpm run build`, `make compile-agency`") and delete the "`make` is not needed" line from the global constraints. Task 5 step 3 already runs `make fixtures`, which rebuilds dist but not the stdlib, so it does not cover this.

### 2. The suite script is in another session's scratch directory

Task 5 step 1 runs `$SCRATCH/runsuite.sh`. That file exists only at `/private/tmp/claude-501/-Users-adityabhargava-agency-lang-packages-agency-lang/7c3d8933-91c1-4f63-b420-ce2186ef632d/scratchpad/runsuite.sh`, and it hardcodes that same directory as its output root. A new session gets a different scratchpad, so the script will not be there and `$SCRATCH` will not match what is inside it.

The script is fifteen lines. Put its text in the plan under Task 5, with the output root taken from `$SCRATCH` and the worktree path taken from `pwd`. Two details from it belong in the plan's prose as well: the file list is `grep -rlE "\} with \(|with \{" tests/agency` plus everything under `tests/agency/handlers`, so it includes the `on`-clause form, which is why it finds about 200 files while `} with (` alone finds 192; and a file with no `.test.json` beside it is skipped, which is why `tests/agency/async/compile-errors/in-handler-function.agency` prints no pass count.

### 3. A top-level `handle` is refused today; say so and drop the node

Task 2 item 6 hedges: "If main refuses it, record the message... and leave the node out." It does refuse it. `lib/utils/topLevel.ts:71` has `handleBlock: false`, and line 139 gives the message "a handler". The example the plan points at, `tests/agency/handlers/with-modifier-global.agency`, is a top-level `with approve`, which desugars to a handle block with a built-in handler, not an inline handler function. So review focus 1 has a definite answer: the parser-side check refuses a top-level `handle` before the pass could see it. Write that in the plan and remove item 6.

One adjacent fact is worth a line in the dev doc. `resolveBlockScopes` is called only per function or node body (`typescriptPreprocessor.ts:866`) and per docstring (`:874`). A block value written at top level, such as `const xs = map([1]) as x { handle { ... } with (intr) { ... } }`, gets no block scopes today, and this plan does not change that. That is the same behavior as main, so it needs no work, only a note so nobody mistakes it for a regression later.

### 4. Add the shadowing test the issue asks for

Issue #1373 ends with "Add a test for each row of the table above, and one for the shadowing case." Neither new test file has the shadowing case, and the plan's "What changes for users" names it as the one visible semantic change: a handler local is now private to its run. That change deserves a test that pins it.

Add a node to `tests/agency/handlers/handler-function-runs-every-time.agency` modelled on the issue's `shadows` example: an outer `const label = "outer label"`, a handler function that declares `const label = "handler label"`, and a return of `"${out} / ${label}"`. On main it returns `body value / handler label`. After the fix it returns `body value / outer label`. The `description` should say that.

## Should fix

### 5. One plain-mode branch the plan does not list changes an error message

`assignmentInterruptGuard` (`lib/backends/typescriptBuilder.ts:3703`) and the `llm()` assignment path (`:3989`) emit, in plain mode, `throw new Error("Cannot throw an interrupt inside a handler body")` when a call inside the handler returns an unanswered interrupt value. In block mode the stepped guard emits `runner.halt(interrupts); return`, so the block returns the interrupt array as the handler's verdict, and `runHandlerChain` rejects it with its invalid-shape error instead. Both are errors, so nothing silently changes, but the message a user would see does.

I believe this path is unreachable: `renderVerdict` rejects any raise under a handler (`interrupts.ts:612`), and the four `assertNoExecutingHandlers` sites throw before a pending interrupt could be handed back to compiled code. The plan should say this in Task 4 or in the dev doc, and Part 2's deletion list should name these two branches explicitly. It currently says "the assignment guards", which is loose.

### 6. A fifth point for "why this does not add pause-and-resume risk"

The block template catches `AgencyAbort` and returns an `AbortedResult`. `runHandlerChain` then rethrows it with `result.toError()` (the comment near `interrupts.ts:404` says this is exactly for a compiled def used as a handler). Today a plain-mode handler lets the abort propagate as an exception directly. So a guard trip, a cancel, or any other abort inside a handler now takes a value-then-rethrow path instead of a straight throw. The existing `handler-guard-trip*.agency` tests are the check that the error arrives unchanged. This is the one place where the block shape changes how an error travels, and it belongs in the dev doc list next to the other four points.

### 7. Two files missing from the Task 6 doc list

- `docs/dev/compiler/hoist-calls.md:47` has a table row that says handler bodies "compile to plain JS, cannot pause". The reason column needs the same change as the other lines: the rule stays, the reason is the runtime gate.
- `lib/backends/destructiveFlips.codegen.test.ts:48-49` has a test titled "an if inside a handle inside an inline handler body" whose comment says the body compiles to plain JS. Task 5 step 4 mentions updating its expectation; the title and comment need updating too.

`lib/backends/typescriptBuilder/destructiveTracking.ts:112-116` and `:192` describe `plainFlip`. Part 2 deletes it, but Part 1 ships with it in place, so its comment should at least say it is reached by nothing after this change. The guide page `docs/site/guide/handlers.md` says nothing about the compiled shape, so no user-facing doc changes; the plan could say so in one line.

### 8. Tests outside `lib/preprocessors` and `lib/backends` that may snapshot handler output

A handler function's steps now appear in source maps and coverage. Task 5 step 4 runs only `lib/preprocessors` and `lib/backends`. Before pushing, find any other unit test whose fixture holds an inline handler and run it:

```
grep -rln "with (intr\|with (data\|with (i)" lib --include=*.test.ts
grep -rl "with (" tests/integration/cli-main/fixtures/project/src/
```

The coverage fixtures under `tests/integration/cli-main/fixtures/project/src/` are the ones most likely to carry an expected step count. If any match, add them to Task 5 step 4.

### 9. Small corrections

- Task 1 step 2 says "Run both on main". The work happens on the branch after Task 0 reverts the spike, which equals main for these files. Say "on the reverted branch" so nobody checks out main and runs tests from the main checkout (see the standing rule about never running tests from the main checkout).
- The `.js` siblings the spike left beside the new tests are gitignored (`.gitignore:28`) and are recompiled on each run, so Task 0 needs no step for them. One line saying so saves the implementer a look.
- Task 3's `loc` for the new block is "copied from the handle block". The block is the handler function, not the whole statement, so an error inside it would point at the `handle` keyword. Use the handler parameter's location, or the first handler statement's, and say which.
- Part 2 says "the plain half of `stepped()`". Once both flags are gone, `stepped()` is an identity wrapper with two call sites (`processBlockArgument` and `processBlockAsExpression`) and should be removed whole, along with the long INVARIANT comment above `insidePlainMatchExpr` at `typescriptBuilder.ts:336-346`.
- `processKeyword` (`typescriptBuilder.ts:811`) and the bare-return branch of `processReturnStatement` (`:3542`) are two more `insideHandlerBody` reads. "Follow the compiler errors" will find them, but listing them keeps the Part 2 PR description honest about its size.
- The dev doc section `docs/dev/runtime/interrupts.md:563` links a spec file `docs/superpowers/specs/2026-07-19-issue-616-no-pause-inside-handlers-design.md` that does not exist in this tree. Not this plan's fault, but Task 6 step 1 edits that section, so fix or drop the link while there.

## Answers to the plan's review focus items

1. **Top-level handle.** Refused by `lib/utils/topLevel.ts:71` before the pass runs. Drop the node; see must-fix 3.
2. **A handler that throws.** The template rethrows anything that is not an `AgencyAbort`, and `runHandlerChain` has no catch around `entry.fn`, so a JavaScript error travels up as it does today. The `handlerThrows` node in Task 2 is the right check.
3. **Nested blocks.** `resolveInChain` walks the ancestor chain innermost-first and records `blockDepth`, and `scopedVar` uses `blockFrameVar(depth)` to pick the frame variable. A handler inside a block argument, or a handler inside a handler, is two entries in that chain. The Task 2 nodes cover it.
4. **An unanswered raise inside a handler.** Refused at `interrupts.ts:612` as today; `handler-propagate-refused.agency` pins it. Unchanged by this plan.
5. **Guard limits while a handler runs.** Gated at `guardTripInterrupt.ts:93`; the error now returns through the block as an `AbortedResult` and is rethrown by the chain. See should-fix 6 for the doc note.

## What I did not verify

- The "pinned checkpoint at a function entry inside a handler" case the plan says it traced but did not test. I did not trace it. The plan's reasoning (the block shape leaves saved counters, so a rewind skips to the call rather than re-running the handler from its first statement) is plausible, and recording it as an open edge in the dev doc is enough for this PR.
- Whether the 192 inline-handler test files all pass under the fix. The plan says the spike was green on all of them; Task 5 step 1 re-runs them, which is the right check once the script is in the plan.
