# Second review of "Compile a handler function as a block (issue #1373)"

Plan: `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-handler-nested/packages/agency-lang/docs/superpowers/plans/2026-11-06-handler-function-as-block.md`

First review: `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-handler-nested/packages/agency-lang/docs/superpowers/plans/2026-11-06-handler-function-as-block-review.md`

## Verdict

Ready to execute after three small corrections. Every point from the first review is in the revised plan, and the ones I could check against the code check out. The three corrections are all in text the revision added: one instruction cannot be followed as written, one list is wrong, and one step has no stated reason.

## What the revision fixed, verified

- **`make compile-agency` after the builder change.** In the global constraints and in Task 4 step 3, with the reason. The target compiles `stdlib/` and the staged agents in one `agency compile` call (`Makefile:119-122`), so one target covers both.
- **The suite script is in the plan.** It takes its output root from `$SCRATCH` and runs from the worktree. It uses `node ./dist/scripts/agency.js`, which `pnpm run build` in Task 4 step 3 produces first. The prose explains the two grep spellings and the skipped compile-errors file.
- **Top-level `handle` settled.** Task 2 item 6 is gone and review focus 1 cites `lib/utils/topLevel.ts:71` and `:139`. The top-level block value note is routed to the dev doc.
- **The shadowing node.** `outerKeepsItsValue` with `asksOnce`, so the expected strings are `"approved / outer label"` after and `"approved / handler label"` on main. Both are right: `asksOnce` returns `"approved"`, pass A of `resolveBlockScopes` makes the handler's `const label` a block local, and on main the handler local compiles to `__stack.locals.label`. The expected red count is 0/8.
- **The two error paths** are in Task 4 step 7 and routed to the dev doc and the PR body.
- **The builder invariant** (one constructor call site) is stated in Task 4 step 2.
- **The doc list** now has `hoist-calls.md:47`, the `destructiveFlips` test's title and comment, the `plainFlip` comment, the missing spec link, and the note that the guide needs no change.
- **Part 2's deletion list** names `processKeyword`, the bare-return branch, the two guards, the INVARIANT comment, and `stepped()` whole.
- **Task 1 step 3** says "on the reverted branch", and Task 0 notes the gitignored `.js` siblings.
- **Task 5 step 2's grep is complete.** I checked for the `on`-clause spelling (`with {`) under `stdlib` and `lib/agents`: there is none, so `} with (` finds every stdlib and agent handler function.
- **The integration coverage fixtures** under `tests/integration/cli-main/fixtures/project/src/` hold no inline handler at the moment, so the check in Task 5 step 4 will come back empty. Keep the check; it is cheap.

## Must fix

### 1. A handler parameter has no `loc`

Task 3, "The shape", says the block's `loc` is "copied from the handler parameter". `FunctionParameter` (`lib/types/function.ts:18-30`) has `type`, `name`, `aliases`, `typeHint`, `validated`, `variadic`, and `defaultValue`. It has no `loc`. The instruction cannot be followed.

Use the `loc` of the first statement in the handler function, and fall back to the handle block's `loc` when the function is empty. Say that in the plan and in the unit test for the lowered shape (Task 3 step 1, test 1), which should assert where the `loc` came from.

### 2. The unit-test list in Task 5 step 4 is wrong

The plan says the grep lists nine files "at the time of writing" and names them. Running the grep today lists twenty-three:

```
lib/analysis/interrupts.test.ts
lib/backends/destructiveFlips.codegen.test.ts
lib/backends/onClauseHandlerFormat.test.ts
lib/backends/typescriptBuilder.integration.test.ts
lib/backends/typescriptBuilder/destructiveTracking.test.ts
lib/lowering/patternLowering.matchExpr.test.ts
lib/parsers/errorExamples.test.ts
lib/parsers/function.test.ts
lib/parsers/handleBlock.test.ts
lib/parsers/onClauseHandler.test.ts
lib/preprocessors/guardDesugar.test.ts
lib/preprocessors/hoistCalls.test.ts
lib/preprocessors/hoistPositions.test.ts
lib/typeChecker.test.ts
lib/typeChecker/asyncChecks.test.ts
lib/typeChecker/castPositions.test.ts
lib/typeChecker/crossModuleEffectDiagnostics.test.ts
lib/typeChecker/guardConstruct.test.ts
lib/typeChecker/handlerAndDeadCodeNarrowing.test.ts
lib/typeChecker/matchExhaustiveness.test.ts
lib/typeChecker/resultFailureShape.test.ts
lib/typeChecker/unwrapChecks.test.ts
lib/typeChecker/validateStaticInit.test.ts
```

The two most likely to change expectations, `typescriptBuilder.integration.test.ts` and `destructiveTracking.test.ts`, are missing from the plan's list. Do not list files in the plan at all. Replace the list with the command that runs whatever the grep finds, so it cannot go stale:

```bash
npx vitest run $(grep -rln "with (intr\|with (data\|with (i)" lib --include=*.test.ts) > "$SCRATCH/unit-handlers.out" 2>&1
```

The parser and type checker tests in that set see the original tree, so they should pass untouched. A failure in one of them would mean the pass ran somewhere it should not, which is worth knowing.

### 3. The `git checkout docs/site/stdlib/safeBash.md` step has no cause

Task 4 step 3 ends with "Then `git checkout docs/site/stdlib/safeBash.md` if it changed." Nothing in `make compile-agency` writes to `docs/site`. The target compiles the stdlib and the agents and then copies `docs/site` into `stdlib/docs` (`Makefile:119-122` and the `stage-stdlib-docs` recipe at `:31-39`); it does not run `agency doc`. So the file will not change, and if it did, the plan would be throwing away a real change without looking at it.

Delete the line. If it came from a full `make` run during the research (which does run `doc`), say that instead and keep the rule from the global constraints: never hand-edit or blindly revert `docs/site`; look at the diff first.

## Minor

- Task 5 step 1 says "Expected: 200 or so lines counted". The grep with both spellings plus the handlers directory is what found 200 in the research run; `} with (` alone finds 192. Fine as written, since the script uses both spellings.
- Task 3's unit test 1 says `params[0]` is "the same object as `handler.param`". That is fine for the pass, but the builder's `processBlockAsExpression` reads `p.typeHint` off each param, so the type hint on `intr` now reaches the block's TypeScript parameter annotation (`formatTypeHintTs`). The old arrow did the same thing, so no behavior change. One line in the plan would save the implementer checking.

## Not re-checked

I did not re-trace anything the first review marked verified, and I did not run any test. The two open items from the first review stay open: the pinned-checkpoint edge is recorded as an open note in Task 6, and the 200-file run is Task 5 step 1.
