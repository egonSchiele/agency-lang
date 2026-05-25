# Callback Interrupts Across Parallel Tool Branches Implementation Plan

> **Status: superseded by [2026-05-22-runbatch-concurrent-interrupt-primitive.md](2026-05-22-runbatch-concurrent-interrupt-primitive.md).**
> The runBatch refactor solves this plan's use case as Task 5 (Thread `branchStack` through `callHook`). Do not implement this plan directly.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `onToolCallStart` / `onToolCallEnd` callback interrupts work correctly when fired from multiple parallel tool branches in the same LLM round — every interrupting branch surfaces in one batch and resume must feed each user response back to the originating branch's callback frame without re-running tool bodies.

**Architecture (current state, verified):** The per-branch hook fire inside `pr.parallel(...)` is already wrapped in `b.step` and `pr.parallel` already merges `b.interrupts` across siblings (`lib/runtime/promptRunner.ts:140-189`, `lib/runtime/prompt.ts:657-743`). **The original spec [`docs/superpowers/specs/2026-05-22-parallel-callback-interrupts.md`](../specs/2026-05-22-parallel-callback-interrupts.md) is out of date** — it says the per-branch fire is a bare `await callHook(...)`. It is not. Task 1 reconciles the spec.

**What is unknown:** the actual failure mode. The spec's proposed solution may already be partially in place; the bug surface is now narrower than the spec describes. The right move is investigate first, then write tests against the specific failure mode found, then fix. Likely-but-unverified suspects (do NOT act on these without investigation in Task 2):
- per-branch checkpoint slicing — `promptRunner.ts:175-178` overwrites `intr.checkpoint` with the parallel one; the per-callback inner checkpoint must be preserved somewhere for resume to reconstruct each callback's `__self`. The existing concurrent-interrupt machinery solves this via `setInterruptOnBranch` writing the inner checkpoint onto the branch's `BranchState` (see `docs/dev/concurrent-interrupts.md:73-91`). The fix, if this is the bug, is to call `setInterruptOnBranch` on the tool branch (`tool_<id>`) for the callback's interrupt — same as tool-body interrupts already do — NOT to invent a new `Interrupt` field.
- per-branch `__self` frame reconstruction on resume. **Risk:** if the fix requires putting each callback fire on its own branch via `getOrCreateBranch`, that's the same sequential→parallel transition [Plan 2](2026-05-22-callback-interrupts-fork-style-resume.md) does for same-hook multi-callback. If Task 2 concludes this is the cause for single-callback-per-branch too, the scope split between this plan and Plan 2 collapses. Flag immediately to the user — both plans then merge.
- interrupt-response routing if the same lifted callback fires in multiple branches with different `data` payloads.

**Tech Stack:** TypeScript runtime (`lib/runtime/promptRunner.ts`, `lib/runtime/prompt.ts`, `lib/runtime/hooks.ts`, `lib/runtime/state/stateStack.ts`), Agency-js tests (`tests/agency-js/` — these are the only test format that supports response-routing by interrupt data), Vitest.

**Note on test format:** The `tests/agency/*.test.json` harness uses an ordered `interruptHandlers` array. Parallel-branch resume cannot rely on ordering (`Promise.all` scheduling is non-deterministic). Agency-js tests (`tests/agency-js/.../{agent.agency, test.js}`) DO support inspecting each interrupt's `data` and selecting responses by content — see `tests/agency-js/interrupts/interrupt-respond-by-data/test.js` for the established pattern. All fixtures in this plan are agency-js tests.

---

### Task 1: Reconcile the spec contradiction

**Files:**
- Modify: `docs/superpowers/specs/2026-05-22-parallel-callback-interrupts.md`

- [ ] **Step 1: Read the current implementation**

Read `lib/runtime/prompt.ts:640-770` and `lib/runtime/promptRunner.ts:130-227`. Confirm that:
- per-tool `b.step` already wraps `callHook("onToolCallStart")` at lines 657-665,
- per-tool `b.step` already wraps `callHook("onToolCallEnd")` at lines 731-743,
- `pr.parallel` already collects `b.interrupts` from every branch and merges into a single batch with one shared parallel checkpoint at `promptRunner.ts:158-188`.

- [ ] **Step 2: Add a status header at the top of the spec**

```markdown
# Spec: Callback Interrupts Across Parallel Tool Calls

> **Status: 2026-05-22 — revised after partial implementation.** The `b.step`
> wrapping and `pr.parallel` cross-branch merging described under "Rough
> Solution" steps 1–2 are now present in `lib/runtime/prompt.ts:657-743`
> and `lib/runtime/promptRunner.ts:158-188`. This plan re-investigates
> what gap actually remains; see
> `docs/superpowers/plans/2026-05-22-callback-interrupts-parallel-tool-branches.md`.
```

Do NOT delete the original problem statement — leave it for historical context. The same header line evolves in Task 6 Step 3 to `**Status: implemented in <commit-sha>**`; do not stack a second header.

- [ ] **Step 3: Commit**

```bash
printf 'docs: reconcile parallel-callback-interrupts spec with implementation state\n' > /tmp/cm.txt
git add docs/superpowers/specs/2026-05-22-parallel-callback-interrupts.md
git commit -F /tmp/cm.txt
```

---

### Task 2: Investigate before writing tests

**Files:**
- Read only: `lib/runtime/promptRunner.ts:140-227`, `lib/runtime/prompt.ts:640-770`, `lib/runtime/state/stateStack.ts` (whole file), `lib/runtime/interrupts.ts` (whole file)
- Read only: `tests/agency/fork/llm-tools/multi-tool-all-interrupt.js` (look at the generated callback frame restore pattern)
- Read only: `tests/agency-js/interrupts/interrupt-respond-by-data/test.js` (response-routing-by-data precedent)
- Read only: `docs/dev/concurrent-interrupts.md:73-91` (slice-only checkpoint composition — the existing pattern to reuse)
- Create (delete in Task 6): `docs/notes/parallel-callback-investigation.md`
- Create (delete in Step 6): `.agency-tmp/parallel-cb-repro/agent.agency`, `.agency-tmp/parallel-cb-repro/test.js`

This task produces a written investigation and a hand-crafted minimal repro, not code. The remaining tasks depend on its conclusions.

- [ ] **Step 1: Map checkpoint stamping order**

Trace what writes `intr.checkpoint` for an `onToolCallEnd` callback interrupt in a parallel-tool round:
1. The callback's lifted `interruptReturn` stamps an inner checkpoint capturing the callback's `__self` frame.
2. `callHook` returns the interrupts to the `b.step` body in `prompt.ts:731-743`.
3. `b.step` writes the interrupts onto `branch.interrupts` (`promptRunner.ts:217-226`).
4. `pr.parallel` merges across branches and `promptRunner.ts:175-178` overwrites `intr.checkpoint` with the parallel checkpoint.

Compare with the slice-only composition pattern in `concurrent-interrupts.md:73-91`: tool-body interrupts call `setInterruptOnBranch(branchKey, interruptId, data, innerCp)` so the inner per-branch checkpoint lives on `BranchState.checkpoint`, and the outer parent checkpoint's stack walk picks it up automatically. Confirm whether the callback path *does* call `setInterruptOnBranch`. If not, that is likely the bug.

Write findings to `docs/notes/parallel-callback-investigation.md`.

- [ ] **Step 2: Map `__self` frame reconstruction on resume**

When the user calls `respondToInterrupts(interrupts, responses)` after a 2-branch interrupt, walk through:
- which checkpoint drives the restore (`interrupts[0].checkpoint`),
- how the deserialize queue is built from that checkpoint,
- whether the queue contains one `__self` frame per branch's callback (it must, for resume to find each callback's saved `__interruptId_N`),
- how `pr.parallel` knows which branches to re-enter on resume vs which to skip (`self.runnerState.completedSteps`).

Write a concrete sequence diagram (text is fine) to the notes file.

- [ ] **Step 3: Verify interrupt id uniqueness**

Inspect the generated code in `tests/agency/fork/llm-tools/multi-tool-all-interrupt.js`. Each `__self.__interruptId_N` is written from `__handlerResult[0].interruptId`, and those come from nanoid in `lib/runtime/interrupts.ts`. Confirm they're unique per fire, so ID collision is NOT the bug. Record the conclusion.

- [ ] **Step 4: Write one minimal failing program by hand**

Create `.agency-tmp/parallel-cb-repro/agent.agency` and `.agency-tmp/parallel-cb-repro/test.js`. Two parallel tools forced via a deterministic client; one top-level `onToolCallEnd` that interrupts. The `test.js` driver mirrors `tests/agency-js/interrupts/interrupt-respond-by-data/test.js` — inspects each interrupt's data, builds a positional `responses` array selected by content, calls `respondToInterrupts(interrupts, responses)`. Run it:

```bash
pnpm run agency js .agency-tmp/parallel-cb-repro/test.js > /tmp/repro.log 2>&1
```

Observe what fails (or doesn't). If everything works, escalate to 3 tools, then to the mixed-Start-End case.

- [ ] **Step 5: Form a single primary hypothesis**

Pin down the precise failure mode in the notes file: "When X happens, Y observed, expected Z, because of mechanism W in file F." This drives Tasks 3-5. If investigation reveals the bug is fully fixed already, the rest of this plan compresses to "lock in fixtures and document."

- [ ] **Step 6: Surface to the user with the investigation result**

Before continuing, share the investigation notes with the user. The remaining task structure depends on the primary hypothesis. **If the hypothesis is the `__self` frame collision per the architecture-section risk note, also surface that Plan 2 scope may need to merge into this plan.**

- [ ] **Step 7: Delete the throwaway repro**

```bash
rm -rf .agency-tmp/parallel-cb-repro/
```

(Per AGENTS.md: "If you create any temporary files, scripts, or helper files for iteration, clean them up at the end of the task.")

---

### Task 3a: Lock in the three core fixtures

**Files (all under `tests/agency-js/callback-interrupts/`, each in its own subdir with `agent.agency`, `agent.js` (generated by `make fixtures`), `test.js`, and the deterministic-client setup the existing fork/llm-tools tests use):**
- Create: `tests/agency-js/callback-interrupts/parallel-both-interrupt/`
- Create: `tests/agency-js/callback-interrupts/parallel-one-interrupts/`
- Create: `tests/agency-js/callback-interrupts/parallel-start-hook/`

**Skipped-fixture convention:** the `pnpm run agency test` runner discovers `.test.json` files explicitly. The agency-js runner discovers `test.js` files. **No `_failing/` directory convention exists in this repo (verified).** To stage a known-failing fixture, name the driver `test.js.todo` (will not be discovered) until the fix lands; rename to `test.js` once green.

**Response-routing convention:** every fixture's `test.js` inspects `intr.data.toolName` (or `intr.kind`) and builds a positional `responses` array by content match — exactly the pattern in `tests/agency-js/interrupts/interrupt-respond-by-data/test.js`. Ordering of the `interrupts` array from `Promise.all` is non-deterministic; the test must not depend on it.

**Side-effect-counter convention for "ran exactly once" assertions:** each tool body increments a module-level counter (`let toolACalls: number = 0`); after resume completes the test writes the counter values to `__result.json` and asserts on them. This is more robust than asserting on statelog event counts (whose harness exposure is unverified).

- [ ] **Step 1: Two-branch both-interrupt (onToolCallEnd) — `parallel-both-interrupt`**

Top-level `callback("onToolCallEnd")` that interrupts. Two parallel tools forced by the deterministic client (mirror `tests/agency/fork/llm-tools/multi-tool-all-interrupt.agency` for the LLM setup). Assertions:
- one batch of two interrupts surfaces on the first cycle,
- responses routed by `data.toolName`,
- after resume, each tool body has run exactly once (counter == 1 each),
- the agent's final output reflects both tool results,
- only one cycle of `respondToInterrupts` is needed.

(The handler-firing assertions move to Step 7 in Task 3b.)

- [ ] **Step 2: One-interrupts-one-doesn't — `parallel-one-interrupts`**

Callback raises `interrupt(...)` only when `data.toolName == "needsReview"`. Assertions:
- exactly one interrupt surfaces,
- the non-interrupting branch's tool body counter == 1 across the whole resume cycle (not re-run on resume),
- the non-interrupting branch produces its result without further prompting.

- [ ] **Step 3: onToolCallStart variant — `parallel-start-hook`**

Same as Step 1 but callback is on `onToolCallStart`. Assertions:
- both interrupts surface,
- on first cycle, NEITHER tool body has run (counter == 0 each),
- on resume after responses, both tool bodies run exactly once (counter == 1 each),
- only one cycle of `respondToInterrupts` is needed.

- [ ] **Step 4: Generate fixtures and capture failures**

```bash
make fixtures > /tmp/mkfix.log 2>&1
for d in tests/agency-js/callback-interrupts/parallel-{both-interrupt,one-interrupts,start-hook}; do
  name=$(basename "$d")
  # Rename test.js → test.js.todo first if needed for the runner to skip.
  pnpm run agency js "$d/test.js" > "/tmp/$name.log" 2>&1 || true
done
ls /tmp/parallel-*.log
```

Inspect each log. Cross-reference with Task 2's primary hypothesis. Mark each fixture's status in `docs/notes/parallel-callback-investigation.md`.

- [ ] **Step 5: Stage failing fixtures with `.todo` marker**

For each fixture that fails, rename `test.js` → `test.js.todo` so the runner skips it until the fix lands.

- [ ] **Step 6: Commit**

```bash
printf 'test: add core regression fixtures for parallel-branch onToolCall{Start,End} interrupts\n' > /tmp/cm.txt
git add tests/agency-js/callback-interrupts/parallel-{both-interrupt,one-interrupts,start-hook}/
git commit -F /tmp/cm.txt
```

---

### Task 3b: Additional fixtures (do this only if Task 4 fix is non-trivial)

Skip this task and go straight to Task 4 if all three Task 3a fixtures fail the same way (one fix likely covers them). Come back after Task 4's fix lands to confirm the broader surface, OR do these now if Task 2's investigation revealed multiple distinct failure modes.

**Files (same subdir-per-fixture convention as Task 3a):**
- Create: `tests/agency-js/callback-interrupts/parallel-mixed-start-end/`
- Create: `tests/agency-js/callback-interrupts/parallel-three-branches/`
- Create: `tests/agency-js/callback-interrupts/parallel-reject-one/`
- Create: `tests/agency-js/callback-interrupts/parallel-handler-caught/`
- Create: `tests/agency-js/callback-interrupts/parallel-asymmetric-failure/`
- Create: `tests/agency-js/callback-interrupts/parallel-tool-body-plus-callback/`
- Create: `tests/agency-js/callback-interrupts/parallel-multi-cycle/`

- [ ] **Step 1: Mixed Start + End across branches — `parallel-mixed-start-end`**

Branch A's `onToolCallStart` interrupts; Branch B's `onToolCallEnd` interrupts. Different `b.step` keys (`.start` vs `.end`). Assertions: both surface in one batch; on resume A's tool body runs (counter went 0→1), B's tool body does NOT re-run (counter stays 1).

- [ ] **Step 2: Three branches — `parallel-three-branches`**

Three parallel tools, all three `onToolCallEnd` callbacks interrupt. Catches off-by-one or pair-only bugs.

- [ ] **Step 3: Reject one branch — `parallel-reject-one`**

Two interrupting callbacks. User approves one and rejects the other. Driver builds responses with `reject("nope")` for one and `approve()` for the other, routed by `data.toolName`. Assertions: approving branch completes normally; rejecting branch's tool result reflects the failure outcome (`success === false`); program does not crash.

- [ ] **Step 4: Handler catches one branch — `parallel-handler-caught`**

Wrap the callback body for one branch in `handle { ... } catch { ... }`. The other branch has no surrounding handler. Assertions: only the unhandled branch surfaces an interrupt; the handler's catch block runs in its branch (assert via a counter inside the catch); one cycle resumes the program.

Also add a contrast assertion to the **Step 1 of Task 3a fixture** (in a follow-up commit if needed): wrapping the *whole program* in a `handle { ... } catch { ... }` where no handler is registered at the callback firing point — assert it does NOT catch the interrupt.

- [ ] **Step 5: Asymmetric tool outcome — `parallel-asymmetric-failure`**

Branch A's tool succeeds and fires `onToolCallEnd` (which interrupts). Branch B's tool returns a failure (`return failure("nope")` from inside the tool body — verify this is what the deterministic client supports rather than `throw`; if it can only force `throw`, narrow this fixture to that). End hook is skipped on B per `prompt.ts:716`. Assertions: exactly one interrupt surfaces; B's failure propagates as a normal tool error; both branches' `completedSteps` are coherent on resume.

- [ ] **Step 6: Mixed tool-body interrupt + callback interrupt — `parallel-tool-body-plus-callback`**

Branch A's tool body itself calls `interrupt(...)`. Branch B's `onToolCallEnd` callback interrupts. The most realistic real-world scenario (approval gate + tool that needs human input). Assertions: both surface in one batch; routed by data; on resume each branch resumes at the right point (A inside the tool body, B inside the callback frame); each tool body runs exactly once.

- [ ] **Step 7: Multi-cycle parallel callback interrupts — `parallel-multi-cycle`**

Two branches: first cycle, both `onToolCallStart` callbacks interrupt. After approval, both tools run, and both `onToolCallEnd` callbacks interrupt on the second cycle. Assertions: two separate cycles of `respondToInterrupts`; each branch's tool body runs exactly once across both cycles; both branches' frames are correctly distinguished across cycles.

- [ ] **Step 8: Run all seven, stage failing ones with `.todo`, commit**

```bash
make fixtures > /tmp/mkfix.log 2>&1
for d in tests/agency-js/callback-interrupts/parallel-*/; do
  name=$(basename "$d")
  pnpm run agency js "$d/test.js" > "/tmp/$name.log" 2>&1 || true
done
printf 'test: add extended regression fixtures for parallel-branch callback interrupts\n' > /tmp/cm.txt
git add tests/agency-js/callback-interrupts/
git commit -F /tmp/cm.txt
```

**Explicitly out of scope:** multi-callback-per-branch (two `onToolCallEnd` callbacks both interrupting in the same branch) — see [Plan 2](2026-05-22-callback-interrupts-fork-style-resume.md).

---

### Task 4: Fix the gap identified in Task 2

Substeps depend on Task 2's primary hypothesis. The plan provides three contingent paths; the implementer picks the one matching the hypothesis (or surfaces to the user if the actual cause is none of them).

- [ ] **Step 1: Add temporary observability**

Inside each `b.step` body that wraps `callHook` in `prompt.ts:657-743`, add a temporary `console.error('[debug] callHook returned', name, result?.length ?? 0)` after the `await`. Inside `BranchRunner.step` (`promptRunner.ts:214-226`) add `console.error('[debug] step body returned', key, result?.length ?? 0)`. Re-run the failing fixtures and capture the trace.

Remove these `console.error` calls before committing the fix.

- [ ] **Step 2 (if hypothesis: per-branch checkpoint not preserved via `setInterruptOnBranch`):**

The fix reuses the existing slice-only composition pattern from `docs/dev/concurrent-interrupts.md:73-91`. After `callHook` returns an `Interrupt[]` inside the `b.step` body, call `stack.setInterruptOnBranch(branchKey, intr[0].interruptId, intr[0].interruptData, intr[0].checkpoint)` on the tool branch (`tool_<toolCall.id>`) so the inner callback-stamped checkpoint lives on `BranchState.checkpoint`. The outer `pr.parallel` checkpoint's stack walk then picks it up automatically — no new `Interrupt` field.

Reference the equivalent pattern for tool-body interrupts (search `prompt.ts` and `runInvokeStep` for the existing `setInterruptOnBranch` call) and mirror its shape.

- [ ] **Step 3 (if hypothesis: per-branch `__self` frame collision):**

**STOP and surface to the user.** This is the same sequential→parallel transition Plan 2 makes for same-hook multi-callback. If single-callback-per-branch needs this too, Plan 2's scope folds into this plan. Decide with the user whether to merge plans or to do the minimal callback-branching fix here and let Plan 2 generalize it later.

- [ ] **Step 4 (if hypothesis: interrupt-response routing collision):**

Likely the lifted callback codegen path. Verify each `__self.__interruptId_N` is uniquely set per fire (Task 2 Step 3). If so, the bug is elsewhere; surface to the user.

If somehow IDs DO collide (extremely unlikely given nanoid), the fix is in `lib/preprocessors/liftCallbackBlocks.ts` plus a `make fixtures` regeneration.

- [ ] **Step 5: Regenerate fixtures (if codegen touched)**

```bash
make fixtures > /tmp/mkfix-post-fix.log 2>&1
```

Inspect the diff. If only generated code changed in expected places, proceed.

- [ ] **Step 6: Un-stage the `.todo` markers and re-run**

```bash
for f in tests/agency-js/callback-interrupts/parallel-*/test.js.todo; do
  mv "$f" "${f%.todo}"
done
for d in tests/agency-js/callback-interrupts/parallel-*/; do
  name=$(basename "$d")
  pnpm run agency js "$d/test.js" > "/tmp/$name-post-fix.log" 2>&1
done
```

All must pass.

- [ ] **Step 7: Run regression suite**

```bash
pnpm test:run -- callback fork/llm-tools parallel > /tmp/regression.log 2>&1
```

Existing `callback-*`, `multi-tool-*`, `tool-multi-cycle`, `parallel/*` tests must all pass.

- [ ] **Step 8: Remove the temporary `console.error` debug lines**

- [ ] **Step 9: Commit the fix**

```bash
printf 'fix: preserve per-branch callback checkpoints across pr.parallel\n\nUses setInterruptOnBranch on tool_<id> branches so callback-stamped\ninner checkpoints participate in the slice-only composition pattern\n(docs/dev/concurrent-interrupts.md:73-91), mirroring how tool-body\ninterrupts already work.\n' > /tmp/cm.txt
git add lib/runtime/ lib/preprocessors/ tests/agency-js/
git commit -F /tmp/cm.txt
```

---

### Task 5: Promote `.todo`-staged fixtures (only if any remain after Task 4)

- [ ] **Step 1: Rename remaining `.todo` markers**

```bash
find tests/agency-js/callback-interrupts/ -name "test.js.todo" -exec sh -c 'mv "$1" "${1%.todo}"' _ {} \;
```

- [ ] **Step 2: Re-run to confirm pickup**

```bash
pnpm test:run -- callback-interrupts > /tmp/post-promote.log 2>&1
```

- [ ] **Step 3: Commit**

```bash
printf 'test: promote parallel-branch callback-interrupt fixtures out of .todo\n' > /tmp/cm.txt
git add tests/agency-js/callback-interrupts/
git commit -F /tmp/cm.txt
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/dev/callback-hooks.md`
- Modify: `docs/site/appendix/callbacks.md`
- Modify: `docs/superpowers/specs/2026-05-22-parallel-callback-interrupts.md`
- Delete: `docs/notes/parallel-callback-investigation.md`

- [ ] **Step 1: Verify the per-hook table in `docs/site/appendix/callbacks.md` matches reality**

The current rows for `onToolCallStart`/`onToolCallEnd` already claim **✅ Batched**. This plan's work *makes that true* (it was aspirational before). Verify each entry literally matches post-fix behavior. Add a sentence under "Concurrent firing across fork branches" noting LLM-driven parallel tool calls now also batch correctly across branches.

- [ ] **Step 2: Update `docs/dev/callback-hooks.md`**

Add a subsection under "Multiple callbacks on the same hook" explicitly documenting the parallel-branch path: per-branch `b.step` wraps each hook fire, `setInterruptOnBranch` preserves the per-callback inner checkpoint on the tool branch, `pr.parallel` stamps a single outer checkpoint whose stack walk picks up the inner slices automatically.

- [ ] **Step 3: Replace the spec status header**

In `docs/superpowers/specs/2026-05-22-parallel-callback-interrupts.md`, **replace** (do not stack) the "Status: revised after partial implementation" header from Task 1 Step 2 with:

```markdown
> **Status: implemented in <commit-sha>.** See
> `docs/superpowers/plans/2026-05-22-callback-interrupts-parallel-tool-branches.md`.
```

- [ ] **Step 4: Delete the investigation notes**

```bash
git rm docs/notes/parallel-callback-investigation.md
```

- [ ] **Step 5: Commit docs**

```bash
printf 'docs: document parallel-branch callback-interrupt implementation\n' > /tmp/cm.txt
git add docs/
git commit -F /tmp/cm.txt
```

---

### Validation checklist

- [ ] All Task 3a fixtures pass (and any from Task 3b that were created).
- [ ] Existing `callback-*`, `fork/llm-tools/*`, `parallel/*` tests pass.
- [ ] `pnpm run lint:structure` clean.
- [ ] `make` succeeds.
- [ ] `make fixtures` no-op after Task 4 Step 5 commit (no further drift).
- [ ] Spec doc reconciled with implementation.
- [ ] No `console.error` debug scaffolding left in `lib/runtime/`.
- [ ] `.agency-tmp/parallel-cb-repro/` directory deleted (Task 2 Step 7).
- [ ] No `test.js.todo` markers remain anywhere in `tests/agency-js/callback-interrupts/`.
- [ ] Handler-catches-branch fixture (Task 3b Step 4) confirms handler safety is intact.
- [ ] Reject-one-branch fixture (Task 3b Step 3) confirms the failure path through `b.step`+`pr.parallel` works.
- [ ] Mixed tool-body + callback fixture (Task 3b Step 6) covers the most realistic real-world combination.

---

### Risks and contingencies

- **Task 2 may conclude there is no bug.** Possible — the spec is out of date and the `b.step`+`pr.parallel` machinery may already be correct. If so, this plan collapses to: lock in the three Task 3a fixtures, confirm green, update docs.
- **Task 4 Step 3 (`__self` frame collision) folds into Plan 2.** Surface to the user before doing any code work — both plans then need to be merged.
- **`Promise.all` non-deterministic ordering** must NOT leak into the test driver. Every fixture's response-routing key is `data.toolName` (or another payload field), never an ordinal index. The `responses` array IS positional with respect to the `interrupts` array (per the existing `interrupt-respond-by-data` precedent), but each response is *selected* by inspecting `interrupts[i].data`.
- **DeterministicClient may not support `throw` from a tool body** for Task 3b Step 5 (asymmetric failure). Verify before writing the fixture; narrow to `return failure(...)` if needed.
- **Multi-callback-per-branch is out of scope.** See [Plan 2](2026-05-22-callback-interrupts-fork-style-resume.md).
