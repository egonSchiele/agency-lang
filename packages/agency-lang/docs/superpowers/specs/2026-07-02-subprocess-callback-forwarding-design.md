# Subprocess Callback Forwarding — Design

**Date:** 2026-07-02
**Status:** Design drafted; oversize-payload handling chosen by recommendation (owner review pending)
**Depends on:** subprocess pause/resume + nesting + log visibility (PR #398, merged); subprocess cost-guard telemetry (PR #404, merged) — the proven fire-and-forget template this mirrors

## Problem

A parent's registered lifecycle callbacks (`AgencyCallbacks` — `onToolCallStart`,
`onLLMCallEnd`, `onNodeStart`, `onAgentStart`, etc.) are blind to everything that
happens **inside a `std::agency run()` subprocess**. The child fires its own
callbacks locally, but a callback the *parent* registered never sees child events.
For a parent doing logging, metrics, or UI off these callbacks, the child is a
black box.

Log-viewer observability of child events (`agency logs`) is already handled
separately by statelog span forwarding (`withParentStatelog`, PR #398). This
design is specifically about the **programmatic `AgencyCallbacks` API**.

## Decisions locked (clarifying answers, carried from brainstorm)

- **Q1 — Motivation: PURE OBSERVATION.** Parent callbacks fire for child events
  (logging/metrics/UI). No callback needs to change what the child does ⇒
  **fire-and-forget**: the child emits upward and does not wait for the parent's
  callback. Mirrors the shipped cost-telemetry design exactly.
- **Q2 — Scope/fidelity: ALL OBSERVERS, FULL DATA.** Forward every callback that
  flows through the `invokeCallbacks` choke point, JSON-sanitizing each payload.
  Heavy fields (`messages: MessageJSON[]`, full `PromptResult`) forwarded as-is —
  same fidelity as in-process. Single choke point, **no per-callback allowlist**.
  (`onStream` is excluded because it bypasses `invokeCallbacks` — it is called
  directly; see `docs/misc/lifecycleHooks.md`.)
- **Q3 — Function fields: WIRE `onAgentStart.cancel` FOR REAL.** Of all
  function-valued callback fields, only `onAgentStart.cancel` is actually fired by
  the runtime. `onOAuthRequired.{complete,cancel}` is declared in the types but has
  no `callHook` site anywhere in `lib/` (reserved for the external MCP package) —
  moot for v1. Because the parent already owns the child session and its kill path,
  the parent-side `onAgentStart.cancel` is reconstructed as a real closure that
  kills the child + settles `run()` as cancelled — one-directional, no new channel,
  still fire-and-forget on the wire. Any OTHER future function field falls back to a
  **no-op stub**; true parent-*driven* interaction (the `complete`-style
  "child-parks-on-parent" case) is explicitly deferred to a **v2 "blocking
  callbacks"** follow-up.

## How callbacks work today (the facts the design builds on)

- **Single choke point**: every callback fires through
  `invokeCallbacks<K>({ ctx?, name, data, stateStack? })` in `lib/runtime/hooks.ts`
  (`hooks.ts:272`). `callHook` (`hooks.ts:295`) is a thin wrapper that omits
  `stateStack`. Every codegen-emitted hook site routes through one of these, so a
  single hook into `invokeCallbacks` sees every forwardable event by construction.
- `gatherCallbacks` (`hooks.ts:229`) collects, in order: stack-frame-scoped
  callbacks, top-level (module-init-registered) callbacks, then the TS-passed
  `ctx.callbacks[name]`. `invokeCallbacks` also fires `_globalHooks[name]`
  (external-package hooks) first. All callback bodies return `void`, cannot raise
  interrupts (typechecker-enforced), and a throwing body is caught + logged by
  `fireWithGuard` (except `AgencyAbort`/`RestoreSignal`, which propagate).
- **`CallbackMap`** (`hooks.ts:21`) is the full callback list + payload shapes. The
  only function-valued fields are `onAgentStart.cancel` and
  `onOAuthRequired.{complete,cancel}` (the latter never fired in `lib/`). `onStream`
  is data-only but bypasses the choke point.
- **`onAgentStart` fires in the child**: `subprocess-bootstrap.ts` `executeRun`
  runs the requested node via `runNode` (`node.ts`), which fires `onAgentStart`
  with `cancel = execCtx.cancel` (`node.ts` ~line 377).
- **Telemetry template to mirror** (all on `main`): `lib/runtime/costTelemetry.ts`
  (leaf, `sendCostTelemetryToParent`), `handleTelemetryMessage` in `ipc.ts:877`
  (synchronous), emission hoisted into `StateStack.billCharge`. Design spec:
  `docs/superpowers/specs/2026-07-02-subprocess-cost-telemetry-design.md`.
- **`RunSession`** (`ipc.ts:444`) carries `ctx: any` and `stateStack: any`
  alongside `resolvePromise`/`rejectPromise`/`settled`. `killChildSafely`
  (`ipc.ts:666`), `settle` (`ipc.ts:674`, idempotent), and `AgencyCancelledError`
  are all present.
- **`handleChildMessage`** (`ipc.ts:889`) is the child→parent dispatch. It
  defensively serializes every message and enforces `s.limits.ipcPayload`,
  calling `settleWithLimitFailure` (which **kills the run**) on overflow — see the
  oversize-payload section below.

## Design

### Emission: inside `invokeCallbacks`, once per event

`invokeCallbacks` gains one line at the top: when this process is a subprocess,
fire-and-forget the event upward before firing local callbacks.

```typescript
// hooks.ts, top of invokeCallbacks (before firing local/global callbacks)
sendCallbackToParent(name, data); // no-op unless isIpcMode(); strips functions
```

This is the single choke point every hook site already funnels through — every
present and future callback is covered by construction, no allowlist to maintain.
The child still fires its OWN callbacks locally as today; forwarding is purely
additive for the *parent's* callbacks.

**Nested relay is automatic**: the parent-side handler (below) fires the parent's
callbacks by re-entering `invokeCallbacks`; when that process is itself a
subprocess, the emit line re-forwards upward. A grandchild's event reaches the
root with zero explicit relay code — identical to the telemetry relay. The emit
sits at the *top* of `invokeCallbacks` so it fires even when a middle process has
no local callbacks registered (pure relay).

Rejected alternatives:
- **Per-site emission** — reintroduces the missed-site bug class; the whole point
  of the choke point is one covered path.
- **Per-callback allowlist** — rejected by Q2; the choke point already scopes
  exactly the forwardable set (`onStream` self-excludes by bypassing it).

### Leaf module (new): `lib/runtime/callbackForwarding.ts`

Dependency-light leaf, mirroring `costTelemetry.ts`. Only imports
`subprocessRunInfo.js` (never `ipc.ts` — same layering rule as
`costTelemetry.ts`/`subprocessRunInfo.ts`, because `hooks.ts` must not pull in
`ipc.ts`).

```typescript
import { isIpcMode } from "./subprocessRunInfo.js";
import type { CallbackMap } from "./hooks.js"; // type-only; no runtime cycle

export type IpcCallbackMessage = {
  type: "callback";
  name: keyof CallbackMap; // string on the wire
  data: any;               // JSON-sanitized payload (functions dropped)
};

/** The wire contract: a name the parent will actually dispatch. Shared by
 * sender and parent handler so both ends enforce the same rule (the parent
 * matters more — the child is the less-trusted party). Backed by a runtime
 * array of forwardable callback names derived from CallbackMap. */
export function isForwardableCallbackName(name: unknown): name is keyof CallbackMap { ... }

export function sendCallbackToParent(name: keyof CallbackMap, data: unknown): void {
  if (!isIpcMode() || typeof process.send !== "function") return;
  const safe = jsonSafe(data); // strips functions, tolerates circular/BigInt
  const msg: IpcCallbackMessage = { type: "callback", name, data: safe };
  // Oversize guard (see below): skip rather than risk killing the run.
  if (serializedByteLength(msg) > CALLBACK_PAYLOAD_LIMIT) {
    ipcDebug(`callback_dropped_oversize ${name}`);
    return;
  }
  try {
    process.send(msg);
  } catch (err) {
    // Channel gone — parent died; the watchdog will reap this process.
    // Swallowed (fire-and-forget), traceable under AGENCY_IPC_DEBUG.
    ipcDebug(`callback_send_failed ${name} ${detail(err)}`);
  }
}
```

`jsonSafe` drops function-valued fields (so `onAgentStart.cancel` never crosses the
wire) and tolerates circular refs / BigInt so a single un-serializable payload is
degraded, not thrown away wholesale. Node's default child-process IPC serialization
already drops functions and throws on circular refs; pre-sanitizing means we never
lose a whole event to a throw inside `process.send`.

### Wire: `IpcCallbackMessage` on `SubprocessToParent`

Add `IpcCallbackMessage` to the `SubprocessToParent` union (`ipc.ts:272`) and a
`"callback"` case to the `handleChildMessage` dispatch chain (`ipc.ts:889`).

### Parent-side handler: `handleCallbackMessage` (synchronous)

```typescript
// ipc.ts — MUST STAY SYNCHRONOUS, like handleTelemetryMessage (ipc.ts:877):
// handleChildMessage void-invokes its async dispatch, so FIFO arrival-order
// processing holds only while this path contains no awaits.
export function handleCallbackMessage(s: RunSession, msg: IpcCallbackMessage): void {
  if (s.settled) return;                          // drop post-settle events
  if (!isForwardableCallbackName(msg.name)) return; // child is less-trusted

  let data = msg.data;
  if (msg.name === "onAgentStart") {
    // Q3: reconstruct a REAL cancel that aborts the child.
    data = { ...data, cancel: (reason?: string) => {
      killChildSafely(s);
      settle(s, s.rejectPromise, new AgencyCancelledError(reason));
    }};
  }
  // Fire the parent's registered callbacks. RunSession carries ctx + stateStack,
  // so this gathers scoped + top-level + TS-passed callbacks. invokeCallbacks
  // re-emits upward when THIS process is itself a subprocess ⇒ automatic nested
  // relay. Fire-and-forget (void): a slow/throwing parent callback must not wedge
  // the IPC message pump.
  void invokeCallbacks({ ctx: s.ctx, name: msg.name, data, stateStack: s.stateStack });
}
```

Dispatch in `handleChildMessage`:

```typescript
} else if (msg.type === "callback") {
  handleCallbackMessage(s, msg);
}
```

### Oversize payload handling (chosen by recommendation; owner review pending)

`handleChildMessage` enforces `s.limits.ipcPayload` on **every** message and calls
`settleWithLimitFailure` — which **kills the run** — on overflow. Telemetry payloads
are tiny numbers, so this never bit. Callback payloads carry heavy fields
(`messages: MessageJSON[]`, full `PromptResult` on `onLLMCallEnd`/`onLLMCallStart`),
so a large LLM turn could trip the limit and **kill the child run merely because an
observer callback was registered** — violating the pure-observation invariant (Q1:
observation must never change what the child does).

**Decision: drop oversize, keep the run alive (belt-and-suspenders).**
- **Child side**: `sendCallbackToParent` skips sending when the serialized message
  exceeds `CALLBACK_PAYLOAD_LIMIT`, emitting an `AGENCY_IPC_DEBUG` trace
  (`callback_dropped_oversize`). The rare huge event is silently missed (but
  logged), never fatal.
- **Parent side**: the `ipcPayload` overflow path in `handleChildMessage` must NOT
  `settleWithLimitFailure` for `type === "callback"` — it drops that one event
  (with an `AGENCY_IPC_DEBUG` trace) and continues. This guarantees the invariant
  even if a child on an older/mismatched build sends an oversize callback message.

Rejected alternatives:
- **Slim payloads at the source** (strip `messages[]`/`PromptResult`, forward only
  summaries) — breaks Q2 (full-data fidelity) for every consumer to handle a rare
  case.
- **Exempt callbacks from the limit entirely** — removes backpressure for this
  message type; a pathological child could flood the parent with huge payloads.

`CALLBACK_PAYLOAD_LIMIT` should track `s.limits.ipcPayload`'s default so the child's
skip threshold and the parent's drop threshold agree.

## Properties

- **Additive**: child's local callbacks still fire; the parent's now also fire for
  child events. Parent and child registered different callback sets ⇒ no
  double-firing of the same callback.
- **Nested relay is automatic** via the parent re-entering `invokeCallbacks` when it
  is itself a subprocess (identical to telemetry).
- **Ordering**: fire-and-forget ⇒ the child does not wait for the parent's callback;
  parent-side observation may lag by IPC latency. Acceptable for observers (same
  tradeoff cost-telemetry accepted). The synchronous parent handler preserves FIFO
  processing among IPC messages.
- **Settle safety**: a `"callback"` message arriving after the session settled is
  dropped (`s.settled` guard). The reconstructed `cancel` relies on `settle`
  idempotency + `killChildSafely` (both already relied on by telemetry).
- **Never kills the run**: forwarding is observational; oversize/unserializable
  payloads are dropped+logged, never fatal.
- **`onStream` out of scope** (bypasses the choke point).
- **v2 deferred**: true parent-driven blocking callbacks (a child parking on a
  parent's async decision, the `onOAuthRequired.complete` shape) are a separate
  follow-up requiring a reply channel.

## Testing (mirror the telemetry tests)

**Unit** (`callbackForwarding.test.ts`, `ipc.test.ts`):
- sender no-ops outside IPC / without a channel; strips functions; drops+traces an
  oversize payload; `isForwardableCallbackName` rejects unknown names.
- `handleCallbackMessage` fires the parent's callbacks with the correct data;
  reconstructs a working `onAgentStart.cancel` that kills + settles; drops a
  post-settle callback message; drops an oversize callback message without settling.

**E2E** (`tests/agency-js/` and/or `tests/agency/subprocess/`):
- a parent that registers TS `onToolCallStart` / `onLLMCallEnd` / `onNodeStart`
  callbacks and runs a child sees the child's tool/LLM/node events. Child LLM cost
  driven via the deterministic client (mocks reach the child through the inherited
  `AGENCY_LLM_MOCKS` env var).
- a nested (grandchild) case proving relay to the root.
- a `cancel`-from-parent-callback case proving the child dies and `run()` settles
  cancelled.

**Docs**:
- `docs/misc/lifecycleHooks.md` — callbacks now fire for subprocess events.
- `docs/dev/subprocess-ipc.md` — new message + handler + relay; remove the
  callback-forwarding bullet from "Remaining limitations".
- `stdlib/agency.agency` `run()` docstring, if relevant.

## File anchors (verified against `main`, HEAD `1c229fc7`)

- Choke point: `lib/runtime/hooks.ts` — `invokeCallbacks` (`hooks.ts:272`),
  `callHook` (`hooks.ts:295`), `gatherCallbacks` (`hooks.ts:229`), `CallbackMap`
  (`hooks.ts:21`, `onAgentStart` at `:22`).
- Wire + dispatch: `lib/runtime/ipc.ts` — `SubprocessToParent` (`ipc.ts:272`),
  `handleChildMessage` (`ipc.ts:889`), `handleTelemetryMessage` (synchronous
  template, `ipc.ts:877`), `RunSession` (`ipc.ts:444`), `killChildSafely`
  (`ipc.ts:666`), `settle` (`ipc.ts:674`).
- Leaf template: `lib/runtime/costTelemetry.ts`. `isIpcMode` in
  `lib/runtime/subprocessRunInfo.ts`.
- `onAgentStart` firing: `lib/runtime/subprocess-bootstrap.ts` `executeRun`;
  `lib/runtime/node.ts` (~line 377, `cancel = execCtx.cancel`).

## Out of scope / follow-ups

- **v2 blocking callbacks**: parent-driven interaction where the child parks on a
  parent's decision (needs a reply channel; the `onOAuthRequired.complete` shape).
- `onStream` forwarding (bypasses the choke point by design).
- Housekeeping noted during brainstorm (not part of this feature): PR #403 should
  be **closed, not merged** (its branch predates #404 and merging would revert the
  cost-telemetry work); stale merged worktrees under `.claude/worktrees/` can be
  pruned.
