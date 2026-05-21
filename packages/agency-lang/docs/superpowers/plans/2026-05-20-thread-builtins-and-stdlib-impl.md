# Thread Builtins and `std::thread` Module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Reference spec: `docs/superpowers/specs/2026-05-20-thread-builtins-and-stdlib-design.md`.

**Goal:** Add `__internal_systemMessage`, `__internal_userMessage`, `__internal_assistantMessage`, `__internal_getCost`, `__internal_getTokens` builtins; expose them via a new `std::thread` stdlib module; track per-branch cost/tokens with parent-seeded values and join-time delta propagation; remove the `system()` builder macro.

**Strategy:** Build bottom-up — runtime per-branch tracking first (testable in isolation), then runtime context message API, then JS builtins, then codegen registry + `needsStack` plumbing, then the stdlib `.agency` module, then the breaking-change migration of all `system()` callers. Tests added alongside each layer that introduces user-visible behavior.

---

## Pre-flight

- [ ] **Sanity check the current tree is green**

  ```bash
  pnpm test:run 2>&1 | tee /tmp/preflight-test.log
  ```

  If any failures exist that are unrelated to this work, surface them before continuing.

- [ ] **Confirm working baseline file (foo.agency)**

  Note the current contents of `foo.agency` — Task 7 may use it for manual end-to-end checks and need to revert. Skip those steps if you don't want to touch it.

- [ ] **Read the design spec end-to-end**

  `docs/superpowers/specs/2026-05-20-thread-builtins-and-stdlib-design.md`. Pay attention to:
  - Naming convention (all builtins are `__internal_*`).
  - The branch-seeding + delta-propagation cost model.
  - Why race losers ARE propagated (their cost is real spend).
  - The `needsStack` codegen extension.

---

## Task 1 — `StateStack`: serialized `localCost` / `localTokens`

**Goal:** Add per-branch accumulators to `StateStack`, plumbed through serialization. Zero behavior change yet (no writes, no reads).

- [ ] **Step 1: Add fields to `StateStack`**

  In `lib/runtime/state/stateStack.ts`, on the `StateStack` class:

  ```ts
  // Per-branch cumulative LLM cost (USD) and tokens. Seeded from
  // the parent stack's value when this stack is created as a fork/race
  // branch; otherwise starts at 0. LLM calls in runPrompt add their
  // cost/tokens here. See spec doc for the join-time propagation model.
  localCost: number = 0;
  localTokens: number = 0;
  ```

- [ ] **Step 2: Extend `StateStackJSON` and `toJSON`/`fromJSON`**

  Add `localCost: number; localTokens: number;` to `StateStackJSON`. Update `toJSON()` to emit both (defaulting to 0 if undefined for backward compatibility with older checkpoints). Update `fromJSON()` to restore them (defaulting to 0 when absent).

- [ ] **Step 3: Verify unit tests still pass**

  ```bash
  pnpm vitest run lib/runtime/state/stateStack.test.ts 2>&1 | tee /tmp/task1.log
  ```

  All existing tests should still pass — we've only added zero-initialized fields.

- [ ] **Step 4: Add round-trip serialization test**

  Append to `lib/runtime/state/stateStack.test.ts`: construct a `StateStack`, set `localCost = 3.5` and `localTokens = 200`, round-trip through `toJSON` → `JSON.stringify` → `JSON.parse` → `fromJSON`, assert both values survive.

---

## Task 2 — `runPrompt`: write to local stack's accumulator

**Goal:** After every LLM completion, add the completion's cost/tokens to the active branch's `StateStack`.

- [ ] **Step 1: Add the write in `_runPrompt`**

  In `lib/runtime/prompt.ts`, immediately after the existing `updateTokenStats({ globals, usage, cost })` call (currently line 153), add:

  ```ts
  const targetStack = stateStack ?? ctx.stateStack;
  targetStack.localCost += completion.cost?.totalCost ?? 0;
  targetStack.localTokens += completion.usage?.totalTokens ?? 0;
  ```

  `stateStack` is already in scope inside `_runPrompt` (it's threaded down from `runPrompt`'s `args.stateStack`).

- [ ] **Step 2: Verify nothing else changed**

  ```bash
  pnpm vitest run lib/runtime/prompt 2>&1 | tee /tmp/task2.log
  ```

  All existing prompt tests should still pass — the new writes are purely additive.

- [ ] **Step 3: Write a focused unit test**

  Add a new test in `lib/runtime/prompt.test.ts` (or a sibling) that uses the deterministic LLM client (`lib/runtime/deterministicClient.ts`) and asserts:
  - After one `runPrompt` call, `ctx.stateStack.localCost === DETERMINISTIC_COST`.
  - After a second `runPrompt` call, `ctx.stateStack.localCost === 2 * DETERMINISTIC_COST`.

---

## Task 3 — `Runner`: seed branches and propagate on join

**Goal:** Branches inherit parent's `localCost`/`localTokens` at creation; on join (fork or race), each branch's delta propagates back to the parent.

This is the most subtle task — the join paths interleave with checkpoint creation and the `popBranches()` / `deleteBranch` cleanup. Make sure cost propagation happens BEFORE branches are dropped from the parent state.

- [ ] **Step 1: Add a helper for branch seeding**

  In `lib/runtime/runner.ts`, add a small private method on `Runner` (or a free helper at module scope) so both `runForkAll` and `runRace` can share it:

  ```ts
  /** Seed branch.stack.localCost / localTokens from the parent stack
   *  unless they're already populated (e.g., restored from a checkpoint
   *  on resume). Idempotent. */
  private seedBranchCost(branchStack: StateStack, parentStack: StateStack): void {
    if (branchStack.localCost === 0 && branchStack.localTokens === 0) {
      branchStack.localCost = parentStack.localCost;
      branchStack.localTokens = parentStack.localTokens;
    }
  }
  ```

  Add it next to the abort-signal wiring sites for clarity.

- [ ] **Step 2: Call `seedBranchCost` in `runForkAll`**

  In `runForkAll` (around line 681-707), inside the `items.map((item, i) => { ... })` block where `existing = this.frame.getOrCreateBranch(branchKey)` is created. Call `this.seedBranchCost(existing.stack, stateStack)` immediately after the abort-signal setup, BEFORE the branch is invoked.

  Skip the seed when `existing.result !== undefined` (resumed-completed branch — leave it alone).

- [ ] **Step 3: Call `seedBranchCost` in `buildRaceBranchPromise`**

  Same idea in `buildRaceBranchPromise` (around line 793-816). Add the call after the abort-signal wiring, before invoking `blockFn`.

- [ ] **Step 4: Add a fork-end propagation helper**

  Add another private helper:

  ```ts
  /** Propagate cost/tokens deltas from a set of branches back to the
   *  outer stack. Delta = branch.localCost - parentStack.localCost (the
   *  inherited baseline). Caller invokes this BEFORE popBranches() or
   *  deleteBranch — otherwise the branch stacks are gone. */
  private propagateBranchCost(
    branches: BranchState[],
    parentStack: StateStack,
  ): void {
    const baseCost = parentStack.localCost;
    const baseTokens = parentStack.localTokens;
    let costDelta = 0;
    let tokensDelta = 0;
    for (const branch of branches) {
      costDelta += branch.stack.localCost - baseCost;
      tokensDelta += branch.stack.localTokens - baseTokens;
    }
    parentStack.localCost += costDelta;
    parentStack.localTokens += tokensDelta;
  }
  ```

- [ ] **Step 5: Propagate in `runForkAll` success path**

  At the end of `runForkAll`, just before the final `return settled.map(...)` (currently line 769), gather every branch via `this.frame.getBranch(this.forkBranchKey(id, i))` for `i in 0..items.length`, filter out undefined/result-only ones if needed (everything should still exist here), and call `this.propagateBranchCost(branches, stateStack)`.

  Do NOT propagate in the interrupts path — interrupted branches are still pending, and their saved `localCost` is preserved on the branch stacks (which are themselves serialized into the checkpoint). On a future resume cycle, when the fork finally returns no-interrupts, the propagation runs and includes everyone's final cost.

- [ ] **Step 6: Propagate losers in `runRace` BEFORE `deleteBranch`**

  In `runRace`, the loser branches are deleted in BOTH the interrupt path (around line 939-942) and the value path (around line 964-967). At each delete loop, IMMEDIATELY BEFORE the delete loop, gather loser branches and call `this.propagateBranchCost(losers, stateStack)`. This makes the loser cost "stick" on the parent before the loser state is dropped.

  This means race's loser cost is locked into the parent checkpoint (if interrupt path) or final parent stack (if value path) — never lost.

- [ ] **Step 7: Propagate the winner in `runRace` and `resumeRaceWinner`**

  - **Value path of `runRace`** (after `setResultOnBranch`, before/after the loser propagation+delete): propagate the winner branch (single-element array) into `stateStack`. Order: propagate losers, propagate winner, then `deleteBranch` losers, then return.
  - **Interrupt path of `runRace`**: do NOT propagate the winner yet — the winner is still pending. Propagate losers only, save the winner's interrupt info, stamp the checkpoint, return.
  - **`resumeRaceWinner`** (line 972+, look at the function body): when the winner finally returns no-interrupts, propagate the winner branch into `stateStack` before any cleanup. Look for the existing `setResultOnBranch(winnerBranchKey, winnerValue)` site (around line 963 in the current code — `resumeRaceWinner` has its own analog around line 1039).

- [ ] **Step 8: Write a sequential cost test (Agency execution test)**

  `tests/agency/thread/cost-sequential.test.json` — minimal Agency program that calls `llm()` twice with the deterministic client, captures `getCost()` between calls, asserts the value doubles.

  NOTE: this test will fail until Tasks 4-6 land (the `getCost()` function doesn't exist yet). Write it now but mark it as `.skip` or leave it failing locally; un-skip it in Task 6.

- [ ] **Step 9: Manual verification of seeding**

  Add a temporary `console.log("branch seeded", existing.stack.localCost)` inside `runForkAll`. Run an existing fork test that uses LLM (e.g. one in `tests/agency/fork/llm-tools/`). Verify branches print parent's cost. Remove the log before committing.

---

## Task 4 — `RuntimeContext.pushMessage`

**Goal:** Add a thin method on `RuntimeContext` that pushes a message onto the active thread. Used by the message builtins in Task 5.

- [ ] **Step 1: Add the method**

  In `lib/runtime/state/context.ts`, on the `RuntimeContext` class:

  ```ts
  pushMessage(role: "system" | "user" | "assistant", content: string): void {
    const message =
      role === "system" ? smoltalk.systemMessage(content) :
      role === "user" ? smoltalk.userMessage(content) :
      smoltalk.assistantMessage(content);
    this.threads.active().push(message);
  }
  ```

  Ensure `smoltalk` is imported at the top of the file (check existing imports — it should already be imported).

- [ ] **Step 2: Quick smoke test**

  Add a unit test in `lib/runtime/state/context.test.ts` that constructs a context, calls `pushMessage("user", "hi")`, and asserts `ctx.threads.active().toJSON().messages.length === 1` with the right role.

---

## Task 5 — JS implementations of the five builtins

**Goal:** Create `stdlib/lib/thread.js` exporting the five `__internal_*` functions, callable from generated code.

- [ ] **Step 1: Create the file**

  All context-injected builtins now receive `(ctx, stack, ...args)` after the codegen change in Task 6. The message builtins ignore the `_stack` param; cost/token builtins use it.

  `stdlib/lib/thread.js`:

  ```js
  export async function __internal_systemMessage(ctx, _stack, msg) {
    ctx.pushMessage("system", msg);
  }

  export async function __internal_userMessage(ctx, _stack, msg) {
    ctx.pushMessage("user", msg);
  }

  export async function __internal_assistantMessage(ctx, _stack, msg) {
    ctx.pushMessage("assistant", msg);
  }

  export async function __internal_getCost(_ctx, stack) {
    return stack.localCost;
  }

  export async function __internal_getTokens(_ctx, stack) {
    return stack.localTokens;
  }
  ```

  All are `async` to match the existing memory builtin pattern (codegen emits `await` for context-injected builtins).

- [ ] **Step 2: Expose via `package.json` exports**

  Add `./stdlib-lib/thread.js` to the `exports` map in `package.json`, mirroring `./stdlib-lib/memory.js`. Verify the path resolves:

  ```bash
  node -e "import('agency-lang/stdlib-lib/thread.js').then(m => console.log(Object.keys(m)))"
  ```

  Should print the five exports.

---

## Task 6 — Codegen: register builtins, always thread `__stateStack`

**Goal:** Wire the new builtins through the typechecker and codegen so Agency code calling `__internal_getCost()` (and the others) produces the right TS. As part of this task, change the codegen contract for *all* context-injected builtins so that `__stateStack` is always passed after `__ctx`. This means the existing memory builtins gain an unused `_stack` parameter.

- [ ] **Step 1: Update memory builtin JS signatures**

  In `lib/runtime/memory/manager.ts` (or wherever the 9 `__internal_*` memory builtins are exported — verify with `grep -n "export.*__internal_" lib/runtime/memory/ stdlib/lib/`), add a `_stack` parameter as the second arg of every one:

  ```ts
  // Before:
  export async function __internal_setMemoryId(ctx, id) { ... }
  // After:
  export async function __internal_setMemoryId(ctx, _stack, id) { ... }
  ```

  Repeat for `__internal_shouldRunMemory`, `__internal_buildExtractionPrompt`, `__internal_applyExtractionResult`, `__internal_buildForgetPrompt`, `__internal_applyForgetResult`, `__internal_remember`, `__internal_recall`, `__internal_forget` (all 9 from `CONTEXT_INJECTED_BUILTINS`).

  Don't change anything else — just insert the unused param.

- [ ] **Step 2: Add `THREAD_FROM` and register entries**

  In `lib/codegenBuiltins/contextInjected.ts`, below the existing `MEMORY_FROM` constant:

  ```ts
  const THREAD_FROM = "agency-lang/stdlib-lib/thread.js";
  ```

  Add five new entries to `CONTEXT_INJECTED_BUILTINS`:

  ```ts
  __internal_systemMessage: {
    name: "__internal_systemMessage",
    from: THREAD_FROM,
    params: [string],
    returnType: voidT,
  },
  __internal_userMessage: {
    name: "__internal_userMessage",
    from: THREAD_FROM,
    params: [string],
    returnType: voidT,
  },
  __internal_assistantMessage: {
    name: "__internal_assistantMessage",
    from: THREAD_FROM,
    params: [string],
    returnType: voidT,
  },
  __internal_getCost: {
    name: "__internal_getCost",
    from: THREAD_FROM,
    params: [],
    returnType: number,
  },
  __internal_getTokens: {
    name: "__internal_getTokens",
    from: THREAD_FROM,
    params: [],
    returnType: number,
  },
  ```

  Make sure `number` is imported from `../typeChecker/primitives.js` (alias `NUMBER_T as number`).

  Update the JSDoc on `ContextInjectedBuiltin.params` to note: "The TS impl receives `__ctx`, `__stateStack`, then these, so `impl.length === 2 + params.length`."

- [ ] **Step 3: Teach the codegen to always push `__stateStack`**

  In `lib/backends/typescriptBuilder.ts`, the `isContextInjectedBuiltin` branch (currently around line 1886):

  ```ts
  if (isContextInjectedBuiltin(node.functionName)) {
    return this.emitDirectFunctionCall(node, functionName, shouldAwait, [
      ts.id("__ctx"),
      ts.id("__stateStack"),
    ]);
  }
  ```

  No registry lookup needed — every context-injected builtin gets the same two prefixed args.

- [ ] **Step 4: Verify `__stateStack` is in scope**

  Search for where `__stateStack` is bound in generated code — it should be in every function/node body's setup template:

  ```bash
  grep -rn "__stateStack" lib/templates/backends/typescriptGenerator/ | head
  ```

  Confirm function-frame setup binds it. If it isn't always bound (e.g. only inside fork branches), the spec's assumption is wrong and we need a fallback (`__stateStack ?? __ctx.stateStack`). Likely it IS always bound; document the finding.

- [ ] **Step 5: Update the arity-parity test**

  `lib/codegenBuiltins/contextInjected.test.ts` currently asserts `impl.length === 1 + entry.params.length` (ctx + user params). Update it to assert `impl.length === 2 + entry.params.length` (ctx + stack + user params). This single change covers ALL builtins, old and new.

- [ ] **Step 6: Run typechecker + memory tests**

  ```bash
  pnpm vitest run lib/typeChecker lib/runtime/memory lib/codegenBuiltins 2>&1 | tee /tmp/task6.log
  ```

  Should all pass. The typechecker auto-registers context-injected builtins via `BUILTIN_FUNCTION_TYPES`. The memory tests will exercise the new `_stack` arg path — if any of them break, the new param is misplaced.

- [ ] **Step 7: Rebuild generated code that includes memory calls**

  ```bash
  make 2>&1 | tee /tmp/task6-make.log
  ```

  Any existing compiled `.agency` outputs that call memory builtins will be regenerated with the new arg ordering. If you see stale `.agency.ts` files calling memory builtins with only one arg, hunt down the build step that produced them.

---

## Task 7 — `std::thread` stdlib module

**Goal:** Create the user-facing Agency wrapper module.

- [ ] **Step 1: Create `stdlib/thread.agency`**

  ```
  def systemMessage(msg: string): void {
    """
    Add a system message to the current thread's message history.
    @param msg - The system message content
    """
    __internal_systemMessage(msg)
  }

  def userMessage(msg: string): void {
    """
    Add a user message to the current thread's message history.
    @param msg - The user message content
    """
    __internal_userMessage(msg)
  }

  def assistantMessage(msg: string): void {
    """
    Add an assistant message to the current thread's message history.
    @param msg - The assistant message content
    """
    __internal_assistantMessage(msg)
  }

  export safe def getCost(): number {
    """
    Get the cumulative cost (USD, floating point) of all LLM calls
    contributing to the current execution branch.

    Inside a fork/race branch, this returns the parent's accumulated
    cost plus the cost incurred so far inside this branch. After all
    branches join, the parent sees the sum of its own cost plus every
    branch's cost (race losers included).

    To measure a specific section, capture getCost() before and after:
      const before = getCost()
      // ... do work ...
      const sectionCost = getCost() - before
    """
    return __internal_getCost()
  }

  export safe def getTokens(): number {
    """
    Get the cumulative token count for the current execution branch.
    Same per-branch semantics as getCost().
    """
    return __internal_getTokens()
  }
  ```

  Note: the three `*Message` functions intentionally lack `safe` — they alter LLM behavior on the next call.

- [ ] **Step 2: Register `std::thread` as a stdlib module**

  Find where existing stdlib modules are registered (look in `lib/config.ts`, or grep for `"std::memory"`):

  ```bash
  grep -rn '"std::' lib/ | head -20
  ```

  Add `std::thread` → `stdlib/thread.agency` (and the JS backing `stdlib/lib/thread.js`) following the same pattern as `std::memory`.

- [ ] **Step 3: Build and verify the import resolves**

  ```bash
  make 2>&1 | tee /tmp/task7-build.log
  ```

  Then write a one-off `foo.agency`:

  ```
  import { systemMessage, getCost } from "std::thread"
  node main() {
    systemMessage("test")
    print(getCost())
  }
  ```

  ```bash
  pnpm run agency foo.agency 2>&1 | tee /tmp/task7-run.log
  ```

  Should print `0` (no LLM calls yet) and succeed. Revert `foo.agency` to its pre-task state.

---

## Task 8 — Remove the `system()` builder macro + migrate callers

**Goal:** Delete the `system()` special case in the codegen and migrate every internal caller to `import { systemMessage } from "std::thread"`.

This task is breaking. Do it in one commit so the tree never has a partial state.

- [ ] **Step 1: Migrate every `system()` call site to `systemMessage()`**

  Files to update (verify by `grep -l "\bsystem(" lib/agents/ examples/ -r --include='*.agency'`):

  - `lib/agents/review/agent.agency`
  - `lib/agents/policy/agent.agency`
  - `lib/agents/agency-agent/agent.agency`
  - `examples/etsyFees.agency`
  - `examples/coding-agent.agency`

  For each:
  1. Add `import { systemMessage } from "std::thread"` (or merge into an existing thread import if present).
  2. Replace `system(` with `systemMessage(`.
  3. If the file uses `system` as a variable name (not function), leave that alone.

- [ ] **Step 2: Delete the `system()` builder macro**

  Remove lines 1879-1886 of `lib/backends/typescriptBuilder.ts`:

  ```ts
  // system() is a builder macro — not a real function call
  if (node.functionName === "system") {
    const argNodes = node.arguments.map((a) => this.processCallArg(a));
    return $(ts.threads.active())
      .prop("push")
      .call([ts.smoltalkSystemMessage(argNodes)])
      .done();
  }
  ```

  Also check if `smoltalkSystemMessage` is still referenced anywhere else after the removal:

  ```bash
  grep -rn "smoltalkSystemMessage" lib/ stdlib/
  ```

  If it's only used in the deleted macro, you can remove it from `lib/typescriptBuilder/ts.ts` (or wherever it lives) too.

- [ ] **Step 3: Verify `system` is not a reserved word elsewhere**

  ```bash
  grep -rn "'system'\|\"system\"" lib/parsers/ lib/lexer/ 2>&1 | head
  ```

  If the parser/lexer treats `system` as reserved, you'll see it here. Spec assumes it does not. If it does, file a follow-up task — DO NOT silently change the lexer in this task.

- [ ] **Step 4: Rebuild stdlib + agents**

  ```bash
  make 2>&1 | tee /tmp/task8-make.log
  ```

  Must succeed. The agent `.agency` files are compiled by `make`.

- [ ] **Step 5: Rebuild integration fixtures**

  ```bash
  make fixtures 2>&1 | tee /tmp/task8-fixtures.log
  ```

  This regenerates fixtures that previously baked in the `system()` codegen. Inspect the diff: every fixture change should be of the form `__threads.active().push(...)` → `await __internal_systemMessage(__ctx, ...)` (or whatever the codegen now produces).

- [ ] **Step 6: Run the full test suite**

  ```bash
  pnpm test:run 2>&1 | tee /tmp/task8-test.log
  ```

  Any failure is either a missed `system()` migration or a fixture that didn't get rebuilt. Triage and fix until green.

---

## Task 9 — New Agency execution tests

**Goal:** Lock down the per-branch cost semantics with focused tests.

For all tests below, use the deterministic LLM client (`lib/runtime/deterministicClient.ts`) so we have a fixed cost-per-call. Confirm its current value in `DETERMINISTIC_COMPLETION` (around line 36 — `totalCost: 0.000002`).

- [ ] **Step 1: `tests/agency/thread/messages.test.json`**

  Push a system, user, and assistant message via `std::thread`, then run a simple node and assert the resulting message history (via thread store inspection in the test runner) contains all three in order.

- [ ] **Step 2: `tests/agency/thread/cost-sequential.test.json` (un-skip from Task 3)**

  Two sequential `llm()` calls, capture `getCost()` between and after, assert second reading is exactly double the first.

- [ ] **Step 3: `tests/agency/thread/cost-fork-join.test.json`**

  Mirror the A=$7, B/C/D/E=$1-each scenario from the spec. The Agency program:
  - Makes 7 LLM calls on the main thread (so `localCost = 7 * DETERMINISTIC_COST`).
  - `fork`s over an array of 4 items, each branch makes one LLM call and captures `getCost()` inside.
  - After the fork, captures `getCost()` again on the main thread.

  Assert:
  - Each branch's captured `getCost()` ≈ `8 * DETERMINISTIC_COST`.
  - Post-fork main `getCost()` ≈ `11 * DETERMINISTIC_COST`.

- [ ] **Step 4: `tests/agency/thread/cost-race-includes-losers.test.json`**

  `race` over 3 items, each branch makes a different number of LLM calls (e.g., 1, 2, 3) with deterministic delays so the 1-call branch wins. After the race, assert main `getCost()` reflects ALL 6 calls (1 + 2 + 3) × `DETERMINISTIC_COST`, not just the winner's 1 call.

- [ ] **Step 5: `tests/agency/thread/cost-interrupt-resume.test.json`**

  Two `llm()` calls separated by an `interrupt(...)`. After resume, assert `getCost()` is 2 × `DETERMINISTIC_COST` and NOT 4× — i.e., the pre-interrupt call wasn't re-counted on resume.

- [ ] **Step 6: Run the new tests in isolation**

  ```bash
  pnpm vitest run tests/agency/thread 2>&1 | tee /tmp/task9.log
  ```

  All five must pass before moving on.

---

## Task 10 — Final verification

- [ ] **Step 1: Full test suite**

  ```bash
  pnpm test:run 2>&1 | tee /tmp/final-test.log
  ```

  All green.

- [ ] **Step 2: Lint and structural lint**

  ```bash
  pnpm run lint:structure 2>&1 | tee /tmp/final-lint.log
  ```

- [ ] **Step 3: End-to-end smoke test**

  Compile and run one of the migrated agents (`pnpm run agency lib/agents/agency-agent/agent.agency` or similar) to confirm the migrated `system()` → `systemMessage()` produces no runtime error. Cost reporting can be eyeballed by adding a `print(getCost())` at the end.

- [ ] **Step 4: Diff review**

  ```bash
  git diff --stat HEAD
  ```

  Should touch:
  - Runtime: `stateStack.ts`, `prompt.ts`, `runner.ts`, `state/context.ts`.
  - Codegen: `contextInjected.ts`, `typescriptBuilder.ts`.
  - Stdlib: new `stdlib/thread.agency`, new `stdlib/lib/thread.js`, `package.json` exports.
  - Config: `lib/config.ts` (stdlib registration).
  - Migration: 5 `.agency` files in `lib/agents/` and `examples/`.
  - Fixtures: regenerated by `make fixtures`.
  - Tests: new `tests/agency/thread/` dir + small additions to existing unit tests.

  Anything outside this set should be questioned.

- [ ] **Step 5: Write a short CHANGELOG entry**

  Note the breaking change (`system()` removed in favor of `std::thread`'s `systemMessage`) and the new `getCost()`/`getTokens()` capabilities.

---

## Rollback plan

If something goes wrong mid-migration:

- Tasks 1-7 are non-breaking and can be reverted independently — they only add new code.
- Task 8 is the breaking commit. If you need to roll back partially, restore the deleted `system()` macro and revert the agent/example migrations; keep the rest.
- The `localCost`/`localTokens` fields are backward-compatible with old checkpoints (default to 0 in `fromJSON`), so reverting doesn't invalidate any saved state.

## Open questions to surface during implementation

- **Memory-layer LLM calls** (`memory.text`, `memory.embed`) are excluded from per-branch cost tracking. If the implementer notices an easy way to thread them through, file a follow-up — don't expand scope here.
- **Global `__tokenStats`** still aggregates everything (including race losers) at the run level. It's parallel to the new per-branch accumulator and is intentionally unchanged.
- **Lexer status of `system`**: if Task 8 Step 3 finds it's reserved, that's a follow-up, not a blocker for shipping the rest.
