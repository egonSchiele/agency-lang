# TS-helper integration tests (as agency tests)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** close the integration-coverage gap surfaced by the post-PR-211 self-review of the TS-helpers surface (`agency.*` namespace, `withResumableScope`, `agency.interrupt`, `agency.withCostGuard`, `agency.withHandler`). Unit tests cover per-call contracts; **load-bearing behaviors** (resumability across interrupts, handler interception, cost-guard trips, fork-branch isolation) are not exercised end-to-end.

**Why agency tests, not a new vitest harness:** the question we are testing is *"does TS code calling `agency.*` participate in agent runs correctly?"* — i.e. `agency code calling JS`. That's the natural domain of `tests/agency/`: the .agency file is the entry, it imports a `.js` helper, the helper uses `agency.*`. The test runner already drives interrupt round-trips declaratively via `interruptHandlers: [{action, expectedMessage, value}]` in `.test.json`. No new test infrastructure needed.

`tests/agency-js/` is *JS calling agency* — needed only when an external JS driver has to feed user responses back. That's not what we're testing here.

This plan supersedes both `2026-05-27-runtime-integration-harness.md` and `2026-05-27-missing-integration-tests.md`. Delete those after this PR merges.

**Prerequisites (must be merged):**
1. `2026-05-27-callsite-als-and-drop-state-arg.md` (#207)
2. `2026-05-27-agency-namespace.md` (#208)
3. `2026-05-27-resumable-scope.md` (#209)
4. `2026-05-27-agency-llm.md` (#210)
5. `2026-05-27-ts-helpers-docs.md` (#211)
6. `agency.interrupt()` (#212) — merged

**Architecture:** every test in this plan lives in `tests/agency/ts-helpers/<name>/` as a triplet of three sibling files inside its own subdirectory:
- `agent.agency` — entry that imports `./helper.js`, calls it from `node main()`, returns whatever the assertion needs.
- `helper.js` — the actual TS-helper-using code (written as JS — no compilation step). `.js` files are gitignored repo-wide, so each helper must be `git add -f`'d.
- `agent.test.json` — `expectedOutput`, `evaluationCriteria`, and (if the helper raises interrupts) an `interruptHandlers` array declaring the round-trip.

No new runtime code. No new test infrastructure. If a test reveals a bug, file a precursor PR to fix it before landing this PR — don't paper over with test-only workarounds.

**Tech stack:** existing `tests/agency/` runner (`pnpm run agency test <dir>`); JS helpers import from `agency-lang/runtime`; declarative interrupt rounds via `.test.json`'s `interruptHandlers`.

**Workflow conventions:** worktree per PR, validate with `pnpm tsc --noEmit && pnpm run lint:structure && pnpm run agency test tests/agency/ts-helpers/`, commit messages via file, never force-push or amend.

**Anti-pattern review** (`docs/dev/anti-patterns.md`): re-read before opening the PR. The triplet structure is intentionally declarative — assertions live in `.test.json`, not in imperative JS code. If a future revision adds JS-side `expect` calls, that's a regression toward the imperative anti-pattern.

---

## Test inventory (9 tests)

Each test pins one load-bearing behavior. Listed in landing order — earlier tests are simpler and de-risk later ones.

### Test 1: `resumable-scope-resume`

**Pins:** on resume after an interrupt, completed `s.step(...)` bodies are skipped and cached return values are used; the in-flight step re-runs from scratch and finds the user's response on the second pass.

**Why it matters:** the entire point of `withResumableScope` is that interrupted runs replay correctly. Today the unit test "re-running a scope with the same frame skips completed steps" admits in its comment that it does not exercise the real resume path.

**Shape:**
```
resumable-scope-resume/agent.agency:
  import { runScope, getCalls } from "./helper.js"
  node main() {
    const result = runScope()
    return { result: result, calls: getCalls() }
  }

resumable-scope-resume/helper.js:
  - exports runScope() that uses agency.withResumableScope with 3 steps
  - middle step calls agency.interrupt
  - tracks call counts per step

resumable-scope-resume/agent.test.json:
  - interruptHandlers: [{action:"approve", value:"resumed", expectedMessage:"wait"}]
  - expectedOutput verifies calls = {s1:1, s2:2, s3:1} and result reflects "resumed"
```

### Test 2: `interrupt-handler-approve`

**Pins:** `agency.withHandler` returning `approve(value)` makes `agency.interrupt(...)` resolve to that approve outcome; the run continues to completion in the same pass (no halt, no resume).

**Shape:**
```
interrupt-handler-approve/agent.agency:
  import { run } from "./helper.js"
  node main() { return run() }

interrupt-handler-approve/helper.js:
  - wraps agency.interrupt({kind, message, data}) in agency.withHandler(approver)
  - approver returns approve("handled")
  - returns the response

interrupt-handler-approve/agent.test.json:
  - no interruptHandlers (run never propagates)
  - expectedOutput: {"type":"approve","value":"handled"}
```

### Test 3: `interrupt-handler-reject`

**Pins:** `agency.withHandler` returning `reject(value)` makes `agency.interrupt(...)` resolve to that reject outcome.

Mirrors Test 2 but with reject. Two separate tests not one combined: makes failures point at the broken path directly.

### Test 4: `interrupt-resume-idempotency`

**Pins:** when no handler intercepts, `agency.interrupt(...)` halts with a checkpoint, the runner accepts a user response via `respondToInterrupts`, and the second pass through the same call site returns the response without re-firing the handler chain or creating another checkpoint.

This is the integration version of unit test 4 in PR #212's `agencyInterrupt.test.ts`. The unit test simulates the post-restore state by manually setting `frame.locals[__interrupt_0]`; this test exercises the real `respondToInterrupts` cycle via `.test.json`'s `interruptHandlers`.

**Shape:**
```
interrupt-resume-idempotency/agent.agency:
  import { run, getHandlerCalls } from "./helper.js"
  node main() {
    const result = run()
    return { result: result, handlerCalls: getHandlerCalls() }
  }

interrupt-resume-idempotency/helper.js:
  - run() pushes a handler that just COUNTS calls (returns undefined / propagate)
  - inside, calls agency.interrupt; returns response.value
  - getHandlerCalls() returns counter

interrupt-resume-idempotency/agent.test.json:
  - interruptHandlers: [{action:"approve", value:"user-said-yes", expectedMessage:"?"}]
  - expectedOutput: handlerCalls === 1 (NOT 2 — handler must not re-fire on resume)
                    result === "user-said-yes"
```

If `handlerCalls === 2`, the resume-idempotency is broken.

### Test 5: `halt-trycatch-cleanup`

**Pins:** `s.halt(value)` does not throw — surrounding `try/finally` runs, subsequent `s.step(...)` short-circuits but the body keeps running until natural exit.

**Shape:**
```
halt-trycatch-cleanup/agent.agency:
  import { run, getCleanup } from "./helper.js"
  node main() {
    const result = run()
    return { result: result, cleanup: getCleanup() }
  }

halt-trycatch-cleanup/helper.js:
  - run() uses withResumableScope; body has try/finally
  - inside try: s.step("a"); s.halt("halted"); s.step("b")
  - finally: pushes "ran" to cleanup array

halt-trycatch-cleanup/agent.test.json:
  - expectedOutput: result === "halted", cleanup === ["ran"]
```

### Test 6: `cost-guard-trips`

**Pins:** `agency.withCostGuard(maxCost, fn)` trips when `agency.addCost(...)` pushes accumulated cost past the budget; the trip surfaces as a catchable error so the helper can return a structured failure.

**Shape:**
```
cost-guard-trips/agent.agency:
  import { run } from "./helper.js"
  node main() { return run() }

cost-guard-trips/helper.js:
  - run() wraps work in agency.withCostGuard(0.01, async () => {...})
  - inside: agency.addCost(0.05) — over budget
  - catches the GuardExceededError (via isGuardExceededError), returns
    {tripped, type, limit, spent}

cost-guard-trips/agent.test.json:
  - expectedOutput: {"tripped":true,"type":"cost","limit":0.01,"spent":0.05}
  - evaluationCriteria: exact
```

If `addCost` doesn't trigger trip enforcement at the time of writing, this test discovers it and the right move is to file a precursor PR fixing the bug.

### Test 7: `fork-branch-isolation`

**Pins:** when an agency `fork` runs branches that each call a TS function adding cost, each branch's spend is attributed to its own branch stack and doesn't leak across siblings.

**Shape:**
```
fork-branch-isolation/agent.agency:
  import { addAndReport } from "./helper.js"
  node main() {
    let results = fork([1, 2, 3]) as i {
      return addAndReport(i)
    }
    return results
  }

fork-branch-isolation/helper.js:
  - addAndReport(amount) calls agency.addCost(amount), returns the per-branch
    stack.localCost (read via getRuntimeContext().stack.localCost)
  - assertion: each branch sees only its own contribution (plus the seed
    from parent, if any) — not the sum of siblings'

fork-branch-isolation/agent.test.json:
  - expectedOutput: per-branch costs are [1, 2, 3] (each branch's own
    contribution as integers — avoids the floating-point fuzz of fractional
    multipliers like i * 0.01), NOT [6, 6, 6]
```

If branches DO leak, this test surfaces it; file a precursor PR for the runtime fix.

### Test 8: `agency-handle-approves-ts-interrupt`

**Pins:** an agency `handle ... with (i) { return approve(value) }` block intercepts an `agency.interrupt(...)` raised from a TS helper called inside the block. Documented contract in `agencyInterrupt.ts`:

> a TS function called from Agency code can have its `agency.interrupt(...)` caught by a `handle` block defined in the calling Agency code

This is the cross-surface direction of Tests 2/3: those install a TS-side `agency.withHandler` and raise from TS; this one installs an agency-side `handle` block and raises from TS.

**Shape:**
```
agency-handle-approves-ts-interrupt/agent.agency:
  import { raise } from "./helper.js"
  node main() {
    handle {
      return raise()
    } with (i) {
      return approve("from-agency")
    }
  }

agency-handle-approves-ts-interrupt/helper.js:
  - raise() calls agency.interrupt({kind:"test::ask", message, data})
  - returns the InterruptResponse object

agency-handle-approves-ts-interrupt/agent.test.json:
  - no interruptHandlers (the agency handle intercepts before the user)
  - expectedOutput: {"type":"approve","value":"from-agency"}
```

### Test 9: `agency-handle-rejects-ts-interrupt`

**Pins:** mirror of Test 8, but the agency `handle` block returns `reject(value)`. Two separate tests not one combined: same rationale as Tests 2/3 — a regression points at exactly which path broke.

**Shape:** identical to Test 8 with `reject("blocked-by-agency")` in the `with` block and `expectedOutput: {"type":"reject","value":"blocked-by-agency"}` in the `.test.json`.

---

## Steps

- [x] **Step 1: Create worktree** (already done — `ts-helper-integration-tests`)

- [ ] **Step 2: Land tests one at a time**

Order: 2 → 3 → 5 → 1 → 4 → 6 → 7 → 8 → 9. Rationale:
- 2 and 3 (handler approve/reject) are the simplest, no interrupt propagation. De-risk the .agency-imports-js setup first.
- 5 (halt cleanup) is similar simplicity.
- 1 (resumable-scope-resume) adds interrupt round-trips — uses `.test.json` interruptHandlers for the first time.
- 4 (resume idempotency) reuses the round-trip mechanism.
- 6 (cost-guard) introduces `addCost` enforcement.
- 7 (fork-branch isolation) is most likely to surface infrastructure issues.
- 8 and 9 (agency-handle approves/rejects TS interrupt) added after first review feedback; pin the cross-surface direction of Tests 2/3.

For each test:
1. Create the per-test directory: `tests/agency/ts-helpers/<name>/`.
2. Write `helper.js` (the JS helper using `agency.*`).
3. Write `agent.agency` (entry that imports `./helper.js` and calls it from `node main()`).
4. Write `agent.test.json` with assertions.
5. Run: `pnpm run agency test tests/agency/ts-helpers/<name>/agent.agency 2>&1 | tee /tmp/<name>.log | tail -30`.
6. Iterate until green. If the test reveals a runtime bug, stop and file a precursor PR.
7. `git add -f tests/agency/ts-helpers/<name>/helper.js` (the .js files are gitignored repo-wide).

- [ ] **Step 3: Validate full suite**

```bash
pnpm tsc --noEmit
pnpm run lint:structure
pnpm run agency test tests/agency/ts-helpers/ 2>&1 | tee /tmp/all.log | tail -30
```

- [ ] **Step 4: Commit + push + PR**

PR title: `tests: integration coverage for agency.* TS helpers`

PR body covers:
- The 9 load-bearing behaviors pinned.
- Why agency tests (not agency-js, not a new vitest harness): agency-code-calling-JS is the natural fit; existing `interruptHandlers` mechanism already provides declarative round-trip.
- Any bugs surfaced and the precursor PRs that fixed them.
- Note that this brings the testing story for the 5-PR series to genuine integration coverage; the per-call unit tests are kept.
- Lists the two superseded plan files for future cleanup.

---

## Verification checklist

- [ ] `pnpm tsc --noEmit` clean
- [ ] `pnpm run lint:structure` clean
- [ ] All 9 tests pass under `pnpm run agency test tests/agency/ts-helpers/`
- [ ] Each test is a self-contained triplet (`<name>/agent.agency` + `<name>/helper.js` + `<name>/agent.test.json`); no shared mutable state across tests
- [ ] No JS-side `expect` / `assert` calls — assertions live in `.test.json` (declarative)
- [ ] No production code changes (any bugs found were fixed in precursor PRs and merged first)
- [ ] PR body cross-links every test to the load-bearing claim it pins

## Open questions / risks

- **`agency.addCost` enforcement timing.** Need to verify it trips synchronously rather than on the next LLM call. If it requires an LLM call to enforce, Test 6 needs an LLM mock; rework accordingly.
- **Per-branch cost reading from JS.** `getRuntimeContext().stack.localCost` is the path. If the ALS frame inside a fork branch carries the parent stack (not the branch stack), Test 7's helper reads the wrong value. Audit `runBatch.ts` before writing the test.
- **Test 4 handler counter visibility.** The handler is closure-over the same module-level counter the entry reads at the end. Module state survives across the resume cycle because both passes import the same compiled `.js` instance.
- **`.test.json` interruptHandlers limitation.** Today it dispatches by FIFO order, not by interrupt kind/data. All 9 tests above produce at most one interrupt, so this is fine. If a future test produces multiple distinct interrupts in a single run, we may need to extend the test runner's matching logic (out of scope for this PR).
