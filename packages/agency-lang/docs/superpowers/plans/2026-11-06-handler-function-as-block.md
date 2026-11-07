# Compile a handler function as a block (issue #1373)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every statement in a handler function runs every time the handler runs, each run has its own variables, and a `return` anywhere in the handler function returns from it.

**Approach:** Before scope resolution, a small compiler pass turns the body of every inline handler function into one block argument. The builder then compiles that block with the block template it already uses for `map(xs) as x { ... }`, and calls it the way it already calls a named function used as a handler. A block has its own step counters and its own frame on every call, so nothing inside the handler is compiled specially any more. The runtime does not change.

**Tech stack:** TypeScript in `lib/preprocessors` and `lib/backends`, vitest, Agency execution tests.

**Spec:** GitHub issue #1373, plus the findings below. There is no separate spec.

All paths are relative to `packages/agency-lang` in the worktree `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-handler-nested`. The branch is `adit/handler-nested-handlers`. The worktree holds throwaway spike edits in `lib/backends/typescriptBuilder.ts`, `lib/preprocessors/typescriptPreprocessor.ts`, and `lib/runtime/runner.ts`, and two new test files under `tests/agency/handlers/`. Task 0 deals with them.

---

## Background

### Two words

The guide (`docs/site/guide/handlers.md`, "Raising interrupts inside a handler function") uses these names, and so does this plan:

```
handle {
  // the handler body
} with (intr) {
  // the handler function
}
```

### How a handler function compiles today

An ordinary function body compiles to numbered steps. A step that has finished is skipped when the program resumes from a checkpoint. A handler function can never pause, so it was given a simpler form: a plain JavaScript callback with no steps. The flag `insideHandlerBody` in `lib/backends/typescriptBuilder.ts` switches the builder into that mode, which has its own versions of `if`, `for`, `while`, and `match`.

The callback is a closure over the enclosing function's `runner` and `__stack`. A `Runner` is the state of one activation of one function: a `path` array, counters stored on the frame under that path, and the `halted` flag. Statement kinds with no plain version (`handle`, `with approve`, `thread`, `parallel`) compile to the step-counted form and borrow that Runner while it is in the middle of the statement that raised the interrupt.

### What is broken on main

All of these are reproduced by `tests/agency/handlers/handler-function-runs-every-time.agency` and `handler-function-across-resume.agency`, which fail on main.

| Inside a handler function | What happens on main |
|---|---|
| A second `with approve`, `with reject`, or `handle` block | Skipped. Its variable is left unset. |
| One `with approve`, and the handler runs for a second interrupt from the same statement | Skipped. The variable keeps the first interrupt's value. This is the safety case in the issue. |
| A `thread { }` block | Runs for the first interrupt only. |
| A `parallel { }` block | Runs for the first interrupt only. |
| The run pauses for the user between two runs of the handler | The nested handler is still skipped after the resume. The stray counter the first run wrote into the enclosing frame rides the checkpoint. |
| Two interrupts raised at once (two arms of a `parallel` block in the handler body) | The two runs of the handler share every variable. A run that sets `mine = 1` and then waits reads back `mine = 2`. |
| `return reject(...)` inside a nested `handle` block | The `return` exits the step callback, not the handler function. The reject is lost and the handler carries on to `approve()`. |

The first five come from borrowing the enclosing Runner: the nested construct reads the counter at the raising statement's path, runs once, and marks it finished. The sixth comes from handler variables living on the enclosing function's frame (`__stack.locals.<name>`). The seventh comes from mixing plain code and stepped code in one function.

### What the research found

Two candidates were spiked and run against nine new test cases and the 200 existing test files that contain an inline handler (all green on main).

- **A Runner change** that treats nothing under an executing handler as a replay fixes the first five rows and breaks nothing, but cannot fix the last two: those need a frame per run and a real `return`, which are code generation changes.
- **The block candidate** (this plan) fixes all seven rows and breaks nothing. The two failures first seen in `toolbox/listTools.agency` and `skills-dir.agency` are a test hygiene problem: each makes a symlink it never removes and fails on its third run on any compiler.

A named function used as a handler (`handle { } with check`) already works in every case, because a function has its own Runner and frame. This plan makes an inline handler function the same thing at runtime, with the one difference a block adds: it can read and write the enclosing function's variables.

### Why this does not add pause-and-resume risk

- Nothing new is serialized. The block's frame is pushed on the raising stack when the handler starts and popped when it ends, exactly like the frame of any function the handler calls today. The runtime asserts that an interrupt-pause checkpoint is never taken while a handler runs (`assertNoExecutingHandlers` in `agencyInterrupt.ts`, `guardTripInterrupt.ts`, `promptRunner.ts`, `runBatch.ts`), so no such checkpoint ever holds that frame. On main, by contrast, a nested `with approve` writes a counter into the enclosing frame, and that frame is serialized at the next pause.
- The step checks that now run inside a handler function (guard trip probe, pause request, debug hook, cancel) are each already gated at runtime by "a handler is executing" (`Runner.pauseIfRequested`, `Runner.maybeDebugHook`, `debugger.ts`), because named function handlers and every function a handler calls have gone through them since the feature was added.
- The hoist pass still skips the handler function, because the new pass runs after it. Every diagnostic that assumes a handler function cannot pause (AG1020 casts, AG1023 `?`, AG1028 `async`) stays correct as written.
- One case was traced but not tested: a function called from a handler can create a pinned checkpoint at its entry for `Result` error handling, and that checkpoint will now also hold the handler's frame. A rewind to it would re-enter the handler with its saved counters and skip to the call. On main the same rewind re-runs every statement in the handler before the call. The block shape is the safer one there.

### What changes for users

- The seven rows above work.
- A variable declared in a handler function is now private to that run of the handler. Today it is visible after the `handle` block, like a variable declared in an `if`. No test in the 200 relied on that.
- A handler function's steps now appear in coverage and source maps.

---

## Global constraints

- Do not change `lib/runtime/`. If a task seems to need it, stop and report.
- Do not change the parser or the `HandleBlock` type. The type checker and the formatter must see the same tree they see today.
- The new pass runs after `hoistCallsInProgram` and before `resolveVariableScopes` in `TypescriptPreprocessor.preprocess`.
- Follow `docs/dev/contributing/anti-patterns.md` and `coding-standards.md`: types not interfaces, arrays not sets, objects not maps, no dynamic imports.
- Save every test run's output to a file under the scratchpad (`$SCRATCH` below) and read the file.
- Run Agency tests with `--check-capabilities` after the path. `pnpm run build` before any `agency test` that should see a TypeScript change. After the builder changes (Task 4), `make compile-agency` as well: compiling a test file never recompiles the stdlib or the agents (the incremental build excludes `std::` imports, see `docs/dev/compiler/incremental-builds.md`), so without it `stdlib/supervise.agency`, `stdlib/decorators.agency`, `stdlib/policy.agency`, `stdlib/agency.agency`, and the agents under `lib/agents` keep their old handler code and Task 5 would test nothing.
- Never edit `CHANGELOG.md`. Never hand-edit `docs/site`.
- Commit messages go in a file and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Do not merge the PR.

## Review focus

Each has a test in the task named.

1. **A `handle` at the top level of a file, outside any function.** Settled: the parser-side check refuses it before the pass could see it (`lib/utils/topLevel.ts:71`, `handleBlock: false`, message at line 139). No test needed. One related fact goes in the dev doc: `resolveBlockScopes` runs only per function or node body (`typescriptPreprocessor.ts:866`) and per docstring, so a block value written at the top level, `const xs = map([1]) as x { handle { } with (intr) { } }`, gets no block scopes today, and this plan does not change that.
2. **A handler function that throws a JavaScript error.** The block template rethrows anything that is not an `AgencyAbort`, so the error should travel up as it does today. (Task 2)
3. **A handler function inside a block argument, and one inside another handler function.** Two nested block frames; outer variables must still resolve to the right frame. (Task 2)
4. **An interrupt raised in the handler function that no outer handler answers.** Today it is refused rather than paused. `tests/agency/handlers/handler-propagate-refused.agency` and `handler-raises-*.agency` pin this and run in Task 5.
5. **Guard limits while a handler runs.** `tests/agency/handlers/handler-guard-trip*.agency` and `handler-budget-scoping.agency` run in Task 5.

---

## Part 1: the fix (one PR)

### Task 0: Clear the spikes, keep the tests

- [ ] `git checkout lib/backends/typescriptBuilder.ts lib/preprocessors/typescriptPreprocessor.ts lib/runtime/runner.ts`
- [ ] The two test files and this plan stay untracked until their commits below. The superseded plan file is already deleted. The `.js` files beside the new tests are gitignored and rebuilt on every run; nothing to do for them.
- [ ] `find tests/agency -type l -newer package.json` and remove any leftover symlinks under `tests/agency/test-output`, `tests/agency/toolbox/test-output`, `tests/agency/toolbox/fixtures/tools/tools`, and `tests/agency/skills-dir-fixture/flat/flat`.

### Task 1: The failing tests

**Files (already written, uncommitted):**
- `tests/agency/handlers/handler-function-runs-every-time.agency` and `.test.json` (seven nodes: `sameStatement`, `severalInOneRun`, `threadRuns`, `parallelRuns`, `concurrentRuns`, `concurrentNested`, `returnInsideNested`)
- `tests/agency/handlers/handler-function-across-resume.agency` and `.test.json` (two nodes: `acrossResume`, `acrossResumeInLoop`)

- [ ] **Step 1: Add the shadowing node** the issue asks for, `outerKeepsItsValue`, to `handler-function-runs-every-time.agency`: `const label = "outer label"`, `let out = "unset"`, a `handle { out = asksOnce() } with (intr) { const label = "handler label" \n return approve() }`, and `return "${out} / ${label}"`. Expected after the fix: `"approved / outer label"`. On main: `"approved / handler label"`. Its `description` says this is the one visible change in meaning: a variable declared in a handler function is private to that run.
- [ ] **Step 2: Give each test a one-sentence `description`** that says what a reader sees on main when it fails (the values are in the table above). The `.test.json` files currently repeat the node name.
- [ ] **Step 3: Run both on the reverted branch** (Task 0 makes it equal to main for these files; never run tests from the main checkout). `pnpm run build` first.

```bash
pnpm run agency test tests/agency/handlers/handler-function-runs-every-time.agency --check-capabilities > "$SCRATCH/red-1.out" 2>&1
pnpm run agency test tests/agency/handlers/handler-function-across-resume.agency --check-capabilities > "$SCRATCH/red-2.out" 2>&1
```

Expected: 0/8 and 0/2.

- [ ] **Step 4: Commit** the four files: "Tests for a handler function whose statements are skipped or shared (#1373)".

### Task 2: Tests that pass on main and must keep passing

**Files:**
- Create: `tests/agency/handlers/handler-function-positions.agency` and `.test.json`

- [ ] **Step 1: One node per position.**

1. `insideBlockArgument`: `map([1, 2]) as x { handle { ... } with (intr) { ... } }`, where the handler reads `x` and appends to a node variable.
2. `handlerInsideHandler`: an inline handler whose function holds a `handle` block with its own inline handler; the inner one reads the outer parameter and writes a node variable.
3. `rejectsAndPasses`: an inner handler that returns `reject("no to 2")` when `intr.data.n == 2` and returns nothing otherwise, under an outer `with approve`; the node returns `isFailure(out)`.
4. `onClauseForm`: the `with { on test::outer(intr) { ... } }` form from `docs/dev/language/on-clause-handlers.md`.
5. `handlerThrows`: a handler function that does `const nothing = null` then `const size = nothing.name.length`. Wrap the `handle` so the node returns a string that says what happened.

- [ ] **Step 2: Run on main and write the observed output into the `.test.json`.** For `handlerThrows`, say in its `description` what main does.
- [ ] **Step 3: Commit:** "Tests that pin handler function behavior in nested positions".

### Task 3: The pass

**Files:**
- Create: `lib/preprocessors/handlerDesugar.ts` (the other in-place passes in this directory are `asyncDesugar.ts` and `prunePreludeShadows.ts`; match their naming)
- Create: `lib/preprocessors/handlerDesugar.test.ts`
- Modify: `lib/preprocessors/typescriptPreprocessor.ts`, `preprocess()`, between `hoistCallsInProgram` (line 387) and `resolveVariableScopes` (line 389)

**Produces:**

```ts
/** Rewrites the body of every inline handler function in `program` to a
 *  single `blockArgument` whose params are the handler's parameter and
 *  whose body is the original statements. Mutates in place and returns
 *  nothing, like desugarAsyncInProgram and prunePreludeShadows. Running
 *  it twice changes nothing. */
export function desugarHandlerFunctionsInProgram(program: AgencyProgram): void

/** The block the pass produced for this handler, or undefined when the
 *  handler is a function reference or has not been lowered. The builder
 *  reads this; nothing else decides what the lowered shape looks like. */
export function handlerFunctionBlock(handler: HandleBlock["handler"]): BlockArgument | undefined
```

**The shape.** The handler stays `kind: "inline"` with its `param`. Its `body` becomes `[block]`, one `blockArgument` node with `params: [param]`, `body: <the original statements>`, and `loc` copied from the first statement of the handler function, or from the handle block when the function is empty. (A `FunctionParameter` carries no `loc`, `lib/types/function.ts:18-30`. The block is the handler function, not the whole `handle` statement, so an error inside it should not point at the `handle` keyword when there is a better position.) `BlockArgument` is a member of `AgencyNode` (`lib/types.ts:108`), so no cast is needed. The builder reads `typeHint` off each block param for the TypeScript parameter annotation, as the old handler arrow did for `intr`, so a typed handler parameter compiles the same way as before. This is chosen over a new handler kind because every tree walker already descends into `handler.body` and already treats a `blockArgument` node as a block scope (`isInsideBlock` and `blockChain` in `lib/utils/node.ts` and `typescriptPreprocessor.ts`), so no walker changes. `handlerFunctionBlock` is the one place that knows the shape.

- [ ] **Step 1: Write the failing unit tests.** Use `parseAgency` (it returns a result; it does not throw) and `TypescriptPreprocessor` only where a whole-pipeline check is needed.

1. `lowers an inline handler function`: after the pass, `handler.kind === "inline"`, `handler.param.name === "intr"`, `handler.body` has one node of type `blockArgument` with `params[0]` the same object as `handler.param` (type hint kept), `body` the original statement objects in order, and `loc` equal to the first original statement's `loc`. A second case with an empty handler function asserts `loc` equals the handle block's.
2. `runs twice without change`.
3. `leaves a function reference alone`: `handle { f() } with myHandler` is untouched.
4. `lowers nested positions`: a handler inside a handler, inside a block argument, inside a `for`, inside an `if`, inside a `match` arm. Each is found by walking the result with `walkNodesArray` and asserting every `handleBlock` with an inline handler has one `blockArgument` body.
5. `handlerFunctionBlock` returns undefined for a function reference and for an unlowered inline handler, and the block for a lowered one.
6. `the handler parameter resolves as a block parameter and a handler local as a block local`: run the whole preprocessor on `node main() { let out = "" \n handle { out = f() } with (intr) { const seen = g(intr.data.n) \n out = seen \n return approve() } }` and assert the scopes: inside the block, `intr` reads as `blockArgs`, `seen` as `block`, and the assignment to `out` as `local`.

- [ ] **Step 2: Run them.** `npx vitest run lib/preprocessors/handlerDesugar.test.ts > "$SCRATCH/pass-red.out" 2>&1`. Expected: FAIL, module not found.
- [ ] **Step 3: Write the pass.** Do not write a tree walk. `walkNodesArray(program.nodes)` from `lib/utils/node.ts` already visits every statement, descends through `bodySlots` (so a statement kind added later is covered with no change here), and reaches a handler function's body and a block argument's body. Filter its result to `handleBlock` nodes whose handler is inline and not yet lowered, then mutate each one. Collecting first and mutating after keeps the walk undisturbed; the original statement array moves into the block unchanged, so an inner handle block the walk already found is still the same object.
- [ ] **Step 4: Run the unit tests.** Expected: PASS.
- [ ] **Step 5: Wire it in** with a comment of two lines: after the hoist pass so a handler function is still left unhoisted, as today; before scope resolution so the block gets block scope.
- [ ] **Step 6:** `pnpm run typecheck > "$SCRATCH/tc.out" 2>&1`. Expected: clean. (The builder still compiles the handler in plain mode at this point, and a `blockArgument` as a statement will compile to a block value that is never called. The Task 1 tests still fail. That is expected until Task 4.)
- [ ] **Step 7: Commit:** "Lower an inline handler function to a block argument".

### Task 4: The builder

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`, `buildHandlerArrow` (line 4242) and `processHandleBlockWithSteps` (line 4290)

- [ ] **Step 1: Split `buildHandlerArrow`.** Pull the part that builds `async (__run, __data) => await __call(__run, <callee>, { type: "positional", args: [__data] }, <config>)` into `private handlerArrowCalling(callee: TsNode): TsNode`. `buildHandlerArrow` keeps the built-in `approve`/`reject`/`propagate` branch and the scoped-name resolution, and ends by calling `handlerArrowCalling`.
- [ ] **Step 2: Replace the inline branch.** In `processHandleBlockWithSteps`, for `kind === "inline"`: `const block = handlerFunctionBlock(node.handler)`; if undefined, throw an internal error that names the pass (`desugarHandlerFunctionsInProgram` did not run). That is a true invariant: `TypeScriptBuilder` is constructed in one place, `lib/backends/typescriptGenerator.ts:74`, which runs `preprocess()` first, so do not look for other callers. Otherwise `handler = this.handlerArrowCalling(this.processBlockAsExpression(block))`. Delete the plain-mode compile of `handler.body` from this function. Leave the rest of plain mode in place; Part 2 removes it.
- [ ] **Step 3:** `pnpm run typecheck`, `pnpm run build`, `make compile-agency > "$SCRATCH/compile-agency.out" 2>&1`. This target compiles the stdlib and the agents and copies `docs/site` into `stdlib/docs`; it does not regenerate `docs/site`, so `git status` should show no change there. If it does, read the diff before doing anything with it.
- [ ] **Step 4: Run the Task 1 tests.** Expected: 8/8 and 2/2.
- [ ] **Step 5: Run the Task 2 tests.** Expected: the recorded outputs. A difference stops the work; write it up before going on.
- [ ] **Step 6: Read one generated file.** `pnpm run compile tests/agency/handlers/handler-function-runs-every-time.agency` and confirm the handler arrow is a single `__call` of a block, and that the block's `return approve()` compiles to `runner.halt(...)`.
- [ ] **Step 7: Note two error paths that change shape, for the dev doc.** (a) In plain mode, `assignmentInterruptGuard` (`typescriptBuilder.ts:3703`) and the `llm()` assignment path (`:3989`) throw "Cannot throw an interrupt inside a handler body" when a call in the handler returns an unanswered interrupt; in block mode the stepped guard halts the runner and the block returns the interrupt array, which `runHandlerChain` rejects as an invalid verdict. Both are errors; the message differs. The path should be unreachable, because `renderVerdict` (`interrupts.ts:612`) rejects any raise under a handler and the four `assertNoExecutingHandlers` sites throw first. (b) The block template catches `AgencyAbort` and returns an `AbortedResult`, which `runHandlerChain` rethrows with `result.toError()` (`interrupts.ts`, near line 404, the path a compiled def handler already takes). Today a plain handler lets the abort propagate directly. The `handler-guard-trip*.agency` tests in Task 5 are the check that the error arrives unchanged.
- [ ] **Step 8: Commit:** "Compile a handler function as a block and call it like a function handler (#1373)".

### Task 5: Everything that uses a handler

- [ ] **Step 1: The 200 files.** Save this script as `$SCRATCH/runsuite.sh` and run it from the worktree's `packages/agency-lang` with the label `fix`. It runs every `.agency` test whose source contains an inline handler in either spelling (`} with (` or the `on`-clause form `with {`), plus everything under `tests/agency/handlers/`, one output file each, and prints the files that did not fully pass. A file with no `.test.json` beside it is skipped, which is why `tests/agency/async/compile-errors/in-handler-function.agency` prints no pass count (on main too). The research run found 200 files this way.

```bash
#!/bin/bash
# usage: runsuite.sh <label>   (run from packages/agency-lang in the worktree; needs $SCRATCH)
out="$SCRATCH/suite-$1"; rm -rf "$out"; mkdir -p "$out"
( grep -rlE "\} with \(|with \{" tests/agency --include=*.agency; find tests/agency/handlers -name '*.agency' ) | sort -u > "$out/files.txt"
: > "$out/summary.txt"
while read file; do
  testJson="${file%.agency}.test.json"
  [ -f "$testJson" ] || continue
  outName=$(echo "$file" | tr '/' '_')
  node ./dist/scripts/agency.js test "$file" --check-capabilities > "$out/$outName.out" 2>&1
  summaryLine=$(grep -E "^[0-9]+/[0-9]+ tests passed" "$out/$outName.out" | tail -1)
  echo "$file :: ${summaryLine:-NO SUMMARY}" >> "$out/summary.txt"
done < "$out/files.txt"
grep -c "" "$out/summary.txt"
grep -v -E ":: ([0-9]+)/\1 tests passed" "$out/summary.txt"
```

Expected: 200 or so lines counted, and only the compile-errors file listed. Then remove the leftover symlinks named in Task 0. If `listTools.agency` or `skills-dir.agency` fail, remove the links and rerun those two alone before treating it as a regression.
- [ ] **Step 2: Agent and stdlib handlers.** `grep -rlE "\} with \(" stdlib lib/agents --include=*.agency` lists the files. Run the tests beside the agent files with `HOME` set to a scratch directory. Expected: the same results as main (`lib/agents/agency-agent/tests/turn.agency` already fails two cases under the capability check on main).
- [ ] **Step 3: Fixtures.** `make fixtures > "$SCRATCH/fixtures.out" 2>&1`, then `git diff --stat tests/`. Expected: only fixtures with an inline handler change. Read two of them.
- [ ] **Step 4: Unit tests for the changed areas.** `npx vitest run lib/preprocessors lib/backends > "$SCRATCH/unit.out" 2>&1`. Expected: PASS. A test that asserted the plain-mode output of a handler (`lib/backends/destructiveFlips.codegen.test.ts:48-49`, "an if inside a handle inside an inline handler body") may need its expectation updated to the stepped output; update its title and comment too, since they say the body compiles to plain JS. Also run every other unit test whose fixtures hold an inline handler. Do not keep a list; run whatever the grep finds, so the step cannot go stale:

```bash
npx vitest run $(grep -rln "with (intr\|with (data\|with (i)" lib --include=*.test.ts) > "$SCRATCH/unit-handlers.out" 2>&1
```

The parser and type checker tests in that set see the original tree, so they should pass untouched; a failure in one of them means the pass ran somewhere it should not. The two most likely to need an updated expectation are `lib/backends/typescriptBuilder.integration.test.ts` and `lib/backends/typescriptBuilder/destructiveTracking.test.ts`. A handler's steps now appear in source maps and coverage, so also check `grep -rl "with (" tests/integration/cli-main/fixtures/project/src/` (empty at the time of writing) and run any integration test over a matching fixture.
- [ ] **Step 5: Commit** the fixtures and any test updates: "Regenerate fixtures: handler functions compile as blocks".

### Task 6: Docs

**Files:**
- `docs/dev/runtime/interrupts.md`, "No pause inside handlers (issue #616)"
- `docs/dev/runtime/pause.md` line 71, `docs/dev/cli/debugger.md` line 314, `docs/dev/language/destructive-regions.md` line 28, `docs/dev/language/type-casts.md` line 211, `docs/dev/language/unwrap-operator.md` lines 135 and 189, `docs/dev/language/interrupt-as-value.md` line 92, `docs/dev/compiler/hoist-calls.md` line 47 (the table row "handler (`with (data)`) bodies"), `lib/preprocessors/hoistCalls.ts` line 340, `lib/backends/typescriptBuilder/destructiveTracking.ts` lines 112 to 116 and 192 (`plainFlip` stays until Part 2; its comment should say nothing reaches it now)
- `docs/site/guide/handlers.md` says nothing about the compiled shape, so no user-facing doc changes.
- `CLAUDE.md` and `.claude/skills/agency-runtime-docs/SKILL.md`: the index line for `docs/dev/runtime/interrupts.md`

- [ ] **Step 1: In `interrupts.md`,** replace the first sentence of the #616 section (a handler function compiles to a plain callback with no step counters) with the new mechanism, and drop or fix the link to `docs/superpowers/specs/2026-07-19-issue-616-no-pause-inside-handlers-design.md`, which is not in the tree. Add a short section "A handler function is a block" with: the pass and the one function that knows the lowered shape; where the pass sits and why (after the hoist pass, so a handler function stays unhoisted; before scope resolution, so it gets block scope; and after every other consumer of `handler.body`, which is why the type checker, the formatter, `bodyFacts`, `interruptAnalysis`, and the LSP see the original tree); that the builder calls the block as it calls a named function handler; that the rule against pausing is enforced by `executingHandlerEntries` and not by the shape of the code; that a handler's variables are its own per run; the top-level block value note from review focus 1; the two error-path notes from Task 4 step 7; and the untested pinned-checkpoint edge as an open note.
- [ ] **Step 2: Each other line** says a handler function has no steps or compiles to plain code. Change the reason, not the rule: the rule in each place (no debugger stop, no pause, the cast and `?` and `async` refusals, the hoist skip) still holds because a handler never pauses, which the runtime enforces.
- [ ] **Step 3:** Check the prose against `~/.claude/skills/simplify-speech/general-writing-tips.md` and `verbal-tics.md`.
- [ ] **Step 4: Commit:** "Docs: a handler function compiles as a block".

### Task 7: Checks and the PR

- [ ] `pnpm run typecheck`, `pnpm run lint:structure`, `npx vitest run lib/sourceIsText.test.ts`
- [ ] `npx prettier --check` on the changed `.ts` files, by name
- [ ] Read the diff against `docs/dev/contributing/anti-patterns.md`
- [ ] Push and open the PR against main. Body: the seven-row table, the approach in three sentences, why it adds no pause-and-resume risk (the four points above plus the abort path from Task 4 step 7, short), what changes for users, and that Part 2 follows. Do not merge.
- [ ] Comment on issue #1373 with the findings not in it: `thread`, `parallel`, the lost `return` in a nested block, the shared variables of concurrent runs, the stray counter that rides a checkpoint, and the note that the `if` case shadows the same way.
- [ ] File one issue for `toolbox/listTools.agency` and `skills-dir.agency`: each leaves a symlink behind and fails on its third run.

---

## Part 2: delete the step-free mode (a second PR, after Part 1 merges)

After Part 1 nothing reaches the plain-mode code in `typescriptBuilder.ts`. It is a second implementation of `if`, `for`, `while`, and `match`, and of the destructive pre-flip, kept only for handler functions. It goes in its own PR because it is a large deletion in the code generator and the fix is easier to review without it.

- [ ] Delete the field `insideHandlerBody` and follow the compiler errors: `processPlainBranching`, `processMatchExpressionPlain`, `processBlockPlain`, `processPlainForLoop`, `withPlainFlip`, `insidePlainMatchExpr` with the INVARIANT comment above it (`typescriptBuilder.ts:336-346`), `handlerFuncResultCounter`, `plainForLoopCounter`, `stepped()` whole (with both flags gone it is an identity wrapper with two call sites, `processBlockArgument` and `processBlockAsExpression`), `DestructiveTracking.plainFlip`, and the `insideHandlerBody` reads in `processKeyword` (`:811`), the bare-return branch of `processReturnStatement` (`:3542`), `processInterruptStatement`, `assignmentInterruptGuard` (`:3703`), and the `llm()` assignment path (`:3989`). Keep the stepped branch at each site.
- [ ] Update the comment above `COMPOUND_STATEMENT_TYPES` and anything `grep -rn "plain mode\|plain-mode\|insideHandlerBody" docs/dev lib` still finds.
- [ ] `pnpm run typecheck`, `pnpm run lint:structure`, `make fixtures` (expected: no changes), `npx vitest run lib/backends`, and the Task 5 step 1 run.
- [ ] Open the PR. Do not merge.
