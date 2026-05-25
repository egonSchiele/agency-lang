# Subprocess Propagation & Resume Implementation Plan (revised)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `run()` to resume a subprocess from a checkpoint, and wire handler propagation to use this so subprocess interrupts can reach the user.

**Architecture:** Two stages.
- **Stage 1** adds a `"resume"` message type to the IPC protocol so the bootstrap can call `respondToInterrupts` instead of running a node from scratch. Also threads the parent's runId into the subprocess at launch and reconstructs JSON-serialized checkpoints in the bootstrap.
- **Stage 2** creates a checkpoint in IPC mode at every interrupt site, includes it in the interrupt message, and has the parent return `Interrupt[]` from `_run` when propagation is needed.

**Tech Stack:** Node.js child_process IPC, Agency runtime (checkpoints, interrupts, state serialization)

**Spec:** `docs/superpowers/specs/2026-05-09-subprocess-propagation-and-resume-design.md`

---

## How `runBatch` changes the picture (2026-05-23 update)

Since this plan was written, the runtime gained `runBatch` — a single
concurrent-interrupt primitive that owns per-child branch creation,
abort composition, settle, shared checkpoint stamping, and
`intr.checkpoint`/`checkpointId` overwrite. It currently backs four
call sites: `Runner.runForkAll`, `Runner.runRace`,
`PromptRunner.parallel` (parallel tool calls), and `Runner.hook`
(multi-callback hook batching). The full reference is at
`docs/dev/runBatch.md`; the architectural context (BranchState slice
rule, leaf-checkpoint vehicle, propagation pattern) is at
`docs/dev/concurrent-interrupts.md`.

**Net effect on this plan:** core tasks 1–10 are unchanged. The
"subprocess-side fork+propagation" limitation that Task 6 Step 5
guards against is now a much cleaner future extension because the
batching machinery already exists in the non-IPC path. `runBatch.ts`'s
own docstring already calls this out under "Subprocess-shape
(future)": the per-child branch + idempotent re-entry + shared
checkpoint stamping shape is exactly what an IPC adapter needs. The
future fix sketches in Task 6 / Task 11 below have been rewritten to
point at this concrete path rather than re-inventing the batching
abstraction inside IPC code.

The slice rule (`opts.parentStack` MUST be the local stack, not
`ctx.stateStack`) that this plan already respects in Task 6 Step 3 is
exactly the same rule `runBatch` callers must follow today. Task 6's
local-stack discipline therefore aligns with how every existing
adapter already works — no extra effort, just a reminder that the
discipline is now load-bearing for both paths.

---

## Scope notes

**In scope:**
- Single propagating interrupt from a subprocess reaches the user, carries a checkpoint, and resumes correctly via a fresh subprocess invocation.
- Parent and child share a single runId for the duration of the logical run.
- Resume uses the compiled temp dir from the original `compile()` (preserved across propagation; cleaned up at parent exit).

**Out of scope (must fail loudly, not silently):**
- **Subprocess-side fork / race / LLM-tool batching that produces propagating interrupts.** The non-IPC path is `runBatch` (mode `"all"` / `"race"`), which lets every sibling run to completion, collects every halt into a single batched `Interrupt[]`, and stamps a single shared parent checkpoint. In IPC mode each branch's `interruptWithHandlers` synchronously blocks on its own `sendInterruptToParent` IPC round-trip mid-leaf — so the runner never sees `Interrupt[]` to accumulate, `runBatch`'s batching pipeline is bypassed, and `settleWithPropagation`'s `SIGKILL` tears down sibling branches mid-flight. We add a runtime guard that throws a clear error if any branch reaches `interruptWithHandlers` with propagation while running inside a forked stack in IPC mode. Future fix (per `runBatch.ts`'s "Subprocess-shape (future)" comment): make `interruptWithHandlers` RETURN `Interrupt[]` in IPC mode instead of blocking, let `runBatch` collect them as today, then add an IPC adapter on the parent side that sends a batched message + awaits per-id decisions.
- Timeout / AbortSignal integration (separate feature).
- Nested subprocess execution (already blocked by design).
- Debugger / trace integration across process boundary.
- Automatic cleanup of resume temp dirs that the user never resumes (parent-exit cleanup only; users can call a helper to clean up explicitly).

---

### Task 1: Parent dictates `runId` at subprocess launch

**Why:** Parent and child are part of the same logical run. The propagated interrupt's `runId` will be used by `respondToInterrupts` later. If the child mints its own runId, parent + child have inconsistent ids and joining trace/log entries by runId is impossible.

**Files:**
- Modify: `lib/runtime/ipc.ts` (add `runId` to `RunInstruction` type; populate in `_run`)
- Modify: `lib/runtime/subprocess-bootstrap.ts` (use the supplied `runId` when constructing the child `RuntimeContext`)

- [ ] **Step 1:** Add `runId: string` (required) to `RunInstruction`.
- [ ] **Step 2:** In `_run`, build the `RunInstruction` with `runId: __state.ctx.getRunId()`.
- [ ] **Step 3:** In the bootstrap's `handleRun`, use `msg.runId` when creating the subprocess `RuntimeContext` (mirror however the existing `respondToInterrupts` flow injects the runId via `createExecutionContext(runId)`).
- [ ] **Step 4:** Verify with `pnpm run a test tests/agency/subprocess/run-basic.agency` — must still pass.
- [ ] **Step 5:** Commit: `feat: parent dictates subprocess runId at launch`

---

### Task 2: Bootstrap handles `"resume"` message type, with checkpoint reconstruction

**Files:**
- Modify: `lib/runtime/subprocess-bootstrap.ts`
- Modify: `lib/runtime/ipc.ts` (add `ResumeInstruction` type)

- [ ] **Step 1:** Add `ResumeInstruction` to `ipc.ts`. Required fields: `type: "resume"`, `scriptPath`, `interrupts: any[]`, `responses: any[]`, `runId: string`. Optional: `ipcPayload`.

- [ ] **Step 2:** In `subprocess-bootstrap.ts`, refactor the message handler to dispatch on `msg.type`. Extract existing run logic into `handleRun(msg)`; add `handleResume(msg)`.

- [ ] **Step 3:** Inside `handleResume`, BEFORE calling `respondToInterrupts`, walk `msg.interrupts` and reconstruct each `interrupt.checkpoint` via `Checkpoint.fromJSON(interrupt.checkpoint)`. Without this, `respondToInterrupts → restore → cp.getLocation()` will throw because IPC JSON-serializes the message and methods are stripped.
  ```ts
  for (const i of msg.interrupts) {
    if (i.checkpoint && typeof i.checkpoint.getLocation !== "function") {
      i.checkpoint = Checkpoint.fromJSON(i.checkpoint);
    }
  }
  ```
  Verify `Checkpoint.fromJSON` is exported from `lib/runtime/state/checkpointStore.ts` (it is — line 199).

- [ ] **Step 4:** `handleResume` calls `mod.respondToInterrupts({ ctx: ..., interrupts: msg.interrupts, responses: msg.responses })`. Reuse the same `sendResultOrLimitError` and try/catch shape as `handleRun`.

- [ ] **Step 5:** Build clean (`make`); run `pnpm run a test tests/agency/subprocess/run-basic.agency` — must still pass (unchanged code path for "run").

- [ ] **Step 6:** Commit: `feat: bootstrap handles "resume" message type with checkpoint reconstruction`

---

### Task 3: `_run` and `run()` accept `interrupts`/`responses`; resume uses interrupt's `compiledPath`

**Files:**
- Modify: `lib/runtime/ipc.ts` (`_run` signature, `attachSessionHandlers` selects "run" vs "resume", uses `interrupt.compiledPath` on resume)
- Modify: `stdlib/agency.agency` (`run()` gains `interrupts`/`responses` params)
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache` (update `_run` AgencyFunction params to include `interrupts`/`responses`)

- [ ] **Step 1:** Add `interrupts: any[]` and `responses: any[]` params to `_run`. Plumb through to `attachSessionHandlers`.

- [ ] **Step 2:** In `attachSessionHandlers`, when `interrupts.length > 0 && responses.length > 0`, build a `ResumeInstruction` and use the **compiledPath from the interrupt** (`interrupts[0].compiledPath`) as `scriptPath`, NOT `s.compiledPath`. Rationale: by the time the user calls `run()` again to resume, their `compiled` argument may be a different `compile()` result; the resume must point at the original temp dir that was preserved through propagation. Validate that all interrupts in the batch carry the same `compiledPath` (they will — they all came from the same subprocess).

- [ ] **Step 3:** Send `runId: interrupts[0].runId` in the `ResumeInstruction` so the resumed subprocess uses the same runId as the original child.

- [ ] **Step 4:** Add `interrupts: object[] = []` and `responses: object[] = []` params to `run()` in `stdlib/agency.agency`. Threading: `_run(compiled, node, args, wallClock, memory, ipcPayload, stdout, interrupts, responses)`.

- [ ] **Step 5:** Update the `_run` AgencyFunction `params:` array in `imports.mustache` to include the two new params (so the AgencyFunction wrapper accepts them positionally and by name).

- [ ] **Step 6:** Build (`make`) and run `pnpm run a test tests/agency/subprocess/run-basic.agency`. Existing tests must pass; new params default to empty.

- [ ] **Step 7:** Commit: `feat: _run and run() accept interrupts/responses for subprocess resume; use interrupt's compiledPath on resume`

---

### Task 4: Smoke test — `run()` accepts empty `interrupts`/`responses` without regression

This is a smoke test, NOT the resume integration test (which lives in Task 9 once Stage 2 lands).

**Files:**
- Create: `tests/agency/subprocess/resume-smoke-empty-args.agency`
- Create: `tests/agency/subprocess/resume-smoke-empty-args.test.json`

- [ ] **Step 1:** Write a tiny .agency that calls `run(... interrupts: [], responses: [])` and expects the normal result.

- [ ] **Step 2:** Run, expect PASS. Commit: `test: run() accepts empty interrupts/responses (smoke test)`

---

### Task 5: Plumb `location` through `interruptWithHandlers` so the IPC checkpoint can use the real API

**Why:** `interruptWithHandlers` currently takes `(kind, message, data, origin, ctx, stack?)`. To create a checkpoint inside it (Stage 2), it needs `{ moduleId, scopeName, stepPath }` — these strings are required by `ctx.checkpoints.create(stateStack, ctx, { moduleId, scopeName, stepPath })` and feed the location-based restore-count tracking. Empty strings would break that tracking.

The good news: both call sites (`interruptReturn.mustache` line 32 and `interruptAssignment.mustache`) already render these three values into the *next* call (`ctx.checkpoints.create`). So we already know they're in scope; we just need to pass them one call earlier into `interruptWithHandlers`.

**Files:**
- Modify: `lib/runtime/interrupts.ts` (`interruptWithHandlers` signature gains `location?: { moduleId: string; scopeName: string; stepPath: string }`)
- Modify: `lib/templates/backends/typescriptGenerator/interruptReturn.mustache` (pass `{ moduleId: {{{moduleId}}}, scopeName: {{{scopeName}}}, stepPath: {{{stepPath}}} }`)
- Modify: `lib/templates/backends/typescriptGenerator/interruptAssignment.mustache` (same)

- [ ] **Step 1:** Add the optional `location` param to `interruptWithHandlers` (don't use it yet — that's Task 6). Default to `undefined`.

- [ ] **Step 2:** Update both mustache templates to pass the location object as the 7th argument. Run `pnpm run templates` to regenerate the `.ts` template runners.

- [ ] **Step 3:** Build, run a wide swath of existing tests:
  ```bash
  pnpm test:run 2>&1 | tee /tmp/test-task5-unit.log
  pnpm run a test tests/agency/subprocess 2>&1 | tee /tmp/test-task5-sub.log
  pnpm run a test tests/agency/fork 2>&1 | tee /tmp/test-task5-fork.log
  ```
  All must pass — no behavior change yet.

- [ ] **Step 4:** Commit: `refactor: plumb location through interruptWithHandlers (no behavior change)`

---

### Task 6: Create checkpoint in IPC mode, attach to interrupt message, respect slice rule

**Files:**
- Modify: `lib/runtime/interrupts.ts` (`interruptWithHandlers` IPC branch creates checkpoint via the real API; uses local `stack ?? ctx.stateStack`)
- Modify: `lib/runtime/ipc.ts` (`sendInterruptToParent` accepts `checkpoint`; `IpcInterruptMessage` gains `checkpoint` and `runId` fields)

- [ ] **Step 1:** Add to `IpcInterruptMessage`:
  ```ts
  checkpoint?: any;  // serialized Checkpoint JSON; present when subprocess wants to support resume
  runId: string;     // the child's runId — same as parent's, see Task 1
  compiledPath: string;  // so the parent can attach it to the propagated Interrupt
  ```

- [ ] **Step 2:** Update `sendInterruptToParent(interruptData, votes, checkpoint?, runId, compiledPath)` accordingly. It stays a pure transport function — the checkpoint is built by the caller.

- [ ] **Step 3:** In `interruptWithHandlers`'s IPC branch, BEFORE calling `sendInterruptToParent`, build the checkpoint:
  ```ts
  // Slice rule (see docs/dev/concurrent-interrupts.md): use the LOCAL stack,
  // not ctx.stateStack, so a future fork+propagation impl doesn't duplicate
  // outer state into branch slots. Even today (where fork+propagation is
  // out of scope), keeping this correct lets us add it later without a
  // silent regression.
  const localStack = stack ?? ctx.stateStack;
  const loc = location ?? { moduleId: "", scopeName: "", stepPath: "" };
  let checkpointJson: any = undefined;
  try {
    const cpId = ctx.checkpoints.create(localStack, ctx, loc);
    checkpointJson = ctx.checkpoints.get(cpId)!.toJSON();
  } catch (e) {
    // Checkpoint creation failed — propagation will still send the
    // interrupt, but resume won't be possible. Logged via ipc debug.
    if (process.env.AGENCY_IPC_DEBUG === "1") {
      process.stderr.write(`[ipc:child] checkpoint creation failed: ${e}\n`);
    }
  }
  const parentDecision = await sendInterruptToParent(
    { kind, message, data, origin },
    { propagated: hasPropagation },
    checkpointJson,
    ctx.getRunId(),
    process.env.AGENCY_COMPILED_PATH ?? "",  // see Step 4
  );
  ```

- [ ] **Step 4:** The child needs to know its own compiledPath so the parent can attach it to the propagated Interrupt. Pass it via env var `AGENCY_COMPILED_PATH` set by the parent when forking the subprocess. (Bootstrap currently knows `scriptPath` from the run/resume message, but `interruptWithHandlers` doesn't receive that. Env var is the cheapest plumbing.)

- [ ] **Step 5: Add the runtime guard for fork+propagation in IPC mode.** Detect "inside a forked/race/llm-tool/hook branch" via `localStack !== ctx.stateStack`. This is a precise detector that aligns with `runBatch`'s slice-rule discipline: every existing `runBatch` adapter (`runForkAll`, `runRace`, `PromptRunner.parallel`, `Runner.hook`) hands the child its own branch stack, so inside any batched branch the two are unequal; outside any branch they're reference-equal (via `setupFunction` in `lib/runtime/node.ts#L69` reading `state.stateStack ?? state.ctx.stateStack`). Throw before the IPC send when both conditions hold:
  ```ts
  if (isIpcMode() && hasPropagation && localStack !== ctx.stateStack) {
    throw new Error(
      "Subprocess-side fork/race/LLM-tool/multi-callback propagation is not yet supported. " +
      "The non-IPC path uses runBatch to collect concurrent interrupts into a single batch under a shared checkpoint; " +
      "IPC mode bypasses that pipeline because interruptWithHandlers blocks on per-leaf IPC round-trips. " +
      "Handle the interrupt with a local handler in the subprocess, or move the fork to the parent process. " +
      "See docs/dev/subprocess-ipc.md (multi-interrupt batching) and docs/dev/runBatch.md (Subprocess-shape future direction)."
    );
  }
  ```
  This guard fires uniformly for the four `runBatch` adopters, so adding the future batched-IPC path will surface as a single guard removal, not four.

- [ ] **Step 6:** Build and run handler tests:
  ```bash
  pnpm run a test tests/agency/subprocess/handler-approve.agency
  pnpm run a test tests/agency/subprocess/handler-reject.agency
  ```
  Expected: pass (parent still ignores the new checkpoint field).

- [ ] **Step 7:** Commit: `feat: child creates checkpoint in IPC mode, ships in interrupt message; guard against fork+propagation`

---

### Task 7: Parent uses `subprocessVotes.propagated`, returns `Interrupt[]` on propagation, tracks temp dirs

**Files:**
- Modify: `lib/runtime/ipc.ts` (`handleInterruptMessage`, `settle`, `RunSession`, new `settleWithPropagation`, new `leakedTempDirs` registry)

- [ ] **Step 1:** Add `propagated: boolean` to `RunSession`; initialize `false` in `_run`.

- [ ] **Step 2:** Modify `settle` to skip `cleanupTempDir` when `s.propagated` is true.

- [ ] **Step 3:** Add a module-level `leakedTempDirs: Set<string>` and a one-time `process.on("exit", () => { for (const d of leakedTempDirs) try { rmSync(d, { recursive: true }); } catch {} });` registration. When `settleWithPropagation` runs, add the dir to the set. Also add a `_cleanupResumeTempDir(compiledPath: string)` exported runtime helper users can call after handling propagation, which removes the dir AND drops it from the set.

- [ ] **Step 4:** Add helpers (declarative, single-purpose):
  ```ts
  function shouldPropagate(handlerResult: any, childPropagated: boolean): boolean {
    return childPropagated || hasInterrupts(handlerResult);
  }
  function buildDecision(handlerResult: any): IpcDecisionMessage {
    return isApproved(handlerResult)
      ? { type: "decision", approved: true, value: (handlerResult as any).value }
      : { type: "decision", approved: false, value: (handlerResult as any).value };
  }
  ```

- [ ] **Step 5:** Replace `handleInterruptMessage` body:
  ```ts
  const childPropagated = msg.subprocessVotes?.propagated === true;
  const { kind, message, data, origin } = msg.interrupt;
  try {
    const result = await interruptWithHandlers(kind, message, data, origin, s.ctx, s.stateStack);
    if (shouldPropagate(result, childPropagated)) {
      settleWithPropagation(s, msg);
      return;
    }
    trySendDecision(s, buildDecision(result));
  } catch (err) {
    trySendDecision(s, { type: "decision", approved: false, value: `Parent handler error: ${err instanceof Error ? err.message : String(err)}` });
  }
  ```

- [ ] **Step 6:** Implement `settleWithPropagation(s, msg)`:
  ```ts
  function settleWithPropagation(s: RunSession, msg: any): void {
    if (s.settled) return;
    s.propagated = true;
    leakedTempDirs.add(dirname(s.compiledPath));
    try { s.child.kill("SIGKILL"); } catch (_) { /* already gone */ }

    const { kind, message, data, origin } = msg.interrupt;
    const interruptObj = createInterrupt({
      kind, message, data, origin,
      runId: msg.runId,  // CHILD's runId (same as parent's, post Task 1) — NOT s.ctx.getRunId()
    });
    if (msg.checkpoint) interruptObj.checkpoint = msg.checkpoint;  // plain JSON; resume side reconstructs
    (interruptObj as any).compiledPath = msg.compiledPath;          // resume reads this in Task 3 step 2

    settle(s, s.resolvePromise, [interruptObj]);
  }
  ```

- [ ] **Step 7:** Build and run handler tests + a test that uses the propagation path. The propagation path is tested end-to-end in Task 8/9; for now just verify no regression on the approve/reject paths.

- [ ] **Step 8:** Commit: `feat: parent returns Interrupt[] on propagation; preserve temp dirs; cleanup-on-exit`

---

### Task 8: Integration test — propagation reaches the user (agency-js)

**Files:**
- Create: `tests/agency-js/subprocess-propagation/agent.agency`
- Create: `tests/agency-js/subprocess-propagation/test.js`
- Create: `tests/agency-js/subprocess-propagation/fixture.json`

Subprocess has `bash()` with a `propagate()` handler. Parent also `propagate()`s. Test asserts the user receives the interrupt with `kind: "std::bash"` and a checkpoint attached.

(Same body as the previous version of this task in the prior plan — see git history. Important to assert `interrupt.runId === <some shared id>` to verify Task 1 took effect, and `interrupt.compiledPath` is set so Task 3's resume path will work.)

- [ ] **Step 1–4:** as before. Commit: `test: subprocess interrupt propagates to user`

---

### Task 9: Integration test — full propagate → resume round-trip (agency-js)

This is the linchpin test: it exercises Stage 1 + Stage 2 together.

**Files:**
- Create: `tests/agency-js/subprocess-resume-roundtrip/agent.agency`
- Create: `tests/agency-js/subprocess-resume-roundtrip/test.js`
- Create: `tests/agency-js/subprocess-resume-roundtrip/fixture.json`

Subprocess hits `bash("echo resumed-ok")` with no handler → propagates. Parent has no handler → propagates to user. Test approves the propagated interrupt, calls `respondToInterrupts(interrupts, [approve()])`, expects the subprocess to resume in a fresh fork and return `"resumed-ok\n"`.

Pay attention to:
- The first `await main()` returns `Interrupt[]` for the `std::run` gate. Approve it. Parent calls `_run`. Child runs, propagates. Result is `Interrupt[]` for `std::bash`. Approve it. This goes back to the parent's `respondToInterrupts`, which re-enters the `run()` call site with `interrupts`+`responses` — that triggers the resume path in `_run`.
- The compiled module's `respondToInterrupts` in the parent must propagate the interrupts/responses through to the inner `run()` call. The Agency-level `run()` in `stdlib/agency.agency` already supports this from Task 3.
- In the `fixture.json`, assert the final result includes `"resumed-ok"`.

Debugging hints if it fails: `AGENCY_IPC_DEBUG=1` to trace messages. Check that the resume message has the right `scriptPath`, `runId`, and a properly reconstructable `checkpoint`.

- [ ] **Step 1–5:** Commit: `test: full propagate → resume round-trip`

---

### Task 10: Regression sweep + fork-guard test

- [ ] **Step 1:** Run all unit tests: `pnpm test:run`. Must pass.
- [ ] **Step 2:** Run all subprocess tests: `pnpm run a test tests/agency/subprocess`. Must pass.
- [ ] **Step 3:** Run all fork tests: `pnpm run a test tests/agency/fork`. Must pass — Task 5/6 changes are additive.
- [ ] **Step 4:** Add a new test that EXERCISES the fork-guard from Task 6 step 5 — a subprocess that runs `fork` with a propagating handler should fail with the clear error message, not crash or silently misbehave. Place at `tests/agency-js/subprocess-fork-guard/`.
- [ ] **Step 5:** Commit: `test: regression sweep + fork-in-subprocess guard`

---

### Task 11: Document everything

**Files:**
- Modify: `docs/dev/subprocess-ipc.md`

Sections to add/update:

1. **Resume protocol.** When `interrupts`+`responses` are passed to `run()`, parent sends `"resume"` instead of `"run"`. Bootstrap reconstructs each `interrupt.checkpoint` via `Checkpoint.fromJSON` then calls `respondToInterrupts`. `scriptPath` comes from `interrupt.compiledPath`, not the user's `compiled.path` argument.

2. **runId across processes.** Parent dictates `runId` at launch (passed in `RunInstruction` and `ResumeInstruction`). Child's interrupts inherit it. Propagated interrupts naturally carry the same id. Trace/log entries can be joined on runId.

3. **Handler propagation rules.** Unified chain: any reject → reject; any propagate → propagate to user; otherwise approve. Parent + child handler chains both consulted for every interrupt.

4. **Checkpoint in interrupt message.** Child creates a checkpoint at every IPC interrupt site (real `ctx.checkpoints.create` API; respects slice rule via local stack). Sent as JSON in `IpcInterruptMessage.checkpoint`. Parent attaches it to the propagated `Interrupt` and skips temp-dir cleanup. Resume reconstructs via `Checkpoint.fromJSON`.

5. **Temp dir lifecycle.** Cleaned up immediately on normal completion, abnormal exit, or limit-failure. Preserved on propagation. Tracked in a parent-process `Set` and best-effort `rmSync`'d on `process.exit`. Users can call `_cleanupResumeTempDir(path)` to remove explicitly.

6. **Multi-interrupt batching limitation (out of scope).** Add a section explaining:
   - Non-IPC concurrent-interrupt sites all flow through `runBatch` (`docs/dev/runBatch.md`). It lets every sibling run to completion, surfaces every halt into a single `Interrupt[]`, stamps one shared parent checkpoint, and overwrites each `intr.checkpoint`/`checkpointId` so resume routes one user response back to every batched branch.
   - In IPC mode each branch's `interruptWithHandlers` blocks on its own `sendInterruptToParent` IPC round-trip *inside the leaf*, so the runner never sees `Interrupt[]` to feed into `runBatch`'s collector.
   - Three failure modes if we ignored this: race-on-settle (`settleWithPropagation`'s `SIGKILL` tears down sibling branches mid-flight), wrong checkpoints (each leaf carries only its own slice; the shared parent checkpoint `runBatch` would stamp never gets built), parent-handler side effects fire N times instead of 1 (because each branch independently delivers its interrupt up the parent's IPC channel).
   - Current behavior: subprocess-side fork+propagation throws a clear runtime error (Task 6 Step 5).
   - Future fix sketch (per `runBatch.ts`'s "Subprocess-shape (future)" comment):
     1. Make `interruptWithHandlers` in IPC mode RETURN `Interrupt[]` instead of blocking. The interrupt carries everything the parent needs (kind, message, data, origin, checkpoint, runId, compiledPath).
     2. Let the runner's existing `runBatch`-based path collect those interrupts naturally — fork's `runForkAll`, race's `runRace`, parallel tool calls' `PromptRunner.parallel`, and multi-callback `Runner.hook` all become correct without further changes.
     3. Add a new `sendInterruptBatchToParent(interrupts: IpcInterruptMessage[])` IPC primitive that wraps the now-batched `Interrupt[]` into one message and awaits per-id `IpcDecisionMessage[]` from the parent.
     4. On the parent side, a new `handleInterruptBatchMessage` runs each child interrupt through the unified handler chain, builds a `decisions` array, and either propagates all-or-nothing (per the standard chain rules — any propagate ⇒ propagate, any reject ⇒ reject, else approve) or sends back the decisions array for the child to dispatch back into each waiting branch.
     5. The Task 6 Step 5 guard (`localStack !== ctx.stateStack`) becomes a single point to remove.

- [ ] Commit: `docs: subprocess resume, propagation, runId, temp lifecycle, fork limitation`

---

## Effort estimate (2026-05-23)

For someone already familiar with the runtime (subprocess IPC, checkpoints, interrupts, `runBatch`):

| Task | Estimated effort | Risk |
|---|---|---|
| 1. Parent dictates `runId` at subprocess launch | 1–2 hr | low — small additive change |
| 2. Bootstrap handles `"resume"` message + checkpoint reconstruction | 2–3 hr | low — mirrors the `handleRun` shape |
| 3. `_run` / `run()` accept `interrupts`/`responses`; resume uses `interrupt.compiledPath` | 2–3 hr | medium — touches stdlib and template; small probability of import-template churn |
| 4. Smoke test: empty `interrupts`/`responses` | 30 min | low |
| 5. Plumb `location` through `interruptWithHandlers` (no behavior change) | 2 hr | low — but wide unit-test sweep needed |
| 6. Create checkpoint in IPC mode + `AGENCY_COMPILED_PATH` env var + fork-guard | 3–4 hr | medium — the guard's `localStack !== ctx.stateStack` detector must be tested against all four `runBatch` adopters |
| 7. Parent returns `Interrupt[]` on propagation + temp-dir lifecycle | 3–4 hr | medium — process-exit cleanup is finicky; race-condition surface |
| 8. Integration test: propagation reaches user (agency-js) | 3–4 hr | medium — IPC + checkpoints + assertion plumbing |
| 9. Integration test: full propagate → resume round-trip | 4–6 hr | **high** — this is the linchpin; expect debugging |
| 10. Regression sweep + fork-guard test | 2–3 hr | low |
| 11. Documentation | 2 hr | low |
| **Total** | **~25–35 hr (3–5 working days)** | dominated by Task 9 |

**Schedule shape:**
- A focused engineer can plausibly land Tasks 1–7 in 2 days (most of the surgical code changes).
- Tasks 8–9 (integration tests) realistically eat a third day, sometimes two, because IPC + JSON serialization + checkpoint reconstruction has many fiddly failure modes that only surface end-to-end. Plan for `AGENCY_IPC_DEBUG=1` sessions.
- Task 10 + 11 cleanup is half a day.

**Risk multipliers:**
- The Task 5 `location` plumbing touches a runtime function and two mustache templates; a wide unit-test sweep is mandatory and may surface assertion failures in fixtures where empty-string `location` was previously the asserted shape. Budget extra time if so.
- The Task 6 Step 5 fork-guard must be verified against ALL `runBatch` adopters (fork, race, parallel tool calls, multi-callback hooks). The detector itself is correct, but missing a single test case could let a regression slip past.
- Task 7's process-exit temp-dir cleanup needs to play nice with `process.on("exit")` handler registration order; do this once, registered as part of `_run`'s first invocation, not per-session.
- The `runBatch`-aware "future fix" sketched in Task 6 / Task 11 is NOT part of this estimate. That extension is a separate ~3–5 day project once this plan ships.

**Suggested PR shape:** ship as ONE PR — tasks are too tightly coupled to split usefully (Tasks 5–7 build on each other; Task 9 needs the whole stack). If reviewer bandwidth is limited, split as "Stage 1: Tasks 1–4 (resume protocol, no propagation work)" + "Stage 2: Tasks 5–11" — Stage 1 ships a usable resume mechanism even without propagation.
