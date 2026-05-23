# End-Hook Callback Substep Completion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `onLLMCallEnd` (and, in scope-extension, every other "end"-shaped hook) mark its enclosing substep complete BEFORE firing the user callback, so that an interrupt raised inside the callback does not cause the substep — and the work it performed — to re-run on resume.

**Surfaced by:** the `guard()` stdlib function (added in the same PR as this plan). With a `$0.0000001` limit, the first `llm()` call costs ~6e-6 and trips the callback's interrupt; on each resume the `llm()` re-fires, adding another ~6e-6 of cost per cycle. Observed sequence: spent grows 6e-6 → 12e-6 → 18e-6 → 24e-6 → 30e-6 across 5 cycles, linear, exactly one extra LLM call per cycle.

**Root cause:** `Runner.step(id, body)` increments the substep counter (`setCounter(id + 1)`) *after* `body` returns successfully. `onLLMCallEnd` is fired from inside `prompt.ts` while it is still executing inside the surrounding `runner.step` body. If the callback raises an interrupt, the runner halts, the step body returns early, and `setCounter` never runs. On resume, the counter still points at the LLM step, so the step re-executes — re-invoking `llm()` and re-spending real money.

This is the same shape as the bug class addressed by `docs/superpowers/plans/2026-05-22-callback-interrupts-deferred-return.md` for `onNodeEnd` (value-returning case) and `onFunctionEnd` (finally-block case). The "end" hook fires before the surrounding step's completion is committed.

**Tech Stack:** TypeScript runtime (`lib/runtime/runner.ts`, `lib/runtime/prompt.ts`, `lib/runtime/promptRunner.ts`), `lib/runtime/hooks.ts`, fixtures.

---

### Task 1: Failing fixture

**Files:**
- Create: `tests/agency/guard-cost.test.json` (promote the existing `tests/agency/guard-cost.agency` example to a real fixture with handlers)
- Create: `tests/agency/onllmcallend-interrupt-no-rerun.agency` + `.test.json` (minimal reproducer that does NOT use `guard` — just a top-level `callback("onLLMCallEnd") as data { interrupt(...) }` plus a node that calls `llm(...)` once and counts via a module-level `let counter` how many times the body ran)

- [ ] **Step 1: Minimal reproducer**

```
let runs: number = 0

callback("onLLMCallEnd") as data {
  interrupt myapp::checkpoint("paused", {})
}

node main() {
  runs = runs + 1
  llm("Say hi")
  return runs
}
```

Expected after one approve cycle: `runs == 1`. Today: `runs == 2`.

- [ ] **Step 2: Promote guard-cost to a real fixture** — supply enough interrupt handlers (or use `{action: "approve"}` with `resolvedValue` matching the original limit) to drive the run to completion, asserting `expectedOutput == "done"`.

- [ ] **Step 3: Confirm both fail**

```bash
pnpm run agency test tests/agency/onllmcallend-interrupt-no-rerun.agency > /tmp/end-hook-rerun.log 2>&1
pnpm run agency test tests/agency/guard-cost.agency >> /tmp/end-hook-rerun.log 2>&1
```

- [ ] **Step 4: Commit**

---

### Task 2: Audit every end-hook fire site

**Files:**
- Read: `lib/runtime/prompt.ts` — find every `invokeCallbacks(..., name: "onLLMCallEnd" ...)` and `b.step(...)` that fires an end-shaped hook.
- Read: `lib/runtime/promptRunner.ts` — same.
- Read: `lib/runtime/node.ts` — `onAgentEnd`.
- Read: `lib/backends/typescriptBuilder.ts` — codegen for `onNodeEnd` (already migrated to `runner.hook`) and `onFunctionEnd` (still in `finally`).

- [ ] **Step 1: Build the table**

For each end-hook fire site, write down in `docs/notes/end-hook-fire-sites.md` (delete in Task 5):
- Hook name
- Caller (file/function)
- Whether the fire is inside a `runner.step` body or outside any runner
- Whether the substep counter is incremented BEFORE the fire or AFTER it (or there is no counter)
- Whether the fire CAN currently propagate an interrupt up the runner

The table drives Task 3's strategy: sites that already commit-before-fire are unaffected; sites that commit-after-fire need the deferred completion treatment.

---

### Task 3: Add a `Runner.commitStep` primitive

**Files:**
- Modify: `lib/runtime/runner.ts`

The simplest fix: a `commitStep(id)` method that callers (specifically `runner.step` itself, before firing a *trailing* hook) call to advance the counter BEFORE the hook fires.

- [ ] **Step 1: Add the helper**

```ts
/** Mark a step complete so that an interrupt raised in trailing hook
 *  bookkeeping (e.g. onLLMCallEnd raising from inside prompt.ts) does
 *  NOT cause the step's body to re-run on resume. Idempotent. */
commitStep(id: number): void {
  if (this.getCounter() <= id) {
    this.setCounter(id + 1);
  }
}
```

- [ ] **Step 2: Unit test**

`lib/runtime/runner-commitStep.test.ts` — verify: stamps counter, idempotent on second call, no effect when called for an older step.

---

### Task 4: Wire `commitStep` into the LLM call path

**Files:**
- Modify: `lib/runtime/prompt.ts` (the place where `onLLMCallEnd` is fired after the LLM call)
- Modify: `lib/runtime/promptRunner.ts` if applicable

The cleanest plumbing: in `runPrompt` / `PromptRunner`, after the LLM call completes (and its result is recorded into the parent frame's locals so resume can read it back), call `runner.commitStep(currentId)` BEFORE firing `onLLMCallEnd`. The result must already be safely captured on the frame — otherwise resume reads the wrong value.

- [ ] **Step 1: Identify what "the LLM call's result" looks like on the frame**

Is it stored on `__stack.locals.__llm_result_${id}`? On a deferred-return slot? Trace through `prompt.ts` for one canonical case.

- [ ] **Step 2: Insert `runner.commitStep(id)` between "result captured" and "fire onLLMCallEnd"**

The substep that owns the LLM call site (whichever id it was in the caller's body) is committed. On resume, the runner skips re-executing that step and reads the captured result from the frame.

- [ ] **Step 3: Run the failing fixture from Task 1**

```bash
pnpm run agency test tests/agency/onllmcallend-interrupt-no-rerun.agency
```

Must pass: `runs == 1`.

- [ ] **Step 4: Run the broader callback-interrupt fixture family**

```bash
pnpm test:run -- callback fork/llm-tools/multi-tool-callback-interrupts > /tmp/cb.log 2>&1
```

Must not regress.

- [ ] **Step 5: Run the full suite** — this touches the LLM call path and may shake out interactions with cost tracking, span bookkeeping, and runPrompt's tool loop.

- [ ] **Step 6: Commit**

---

### Task 5: Extend (if scope allows) to other end hooks

`onAgentEnd` fires outside any runner (intentional). No fix needed.

`onNodeEnd` (value-returning) and `onFunctionEnd` (finally-block) are covered by `docs/superpowers/plans/2026-05-22-callback-interrupts-deferred-return.md`. Cross-link from that plan back to this one — the deferred-return mechanism is a more invasive version of the same fix.

- [ ] **Step 1: Update the deferred-return plan** to note the `commitStep` primitive can be reused for its node-end refactor (Task 4 of that plan).

- [ ] **Step 2: Delete `docs/notes/end-hook-fire-sites.md`**

- [ ] **Step 3: Commit**

---

### Validation checklist

- [ ] `tests/agency/onllmcallend-interrupt-no-rerun` passes; counter shows exactly-once body execution.
- [ ] `tests/agency/guard-cost` passes when supplied with one interrupt handler (no longer needs 4+).
- [ ] No regressions in the multi-tool callback interrupt fixtures.
- [ ] No regressions in the broader callback suite.
- [ ] `make` succeeds, `pnpm run lint:structure` clean.

---

### Risks and dependencies

- **Result-on-frame contract:** Task 4 step 1 must verify the LLM result is captured on a serializable frame slot BEFORE we commit the step. If we commit early but the result is held only in a live JS closure, resume reads `undefined`. Inspect carefully.
- **Span / cost bookkeeping in trailing hooks:** the existing `onLLMCallEnd` data includes `usage`, `cost`, `timeTaken`. None of these need the substep to be uncommitted — they're computed values that the hook receives by value. Safe to commit first.
- **Backwards compatibility with serialized checkpoints:** if an in-flight checkpoint was stamped under the pre-fix counter (still pointing at the LLM step), resuming it on the post-fix runtime will skip the step — which is what we want, BUT the LLM result on the frame must be valid. Same concern as the result-on-frame contract; verifying it covers both cases.
