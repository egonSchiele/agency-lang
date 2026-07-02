# Subprocess Cost-Guard Telemetry — Design

**Date:** 2026-07-02
**Status:** Approved cadence (per-call, owner); getCost scope chosen by recommendation (owner review pending)
**Depends on:** subprocess pause/resume (PR #398, merged)

## Problem

A parent `guard(cost: $X) { run(...) }` is blind to subprocess spend: the
child compiles with its own empty guard stack, and the parent learns about
child LLM cost only from the terminal `result` message — after the money is
spent. With nesting unblocked, an agent-written child (or grandchild) can
make unbounded LLM calls outside every cost guard. The abort half already
works (a parent TimeGuard's abort kills the child via the composed signal →
SIGKILL path); this design closes the cost half.

## How cost accounting works today (the facts the design builds on)

- `CostGuard` owns a `spent` counter. Every paid site runs the same
  sequence: `stack.localCost += amount; stack.chargeGuards(amount);
  stack.enforceGuards()` — LLM calls (`lib/runtime/prompt.ts`), TS helpers
  via `addCost` (`lib/runtime/cost.ts`, e.g. image generation), and the
  memory subsystem. `chargeGuards` walks `stack.guards`, which includes
  shared REFERENCES to enclosing/parent-branch guards (real-time
  cross-branch accounting in one process).
- `enforceGuards()` throws a guard-trip abort carrying `guardId`. The
  abort-taxonomy contract (§4.1.1): a `try` boundary converts a trip ONLY
  if it owns the guard (`ownedGuardIds`); a plain `try` re-throws. The
  stdlib `run()`'s `return try _run(...)` is a plain try, so a trip thrown
  out of `_run` propagates to the user's owning `guard(cost:)` boundary and
  converts to the standard cost-limit Failure there. No new trip plumbing
  is needed.
- Guards serialize (`spent` in `toJSON`) — a paused parent's budget
  survives durable resume.

## Design

### Emission: inside `StateStack.chargeGuards`, per paid call

`chargeGuards(amount)` gains one line: after charging local guards, when
this process is a subprocess, fire-and-forget the amount upward. This is
the single choke point every paid site already funnels through — LLM,
`addCost`, memory, and any future site are covered by construction.

**Nested relay is automatic**: the parent-side telemetry handler charges
its own stack via `chargeGuards`, and when that process is itself a
subprocess, that call re-emits upward. Grandchild spend reaches the root
with zero explicit relay code.

Rejected alternatives:
- **Per-site emission** — reintroduces the missed-site bug class.
- **Shipping parent guards into the child** — unsound: in-process sharing
  works via references to ONE counter; a cross-process copy diverges (two
  children under one $1 guard would each get the full dollar).
- **Periodic batching** — rejected by owner; per-call is exact, and paid
  calls are seconds apart while a telemetry message costs microseconds.

### Wire

```typescript
// SubprocessToParent union gains:
export type IpcTelemetryMessage = {
  type: "telemetry";
  costUsd: number;
};
```

Sent by a new dependency-free leaf module `lib/runtime/costTelemetry.ts`
(the `subprocessRunInfo.ts` layering pattern — `stateStack.ts` must not
import `ipc.ts`):

```typescript
export function sendCostTelemetryToParent(costUsd: number): void {
  if (process.env.AGENCY_IPC !== "1" || typeof process.send !== "function") return;
  if (!(costUsd > 0)) return;
  try {
    process.send({ type: "telemetry", costUsd });
  } catch (_) {
    // Channel gone — the bootstrap disconnect watchdog is about to reap
    // this process anyway.
  }
}
```

Fire-and-forget: no reply, no listener, never parks the child. IPC channel
FIFO ordering guarantees every telemetry message lands before the child's
own terminal message, so no spend goes missing at settle.

### Parent-side handler (`ipc.ts`)

New `handleChildMessage` case:

```typescript
function handleTelemetryMessage(s: RunSession, msg: IpcTelemetryMessage): void {
  const cost = typeof msg.costUsd === "number" && msg.costUsd > 0 ? msg.costUsd : 0;
  if (cost === 0) return;
  // Charge unconditionally — the spend already happened, even if the
  // session has settled (e.g. a queued message after a kill). The same
  // sequence every in-process paid site runs; chargeGuards re-emits
  // upward when this process is itself a subprocess (nested relay).
  s.stateStack.localCost += cost;
  s.stateStack.chargeGuards(cost);
  if (s.settled) return;
  try {
    s.stateStack.enforceGuards();
  } catch (err) {
    // A parent cost guard tripped on child spend: kill the child and
    // REJECT the session with the trip. The rejection propagates through
    // invokeSubprocess → runBatch (errors win over interrupts) → the
    // stdlib run()'s plain `try` re-throws guard trips → the user's
    // owning guard(cost:) boundary converts it to the cost-limit Failure.
    try { s.child.kill("SIGKILL"); } catch (killErr) { ipcLog("send", { type: "kill_failed", detail: String(killErr) }); }
    settle(s, s.rejectPromise, err);
  }
}
```

`s.stateStack` is the `run()` call-site slice, whose `guards` array already
holds references to every enclosing guard — including guards inherited
through fork branches — so multi-child and in-fork compositions charge the
right shared counters.

### Semantics and properties

- **getCost() scope (owner review pending — recommended option chosen):**
  telemetry updates `localCost` alongside the guard charge, so parent
  `getCost()` reflects subprocess spend live. Nothing folds child cost into
  parent accumulators at terminal today, so there is no double-count.
  **Tokens are a non-goal**: guards are cost-based, `getTokens()` keeps its
  in-process meaning, and cumulative child tokens already arrive terminally
  via `result.tokens`.
- **No double-charging across pause/resume**: charges are per-call
  incremental, and a resumed child's replay skips completed LLM steps, so
  nothing re-emits. Parent guard `spent` serializes into parent
  checkpoints, so budgets survive durable pauses (a resumed run continues
  from the spent-so-far, not a fresh budget).
- **Detection latency is at most one paid call**: the pre-call
  `enforceGuards()` gate inside the CHILD does not know about parent
  guards, so the child can start one more call after the budget is
  exhausted; the parent trips on that call's telemetry and kills. This
  mirrors the in-process CostGuard behavior (no mid-flight cancellation of
  sibling calls; the post-call check is authoritative).
- **Trip kills; it does not pause.** A busy child cannot be checkpointed on
  demand (the same constraint that shaped the pause design), so
  raise-the-budget-and-resume is not possible: `run()` returns the
  cost-limit Failure and partial child work is lost. Possible future
  refinement: a "pause at the next interrupt-safe point" instruction.
- The `interrupted` pause path is unaffected: a paused child has already
  reported all its spend (FIFO), holds no budget, and its resume segment
  reports fresh spend as it happens.

### Testing

Unit (`ipc.test.ts`, `costTelemetry.test.ts`):
- Sender no-ops outside IPC mode / without a channel / for zero cost.
- Handler charges localCost + guards; trips settle-with-rejection and kill;
  post-settle telemetry charges but does not enforce.
- `chargeGuards` emits exactly once per charge (spy on the leaf sender).

E2E (agency execution + agency-js). Child spend is driven through the
deterministic LLM client with cost injection — extend `DeterministicClient`
to carry `cost.totalCost` (and usage) in mocked completions if it does not
already (verify at plan time); mocks reach the child via the inherited
`AGENCY_LLM_MOCKS` env var:
1. `guard(cost: $X) { run(child-that-overspends) }` → the block yields the
   standard cost-limit Failure; the child process is dead (no orphaned
   work after the trip).
2. Under-budget child → run succeeds AND parent `getCost()` includes the
   child's spend.
3. Nested: grandchild spend trips the ROOT guard through the automatic
   relay.
4. Two concurrent subprocesses under one guard share the single budget
   (the shape the ship-guards-into-child alternative would get wrong).

### Docs

- `docs/site/guide/guards.md`: cost guards now cover subprocess spend.
- `docs/dev/subprocess-ipc.md`: telemetry message, handler, relay; remove
  the cost-guard bullet from Remaining limitations.
- `stdlib/agency.agency` `run()` docstring: note that enclosing cost
  guards meter the subprocess.

## Out of scope

- Live token mirroring into parent `getTokens()`.
- Global `__tokenStats` /cost-style roll-up of child spend (terminal
  `result.tokens` already exists).
- Trip-to-pause (checkpoint on guard trip) — requires on-demand
  checkpointing of a busy child.
- Callback forwarding and the `agency resume` CLI (separate follow-ups).
