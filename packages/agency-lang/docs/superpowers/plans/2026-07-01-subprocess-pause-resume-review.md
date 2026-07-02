# Review: Subprocess Pause/Resume Implementation Plan

**Reviewed plan:** `docs/superpowers/plans/2026-07-01-subprocess-pause-resume.md`
**Referenced spec:** `docs/superpowers/specs/2026-07-01-subprocess-pause-resume-design.md`
**Reviewer:** amp (oracle-assisted)
**Date:** 2026-07-01

## Overall rating: 7/10

Strong architectural plan that is mostly faithful to the spec and correctly targets the real seams in the current runtime. The flat-case design is sound. The weak spots are concentrated in statelog plumbing, opaque-payload keying, and a handful of tests that are weaker than the invariants they claim to guard.

---

## Top strengths

- **Core architecture matches the spec.** Parent reports a `HandlerChainOutcome`, child merges and decides, and propagate/no-response reuses the child's existing normal interrupt path. This avoids inventing new checkpoint machinery and composes naturally when nesting lands in Task 10.
- **Good alignment with the real code.** Targets `interruptWithHandlers` IPC branch, `sendInterruptToParent`, parent `handleInterruptMessage`, the bootstrap's single `run` instruction, `_run`'s hand-rolled promise, and `compile()`'s `{ path, moduleId }` — all real seams, not invented ones.
- **Increment order is sensible.** Fix vote semantics → self-contained `CompiledProgram` → child pause → parent surface → resume → concurrency/durability → nesting last. Each increment leaves the tree buildable (with one honestly-flagged intermediate in Task 3→4).
- **The plan understands the invariants.** Parent always replies; child interrupt IDs are resume keys; child checkpoint is opaque in the parent; handler re-registration is safety-critical; `_run`'s `invoke` returns `Interrupt[]` and never throws them. These are called out and re-referenced across tasks.
- **Test coverage is on the right axes.** Concurrency matrix, multi-cycle, reject-response, two-subprocesses, handler re-registration, per-segment limits, durability — the right scenarios for the feature.

## Top weaknesses / risks

- **Task 8 statelog work is under-specified and partially wrong against current code.** The plan says to call `startSpan("subprocessRun")`, but `SpanType` in `lib/statelogClient.ts` is a closed union that does not currently include `"subprocessRun"`. The plan does not list that file as a Task 8 edit. The spec also calls for `spanContext` on `run`/`resume` instructions; the plan never carries it.
- **Interrupt-ID preservation is subtly broken in `gatherChainOutcome`.** The proposed helper mints a fresh `interruptId` for the parent-side chain walk. Resume still works (decision routing uses `msg.interruptId`), but parent-side `handlerDecision` / `interruptResolved` events won't correlate with the child's interrupt ID — contradicting the plan's own "preserved verbatim end-to-end" invariant.
- **Opaque payload keying is not nailed down.** `SUBPROCESS_PAYLOAD_KEY = "__subprocess_state_0"` in `parentFrame.locals` is probably fine in the pure flat case, but Task 6 acknowledges possible collisions with two concurrent subprocesses. That should be resolved before Task 4 lands, not discovered by tests later. Prefer a callsite-derived key or per-branch frame locals from the outset.
- **Durability test is weaker than the spec.** The spec calls for "respond from a fresh process." The proposed test only JSON-round-trips the surfaced interrupts and deletes `.agency-tmp`, then resumes in the **same** process. That proves the child artifact isn't needed at resume time, but not full fresh-process durability. Spawn a new Node process for the resume half.
- **Parent-side handler re-registration is not directly tested.** The child-local test (`pause-then-child-handler.agency`) is good, but there is no dedicated test that a resumed child's second interrupt is caught by a **parent** handler that had to be replay-registered before `_run` re-entered.
- **Task 4's `checkpointLocation` is a smell.** `(store as any).callsite ?? { moduleId: "", scopeName: "_run", stepPath: "subprocess" }` is a placeholder. Real `runBatch` adopters in the codebase carry proper callsite metadata; the plan should identify the correct source rather than leaning on a fallback that risks incorrect statelog/debug/checkpoint metadata.
- **A couple of test assertions are too weak to prove the claim.** The mixed-batch "cached branch does not re-execute" check falls back to result correctness if there's no stdout assertion field. Durability's `agencyTmpWasGone: !existsSync(".agency-tmp") || true` is effectively `true` regardless. Either wire real assertions or drop the pretense.

## Critical gaps to fix before executing

1. **Statelog compile/runtime gap (Task 8).** Explicitly modify `lib/statelogClient.ts` to add `"subprocessRun"` to `SpanType`, and either thread `spanContext` per spec or consciously document the deviation.
2. **`gatherChainOutcome` must accept the child's existing `interruptId`.** Don't mint a new one; the parent-side handler-chain events should correlate to the child's interrupt for observability and debugger UX.
3. **Resolve payload keying before Task 4.** Decide whether the payload lives in `_run`'s runBatch child state or in a callsite-derived frame-local key. Make it callsite-stable so two concurrent subprocesses cannot collide.
4. **Upgrade the durability test to a true fresh-process resume.** Spawn a new Node process (or use `test.js` split across two runs) before calling `respondToInterrupts`. Same-process JSON round-trip is not enough to defend the spec's strongest claim.
5. **Add one parent-side re-registration test.** After resume, second interrupt is caught by a parent handler — proving the parent handler chain is back before `_run` re-enters replay.

## Smaller improvements

- Add an explicit assertion (unit or type-level) that `IpcInterruptedMessage` is included in the `sendResultOrLimitError` payload-limit gate — the plan claims inheritance via `sendOrDie` but does not test it directly (Task 9 Step 2 hand-waves this).
- Task 10 conflates the `_run` `maxDepth` parameter change with the `imports.mustache` template edit. Since param count changes, be explicit: template MUST be updated, `make` MUST be re-run, and any snapshot fixtures for `_run` descriptor generation must be regenerated.
- The `runNode` runId inheritance seam (Task 8 Step 2.4) is described as "follow `runNode` → context creation." That's the highest-risk edit in Task 8 for correctness (getting it wrong silently orphans child statelogs). Pin the exact file/line before starting, not during.
- The nesting task's `nested-blocked` flip is ambiguously described — either delete it and rename, or fully rewrite it. Leave no half-flipped test.

## Bottom line

The architecture is right. The plan is unusually detailed and mostly executable as-is. If the five critical gaps above are addressed before Task 4, and Task 8's statelog work is fully specified, this moves to **8.5/10**. As it stands, the executor is likely to ship correct behavior but with orphaned observability, a weak durability guarantee, and one latent concurrency bug that only surfaces under load.

---

## Addendum: check against `docs/dev/anti-patterns.md`

### Declarative vs imperative (the central question)

**Mixed.** The plan introduces several excellent declarative interfaces:

- `mergeChainOutcomes(inner, outer)` — pure, table-shaped merge.
- `gatherChainOutcome(...)` — hides local-chain + IPC-consult + merge composition.
- `serializeInterruptsForIpc`, `buildRunInstruction`, `buildResumeInstruction`, `collectSubprocessResponses`, `materializeCompiledScript` — each names a *what* and encapsulates a *how*.
- `runSubprocessSession(...)` returning a `SessionOutcome` discriminant.

**But the top-level `_run` `invoke` closure (Task 4) is exactly the anti-pattern the doc warns against.** It inlines resume-vs-run decision, materialize, session invoke, outcome branching, payload storage, cleanup, and the strip-checkpoints mapping. Reads as a paragraph of imperative glue. Would be far clearer as:

```ts
const outcome = saved
  ? await resumeSubprocess({ compiled, saved, ctx, ... })
  : await startSubprocess({ compiled, node, args, ctx, ... });
return handleSubprocessOutcome(outcome, parentFrame);
```

Same critique of Task 1's IPC branch rewrite: the merge + verdict rendering + statelog dispatch is a 25-line imperative block that should be `renderVerdict(merged, ctx, interruptSummary)`.

### Other anti-patterns present

- **Leaky abstraction (Task 4, lines ~800-810).** `parentFrame.locals[SUBPROCESS_PAYLOAD_KEY] = { ... }` reaches straight into internal frame storage from the caller; `SUBPROCESS_PAYLOAD_KEY` is even exported. Should be `saveSubprocessPayload(frame, payload)` / `loadSubprocessPayload(frame)` / `clearSubprocessPayload(frame)` — same lesson as the doc's `restoreState` vs `__internalStack` example.

- **Order-dependent mutable state (Task 8).** `setSubprocessRunInfo` is module-scoped state that MUST be set before the dynamic import; the unit test even says "reset for other tests" — a classic warning sign. Also `parentFrame.locals[SUBPROCESS_PAYLOAD_KEY]` is set/deleted imperatively based on branch outcome instead of derived from the outcome value.

- **Nested ternary (Task 1, Step 4):**
  ```ts
  const local = hasPropagation ? { kind: "propagated" }
    : hasApproval ? { kind: "approved", value: approvedValue }
    : { kind: "noResponse" };
  ```

- **Try-catch without logging (Task 4, Step 4):**
  ```ts
  try { child.kill("SIGKILL"); } catch (_) { /* already gone */ }
  ```
  A comment isn't logging; the catch silently swallows.

- **Single-character variable names.** `runSubprocessSession` uses `s` throughout (`s.ctx`, `s.stateStack`, `s.resolvePromise`).

- **Magic numbers.** `LIMIT_CEILINGS.depth = 10`, `maxDepth: number = 5` (Task 10), and Task 6's `wallClock: 600ms`/`sleep 0.4` are inline literals with no named constants or rationale.

- **Duplicating existing code — mild risk.** The IPC branch reimplements verdict rendering (statelog + return shape) instead of routing through a shared render path. If no helper exists today, extract one so IPC and non-IPC branches share it.

### Not anti-patterns

- The `dynamic import` in `subprocess-bootstrap.ts` is the runtime's one sanctioned exception; the plan correctly annotates it.
- The vote-combining merge table is exemplary declarative code.

### Recommended fixes before executing Task 4

1. Extract `resolveInstruction(saved, compiled, ...) → RunInstruction | ResumeInstruction`.
2. Add `saveSubprocessPayload(frame, outcome)` / `loadSubprocessPayload(frame)` / `clearSubprocessPayload(frame)` and remove the exported `SUBPROCESS_PAYLOAD_KEY`.
3. Add `renderVerdict(merged: HandlerChainOutcome, ctx, summary) → HandlerVerdict` — shared by the IPC branch and, if possible, the non-IPC tail.
4. Replace the nested ternary with an `if/else if/else` block (per the doc's example).
5. Replace the silent `child.kill` catch with a debug log.
6. Rename `s` → `session` throughout `runSubprocessSession`.
7. Name the depth ceilings/defaults as constants with a comment explaining the values.

---

## Addendum: test-plan review

Would each test actually fail when its target behavior breaks? Are there gaps?

### Per-test verdicts

| Test | Verdict | Notes |
|---|---|---|
| Task 1 `mergeChainOutcomes` unit | Adequate | Covers the key `approve+silent → approve` fix. Pure arithmetic only. |
| Task 1 `vote-child-approve-parent-silent` | Adequate | The important matrix cell; other cells (propagate, parent-reject, all-silent surface) uncovered. |
| Task 2 `_compile` returns `{moduleId, code}` | **Weak** | Imports `existsSync` but never asserts on disk; a regression that still writes temp files could slip through. |
| Task 3 `serializeInterruptsForIpc` | **Weak** | Structural only; no JSON round-trip; no `runId`/`subprocessSessionId` shape assertion. |
| Task 4 `subprocess-pause-basic` | Adequate | The central surface-then-resume path; would fail on old auto-reject or broken decision routing. |
| Task 5 `pause-then-child-handler` | Adequate for child side | **No parent-side re-registration mirror exists.** |
| Task 6 `concurrent-handled` | Adequate | Message correlation covered; statelog span isolation not proved. |
| Task 6 `pause-fork-all-unhandled` | Adequate | Batching + one-resume-resumes-all. No checkpoint shape inspection. |
| Task 6 `pause-fork-mixed` | **Weak** | Cache proof is soft (comment says "if there's no stdout assertion hook, rely on returned array") — a buggy impl that re-runs the handled branch produces the same array. |
| Task 6 `pause-multi-cycle` | Adequate | Sequential only. |
| Task 6 `pause-reject-response` | Adequate | Reject-as-response semantic. |
| Task 6 `pause-two-subprocesses` | Adequate | Payload-key collision would surface as wrong output. |
| Task 7 `subprocess-durable-resume` | **Weak** | Same-process JSON round-trip; the `agencyTmpWasGone: ... || true` assertion is always true; hidden in-memory dependence survives. |
| Task 8 `setSubprocessRunInfo` unit | **Weak** | Getter/setter plumbing only; doesn't prove propagation through fork/resume paths. |
| Task 8 runId inheritance (log-file) | Adequate | Provided the assertion is really made on child log events; no `subprocessSessionId` or span shape checks. |
| Task 9 `pause-limit-wallclock-resets` | **Weak** | Timing-flaky (0.4s sleep vs 600ms cap); wall-clock only — other per-segment resets untested. |
| Task 9 oversized `interrupted` msg | **Missing** | Written as an either/or suggestion, not a concrete test. Needs a real tiny-`ipcPayload` E2E. |
| Task 10 `nested-basic` | Adequate | Happy path; no depth-value assertions. |
| Task 10 `nested-depth-cap` | **Weak** | Doesn't test the exact boundary; off-by-one on `childDepth > cappedMaxDepth` survives. |
| Task 10 `nested-pause-resume` | Adequate | Recursive surfacing + full-tree resume. |
| Task 10 `nested-reject-middle` | **Weak** | Outcome-only; a buggy impl that still consults upward but ends in reject would pass. |
| Task 10 `nested-blocked` flip | Adequate | Real behavior-flip check. |

### Top test-plan gaps

1. **No parent-side handler re-registration test.** Mirror `pause-then-child-handler` with the parent holding the second-interrupt handler.
2. **Durability test is same-process.** Spawn a fresh Node process (or two separate test.js runs) for the resume half; otherwise the spec's strongest claim is unverified.
3. **JSON round-trip is not directly tested where the failure would show up.** Add a `serializeInterruptsForIpc` output → `JSON.parse(JSON.stringify(...))` → resume test; proves no class instances leaked into the checkpoint tree.
4. **Mixed-batch cache proof is too soft.** Make the side-effect marker a hard assertion (write to a marker file, `readFileSync` asserts the branch ran exactly once), not a fallback-to-array-equality.
5. **Oversized `interrupted` payload lacks a real test.** Write an E2E with `ipcPayload: 1kb` and a pausing child; expect the structured `limit_exceeded` failure. Type-level tests do not exercise the message path.
6. **Depth cap boundary is under-tested.** Add both "allowed at cap" and "rejected at cap+1"; assert the `depth` value visible in the `std::run` interrupt data and via `agency.ctx()`.
7. **No nested lock-relay test.** Write a nested test where a grandchild holds a named lock and a middle branch waits on it — proves the tree shares the root's lock domain and would fail if `handleLockAcquireMessage` acquires locally at mid-tree.
8. **Statelog coverage stops at `runId`.** Add a test that asserts `subprocessSessionId` correlates all events for one logical child run, and that two concurrent child interrupts don't interleave `handlerChain` spans on the parent (Task 8 Step 2.6's Q1 hardening claim).

If these eight gaps were addressed, the test plan would catch the failure modes the spec actually cares about. Without them, the executor can hit a green build with real regressions still live — most dangerously the parent-side handler re-registration and the lock-relay direction bugs.
