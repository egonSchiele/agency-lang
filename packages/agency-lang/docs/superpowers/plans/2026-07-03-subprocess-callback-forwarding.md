# Subprocess Callback Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. NOTE: this repo forbids subagent-driven implementation — execute INLINE via superpowers:executing-plans in a fresh worktree off `origin/main`.

**Goal:** Forward a subprocess's lifecycle callbacks to its parent over IPC so a parent's registered `AgencyCallbacks` fire for events that happen inside a `std::agency run()` child.

**Architecture:** Fire-and-forget child→parent IPC, mirroring the shipped cost-telemetry design (PR #404). A single choke point (`invokeCallbacks` in `hooks.ts`) emits every event upward via a dependency-light leaf module; the parent re-fires its own registered callbacks by re-entering `invokeCallbacks`, which makes nested (grandchild) relay automatic. Callbacks are purely observational and never kill the run; the sole flow-affecting capability is `onAgentStart.cancel`, reconstructed parent-side to mirror in-process fidelity.

**Tech Stack:** TypeScript (Node `child_process` IPC via `process.send`), vitest for unit tests, Agency `.agency`/`.test.json` execution tests.

## Scope & design tradeoffs

**Every forwarded event is serialized and sent on every occurrence — even when the parent registered NO matching callback.** The child cannot know which callbacks (if any) its parent registered, so `invokeCallbacks` forwards unconditionally. This mirrors the cost-telemetry design (PR #404), but the payloads are heavier: `onLLMCallStart`/`onLLMCallEnd`/`onThreadEnd` carry full `messages` arrays, `onAgentEnd` carries the full run result, and `onEmit`/`onNodeEnd` carry arbitrary user data — each `JSON.stringify`'d in the child's hot path. For an LLM-heavy child this is real per-event CPU + IPC bandwidth. **This is an accepted tradeoff for v1** (observational fidelity over efficiency). If it proves costly, the future mitigation — out of scope here — is for the parent to send the set of callback names it registered at fork time (one-shot via `buildForkOptions`/`SubprocessRunInfo`) and gate `sendCallbackToParent` on that set, so a child with no interested ancestor forwards nothing.

**Three callbacks are deliberately NOT forwarded.** A hard denylist in `sendCallbackToParent` (Task 1) enforces this so a future refactor that routes one of them through `invokeCallbacks` cannot silently start forwarding a broken payload:

| Callback | Why excluded today | What inclusion would take |
| --- | --- | --- |
| `onStream` | Dispatched directly at the `handleStreamingResponse` call site (`streaming.ts`), NOT through `invokeCallbacks`, so it never reaches the choke point. The child also only enters the streaming branch when the CHILD itself has an `onStream` callback — otherwise it drains the stream synchronously and emits nothing. | An explicit forward at the `streaming.ts` call site (data is function-free — no reconstruction needed), PLUS a mechanism for the child to stream even without a local callback (it must learn the parent wants streaming), PLUS accepting per-chunk IPC volume. Moderate. |
| `onTrace` | Declared in `CallbackMap`/`VALID_CALLBACK_NAMES` but currently never dispatched anywhere — nothing fires it, so nothing forwards. (Function-free, so NOT in the correctness denylist; excluded only by non-existence.) | If ever wired to fire through `invokeCallbacks`, it forwards automatically with no new code — but must be deduped against the existing statelog span forwarding (`parentSpanId` adoption) and its `TraceEvent` payload size/frequency reviewed. Low, if routed through the choke point. |
| `onOAuthRequired` | Declared but currently never dispatched. Also carries `complete: Promise<void>` + `cancel: () => void`: the child AWAITS `complete` while the parent drives an interactive OAuth flow — a live bidirectional dependency that fire-and-forget cannot satisfy (a stripped `complete` would leave the child awaiting forever). | A request/response IPC round-trip (like the existing interrupt/decision and lock-grant channels), not this one-way design. Large; separate effort. |

## Global Constraints

- Leaf module `callbackForwarding.ts` MUST NOT import `ipc.ts` (layering rule — `hooks.ts` imports the leaf, and `hooks.ts`/`stateStack.ts` must never pull in `ipc.ts`). Its only runtime import is `subprocessRunInfo.js`.
- `handleCallbackMessage` MUST be synchronous (no `await`) — `handleChildMessage` void-invokes its async dispatch, so IPC FIFO ordering holds only while the path has no awaits. Fire parent callbacks as `void invokeCallbacks(...)`.
- Forwarding is PURELY OBSERVATIONAL and MUST NEVER kill the run: a dead channel, oversize, or unserializable payload is dropped/swallowed, never fatal.
- `sendCallbackToParent` MUST enforce a non-forwardable denylist (`onStream`, `onOAuthRequired`) so a future refactor that routes them through `invokeCallbacks` cannot forward a payload with silently-stripped functions/Promises. See **Scope & design tradeoffs**. (`onTrace` is function-free and simply never fires today, so it is not in the denylist.)
- Forwarding is UNCONDITIONAL and payloads can be large — an accepted v1 tradeoff, documented in **Scope & design tradeoffs**. Do not add listener-negotiation gating in this plan.
- Fire-and-forget: the child never waits for the parent's callback; no reply channel.
- Code style: NO dynamic imports; use objects not Maps; arrays not Sets; types not interfaces.
- Git: never force-push/amend. Commit messages use `-m` with NO apostrophes (apostrophes on the command line fail in this repo); add the trailer via a second `-m`.
- Testing: save test output to a file. Do NOT run the full agency suite — run only the specific tests named here.
- Run `make` before the Agency execution (E2E) tests: the subprocess child is forked from the built runtime.

---

## File Structure

- **Create** `lib/runtime/callbackForwarding.ts` — leaf module: `IpcCallbackMessage` wire type, `CALLBACK_PAYLOAD_LIMIT`, `NON_FORWARDABLE_CALLBACKS`, `sendCallbackToParent`. Child-side emission only.
- **Create** `lib/runtime/callbackForwarding.test.ts` — unit tests for the sender.
- **Modify** `lib/runtime/subprocessRunInfo.ts` — add the shared `ipcChildDebug` helper (dependency-free leaf, used by both callback + cost leaves).
- **Modify** `lib/runtime/costTelemetry.ts` — use the shared `ipcChildDebug` instead of its inline stderr block (pure refactor, keeps the two leaves consistent).
- **Modify** `lib/runtime/hooks.ts` — one emit line at the top of `invokeCallbacks` + one import.
- **Modify** `lib/runtime/hooks.test.ts` — one test proving `invokeCallbacks` forwards in IPC mode.
- **Modify** `lib/runtime/ipc.ts` — add `IpcCallbackMessage` to the `SubprocessToParent` union; add `handleCallbackMessage` + `isForwardableCallbackName`; add a `"callback"` dispatch case; make oversize/unserializable `"callback"` messages drop (not kill) in `handleChildMessage`; export `handleChildMessage` for tests.
- **Modify** `lib/runtime/ipc.test.ts` — unit tests for `handleCallbackMessage` and the oversize-drop path.
- **Create** `tests/agency/subprocess/callback-forwarding-child-events.agency` + `.test.json` — parent callback fires for a child event.
- **Create** `tests/agency/subprocess/callback-forwarding-nested-relay.agency` + `.test.json` — parent callback fires for a grandchild event (relay through a guardless mid-tier).
- **Modify** `docs/misc/lifecycleHooks.md` and `docs/dev/subprocess-ipc.md` — document forwarding + remove the "callback forwarding" limitation bullet.

Note on the cancel path: `AgencyCancelledError extends AgencyAbort`, so a parent-triggered `onAgentStart.cancel` propagates through `run()` as an abort (the stdlib `run()` plain-`try` re-throws it), which has no clean deterministic Agency output string. It is therefore covered by a rigorous UNIT test (Task 3), not an E2E test.

---

### Task 1: Leaf module — child-side sender

**Files:**
- Create: `lib/runtime/callbackForwarding.ts`
- Test: `lib/runtime/callbackForwarding.test.ts`

**Interfaces:**
- Consumes: `isIpcMode` from `lib/runtime/subprocessRunInfo.js`; `CallbackName` (type) from `lib/types/function.js`.
- Produces:
  - `type IpcCallbackMessage = { type: "callback"; name: CallbackName; data: any }`
  - `const CALLBACK_PAYLOAD_LIMIT: number` (= `1024 * 1024 * 1024`)
  - `function sendCallbackToParent(name: CallbackName, data: unknown, maxBytes?: number): void`

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/callbackForwarding.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { sendCallbackToParent } from "./callbackForwarding.js";

// process.send has no vi.stubEnv equivalent — save/restore it manually.
// A leaked AGENCY_IPC=1 would make later tests emit unexpectedly.
const originalSend = process.send;

afterEach(() => {
  process.send = originalSend;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendCallbackToParent", () => {
  it("sends a callback message when in IPC mode", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const sent: any[] = [];
    process.send = ((m: any) => { sent.push(m); return true; }) as any;
    sendCallbackToParent("onNodeStart", { nodeName: "n" });
    expect(sent).toEqual([{ type: "callback", name: "onNodeStart", data: { nodeName: "n" } }]);
  });

  it("no-ops outside IPC mode", () => {
    const send = vi.fn(() => true);
    process.send = send as any;
    sendCallbackToParent("onNodeStart", { nodeName: "n" });
    expect(send).not.toHaveBeenCalled();
  });

  it("no-ops when process.send is unavailable", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    (process as any).send = undefined;
    expect(() => sendCallbackToParent("onNodeStart", { nodeName: "n" })).not.toThrow();
  });

  it("strips function-valued fields (e.g. onAgentStart.cancel)", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const sent: any[] = [];
    process.send = ((m: any) => { sent.push(m); return true; }) as any;
    sendCallbackToParent("onAgentStart", { nodeName: "n", args: {}, messages: [], cancel: () => {} });
    expect(sent).toEqual([
      { type: "callback", name: "onAgentStart", data: { nodeName: "n", args: {}, messages: [] } },
    ]);
  });

  it("drops an oversize payload instead of sending", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    sendCallbackToParent("onNodeStart", { nodeName: "x".repeat(100) }, 10);
    expect(send).not.toHaveBeenCalled();
  });

  it("drops an unserializable payload instead of throwing", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    const circular: any = {};
    circular.self = circular;
    expect(() => sendCallbackToParent("onNodeStart", circular)).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows a dead-channel send error", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    process.send = vi.fn(() => { throw new Error("channel closed"); }) as any;
    expect(() => sendCallbackToParent("onNodeStart", { nodeName: "n" })).not.toThrow();
  });

  it("does not forward a denylisted callback (onStream)", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    sendCallbackToParent("onStream", { type: "text", text: "hi" } as any);
    sendCallbackToParent("onOAuthRequired", { serverName: "s", authUrl: "u" } as any);
    expect(send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/callbackForwarding.test.ts 2>&1 | tee /tmp/cbf-1.log`
Expected: FAIL — cannot resolve `./callbackForwarding.js` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

First, hoist the child-debug logger into the shared dependency-free leaf so both
this module and `costTelemetry.ts` use ONE implementation (today `costTelemetry.ts`
inlines the same `[ipc:child] …` stderr block — an inconsistency between the two
sibling leaves). In `lib/runtime/subprocessRunInfo.ts`, add:

```typescript
/** Emit one child-side IPC debug line to stderr, gated on AGENCY_IPC_DEBUG=1.
 * Lives here (the dependency-free leaf) so both callbackForwarding.ts and
 * costTelemetry.ts share one implementation; ipcLog (ipc.ts) is unreachable from
 * these leaves without violating the layering rule. */
export function ipcChildDebug(line: string): void {
  if (process.env.AGENCY_IPC_DEBUG !== "1") return;
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[ipc:child] ${ts} ${line}\n`);
}
```

Then refactor `costTelemetry.ts` to import and use it, replacing its inline
`if (process.env.AGENCY_IPC_DEBUG === "1") { … process.stderr.write(…) }` block
with `ipcChildDebug("send telemetry_send_failed " + detail)` (same output; the
`import { isIpcMode } from "./subprocessRunInfo.js"` there becomes
`import { isIpcMode, ipcChildDebug } from "./subprocessRunInfo.js"`). This keeps
the two leaves consistent and is a pure refactor — `costTelemetry.test.ts` stays
green.

Now create `lib/runtime/callbackForwarding.ts`:

```typescript
/**
 * Fire-and-forget forwarding of lifecycle callbacks from a subprocess to its
 * parent, so a parent's registered AgencyCallbacks fire for events that happen
 * inside a std::agency run() child (see
 * docs/superpowers/specs/2026-07-02-subprocess-callback-forwarding-design.md).
 *
 * Dependency-light leaf (mirrors costTelemetry.ts): the only runtime import is
 * subprocessRunInfo.ts (for isIpcMode + the shared ipcChildDebug). invokeCallbacks
 * (hooks.ts) calls sendCallbackToParent on every event; hooks.ts must not import
 * ipc.ts, so the wire type + sender live here.
 *
 * Never blocks, never throws, and never kills the run: no reply, no listener; a
 * dead channel or an over-limit / unserializable payload is swallowed — the
 * event is observational, so dropping it is always safe.
 *
 * Forwarding is UNCONDITIONAL: the child cannot know which callbacks the parent
 * registered, so every event (except the NON_FORWARDABLE_CALLBACKS denylist) is
 * serialized and sent on every occurrence, even when no parent callback exists.
 * Payloads can be large (full messages arrays, run results). Accepted v1
 * tradeoff — see the plan's "Scope & design tradeoffs".
 */

import { isIpcMode, ipcChildDebug } from "./subprocessRunInfo.js";
import type { CallbackName } from "../types/function.js";

export type IpcCallbackMessage = {
  type: "callback";
  name: CallbackName;
  // JSON-sanitized payload; function fields (e.g. onAgentStart.cancel) dropped.
  data: any;
};

/** Skip threshold for a forwarded callback payload. Matches the default
 * ipcPayload limit (ipc.ts DEFAULT_LIMITS) so the child's skip and the parent's
 * drop agree. Purely defensive: real callback payloads are KB-MB, far under it. */
export const CALLBACK_PAYLOAD_LIMIT = 1024 * 1024 * 1024; // 1gb

/** Callbacks that MUST NOT be forwarded. onStream and onOAuthRequired carry
 * function / Promise fields (cancel, complete) whose semantics require a live
 * local channel; JSON forwarding would strip them and fire a broken callback in
 * the parent. Neither currently reaches this function (onStream dispatches
 * outside invokeCallbacks; onOAuthRequired is never fired), so this is a
 * defensive guard against a future refactor routing them through the choke
 * point. onTrace is function-free and simply never fires today, so it is
 * excluded by non-existence rather than listed here. See the plan's
 * "Scope & design tradeoffs" section. */
const NON_FORWARDABLE_CALLBACKS: readonly CallbackName[] = ["onStream", "onOAuthRequired"];

/** Forward one lifecycle event to the parent. No-op unless this process is a
 * forked Agency subprocess with a live IPC channel. `maxBytes` is overridable
 * only so tests can exercise the oversize-skip without a gigabyte payload. */
export function sendCallbackToParent(
  name: CallbackName,
  data: unknown,
  maxBytes: number = CALLBACK_PAYLOAD_LIMIT,
): void {
  if (!isIpcMode() || typeof process.send !== "function") return;
  if (NON_FORWARDABLE_CALLBACKS.includes(name)) return; // functions/Promises can't survive JSON
  // JSON.stringify drops function-valued fields (e.g. onAgentStart.cancel) and
  // throws on circular refs / BigInt. Serialize ONCE up front so an
  // un-serializable payload degrades to a dropped event instead of a throw
  // inside process.send, and so what we measure equals what we send.
  let serialized: string;
  try {
    serialized = JSON.stringify({ type: "callback", name, data });
  } catch (err) {
    ipcChildDebug(`callback_unserializable ${name} ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    ipcChildDebug(`callback_dropped_oversize ${name}`);
    return;
  }
  try {
    // Re-parse so the sent object is guaranteed function-free regardless of the
    // channel's serialization mode.
    process.send(JSON.parse(serialized) as IpcCallbackMessage);
  } catch (err) {
    // Channel gone — parent died; the watchdog will reap this process.
    ipcChildDebug(`callback_send_failed ${name} ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/callbackForwarding.test.ts 2>&1 | tee /tmp/cbf-1.log`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/callbackForwarding.ts lib/runtime/callbackForwarding.test.ts lib/runtime/subprocessRunInfo.ts lib/runtime/costTelemetry.ts
git commit -m "Add callbackForwarding leaf: child-side sendCallbackToParent" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Emit forwarded events from the choke point

**Files:**
- Modify: `lib/runtime/hooks.ts` — import + one line at the top of `invokeCallbacks` (function starts at `hooks.ts:272`).
- Test: `lib/runtime/hooks.test.ts`

**Interfaces:**
- Consumes: `sendCallbackToParent` from Task 1.
- Produces: no new exports — `invokeCallbacks` now forwards every event when `isIpcMode()`.

- [ ] **Step 1: Write the failing test**

Add to `lib/runtime/hooks.test.ts` (add `import { StateStack } from "./state/stateStack.js";` at the top if not already present):

```typescript
import { invokeCallbacks } from "./hooks.js";
// (StateStack import as noted above)

describe("invokeCallbacks subprocess forwarding", () => {
  const originalSend = process.send;
  afterEach(() => {
    process.send = originalSend;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("forwards the event to the parent when in IPC mode", async () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const sent: any[] = [];
    process.send = ((m: any) => { sent.push(m); return true; }) as any;
    const ctx: any = { callbacks: {}, topLevelCallbacks: [], stateStack: new StateStack() };
    await invokeCallbacks({ ctx, name: "onNodeStart", data: { nodeName: "x" }, stateStack: ctx.stateStack });
    expect(sent).toEqual([{ type: "callback", name: "onNodeStart", data: { nodeName: "x" } }]);
  });

  it("does not forward outside IPC mode", async () => {
    const send = vi.fn(() => true);
    process.send = send as any;
    const ctx: any = { callbacks: {}, topLevelCallbacks: [], stateStack: new StateStack() };
    await invokeCallbacks({ ctx, name: "onNodeStart", data: { nodeName: "x" }, stateStack: ctx.stateStack });
    expect(send).not.toHaveBeenCalled();
  });

  it("forwarding is ADDITIVE: the local callback still fires in IPC mode", async () => {
    // Guards the "purely additive" invariant: the emit line must not replace or
    // short-circuit the existing local callback firing. A registered callback
    // must BOTH fire locally AND be forwarded.
    vi.stubEnv("AGENCY_IPC", "1");
    const sent: any[] = [];
    process.send = ((m: any) => { sent.push(m); return true; }) as any;
    const fired: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: { onNodeStart: (d: any) => fired.push(d) }, topLevelCallbacks: [], stateStack: stack };
    await invokeCallbacks({ ctx, name: "onNodeStart", data: { nodeName: "x" }, stateStack: stack });
    expect(fired).toEqual([{ nodeName: "x" }]); // local callback still fired
    expect(sent).toEqual([{ type: "callback", name: "onNodeStart", data: { nodeName: "x" } }]); // and forwarded
  });
});
```

Note: `vi` and `afterEach`/`describe`/`it`/`expect` are already imported in `hooks.test.ts`; only add the `invokeCallbacks` and `StateStack` imports if missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/hooks.test.ts 2>&1 | tee /tmp/cbf-2.log`
Expected: FAIL — the "forwards the event" test fails (`sent` is empty) because `invokeCallbacks` does not emit yet.

- [ ] **Step 3: Write minimal implementation**

In `lib/runtime/hooks.ts`, add the import next to the other runtime imports (near `hooks.ts:13-15`):

```typescript
import { sendCallbackToParent } from "./callbackForwarding.js";
```

Then, at the very top of the `invokeCallbacks` body (right after the destructuring `const { name, data, stateStack } = args;` at `hooks.ts:278`), add:

```typescript
  // Forward every event to the parent when running inside a std::agency run()
  // subprocess, so the parent's registered callbacks fire for child events
  // (fire-and-forget; strips functions; no-op outside IPC). Purely additive: the
  // child still fires its own callbacks below. When THIS process is itself a
  // subprocess, this re-forwards relayed events upward -> automatic nested relay.
  sendCallbackToParent(name, data);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/hooks.test.ts 2>&1 | tee /tmp/cbf-2.log`
Expected: PASS (all existing hooks tests plus the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/hooks.ts lib/runtime/hooks.test.ts
git commit -m "Forward lifecycle events to parent from invokeCallbacks choke point" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Parent-side wire + handler

**Files:**
- Modify: `lib/runtime/ipc.ts` — imports; add `IpcCallbackMessage` to the `SubprocessToParent` union (`ipc.ts:272-279`); add `isForwardableCallbackName` + `handleCallbackMessage`; add a `"callback"` dispatch case in `handleChildMessage` (`ipc.ts:907-921`).
- Test: `lib/runtime/ipc.test.ts`

**Interfaces:**
- Consumes: `IpcCallbackMessage` (Task 1); `invokeCallbacks` (Task 2 / `hooks.ts`); `VALID_CALLBACK_NAMES` + `CallbackName` from `lib/types/function.js`; existing `RunSession`, `killChildSafely`, `settle`, `AgencyCancelledError` in `ipc.ts`.
- Produces: `export function handleCallbackMessage(s: RunSession, msg: IpcCallbackMessage): void`.

- [ ] **Step 1: Write the failing test**

Add to `lib/runtime/ipc.test.ts`. Ensure the top-of-file imports include `handleCallbackMessage` (alongside the existing `handleTelemetryMessage`), `StateStack` (already imported), and add `import { AgencyCancelledError } from "./errors.js";`:

```typescript
const flush = () => new Promise((r) => setImmediate(r));

describe("handleCallbackMessage", () => {
  it("fires the parent's registered callback with the forwarded data", async () => {
    const fired: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: { onNodeStart: (d: any) => fired.push(d) }, topLevelCallbacks: [], stateStack: stack };
    const session = makeSession({ ctx, stateStack: stack, limits: { wallClock: 1000, memory: 1, ipcPayload: 1e9, stdout: 1 } });

    handleCallbackMessage(session, { type: "callback", name: "onNodeStart", data: { nodeName: "childNode" } });
    await flush();

    expect(fired).toEqual([{ nodeName: "childNode" }]);
  });

  it("ignores an unknown callback name (child is less-trusted)", async () => {
    // Register the handler UNDER the bogus name. gatherCallbacks reads
    // ctx.callbacks[name] dynamically, so WITHOUT the isForwardableCallbackName
    // guard this would fire. This makes the test actually discriminate the guard
    // (registering it under a valid name would pass either way — false confidence).
    const fired: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: { onBogus: (d: any) => fired.push(d) }, topLevelCallbacks: [], stateStack: stack };
    const session = makeSession({ ctx, stateStack: stack });

    handleCallbackMessage(session, { type: "callback", name: "onBogus" as any, data: { x: 1 } });
    await flush();

    expect(fired).toEqual([]);
  });

  it("drops a callback that arrives after the session settled", async () => {
    const fired: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: { onNodeStart: (d: any) => fired.push(d) }, topLevelCallbacks: [], stateStack: stack };
    const session = makeSession({ ctx, stateStack: stack, settled: true });

    handleCallbackMessage(session, { type: "callback", name: "onNodeStart", data: { nodeName: "late" } });
    await flush();

    expect(fired).toEqual([]);
  });

  it("reconstructs onAgentStart.cancel to kill the child and settle cancelled", async () => {
    const kills: string[] = [];
    const rejections: any[] = [];
    const stack = new StateStack();
    const ctx: any = {
      callbacks: { onAgentStart: (d: any) => d.cancel("parent said stop") },
      topLevelCallbacks: [],
      stateStack: stack,
    };
    const session = makeSession({
      ctx,
      stateStack: stack,
      child: { kill: (sig: string) => { kills.push(sig); return true; }, connected: true },
      rejectPromise: (err: any) => { rejections.push(err); },
    });

    handleCallbackMessage(session, {
      type: "callback",
      name: "onAgentStart",
      data: { nodeName: "childToCancel", args: {}, messages: [] },
    });
    await flush();

    expect(kills).toEqual(["SIGKILL"]);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toBeInstanceOf(AgencyCancelledError);
    expect(session.settled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/ipc.test.ts 2>&1 | tee /tmp/cbf-3.log`
Expected: FAIL — `handleCallbackMessage` is not exported (import error).

- [ ] **Step 3: Write minimal implementation**

In `lib/runtime/ipc.ts`:

(a) Add imports near the existing ones (the `costTelemetry` import is at `ipc.ts:21`; `AgencyCancelledError` at `ipc.ts:18`):

```typescript
import { type IpcCallbackMessage } from "./callbackForwarding.js";
import { invokeCallbacks } from "./hooks.js";
import { VALID_CALLBACK_NAMES, type CallbackName } from "../types/function.js";
```

Note: `import { invokeCallbacks } from "./hooks.js"` adds a NEW `ipc.ts → hooks.ts` import edge (neither imports the other on `main` today). `hooks.ts` does NOT import `ipc.ts` — it forwards via the `callbackForwarding.ts` leaf, precisely to keep this acyclic — so there is no cycle. After this step, run `make` and `pnpm run lint:structure` to confirm no transitive `ipc → hooks → … → ipc` cycle was introduced.

(b) Add `IpcCallbackMessage` to the `SubprocessToParent` union (`ipc.ts:272-279`):

```typescript
export type SubprocessToParent =
  | IpcInterruptMessage
  | IpcResultMessage
  | IpcInterruptedMessage
  | IpcErrorMessage
  | IpcLockAcquireMessage
  | IpcLockReleaseMessage
  | IpcTelemetryMessage
  | IpcCallbackMessage;
```

(c) Add the handler + validator immediately after `handleTelemetryMessage` (ends at `ipc.ts:887`):

```typescript
function isForwardableCallbackName(name: unknown): name is CallbackName {
  return typeof name === "string" && (VALID_CALLBACK_NAMES as readonly string[]).includes(name);
}

/**
 * Give a forwarded onAgentStart payload a REAL parent-owned cancel().
 *
 * The child's own cancel function was stripped by JSON. The parent owns the
 * child session, so a parent onAgentStart callback that calls cancel() kills the
 * child (SIGKILL) and settles run() as cancelled.
 *
 * BEST-EFFORT and ASYNC — NOT the in-process semantic. In-process, cancel()
 * throws synchronously and PREVENTS the agent from running. Here the child fires
 * onAgentStart and proceeds without back-pressure (fire-and-forget), so the
 * parent's cancel arrives later and kills a child that may already be mid-run or
 * finished. If the child's terminal result wins the race, settle()'s `s.settled`
 * guard makes the cancel a silent no-op. Killing the child is the closest
 * approximation this one-way channel allows.
 *
 * The `typeof data === object` guard is defensive: the child is the less-trusted
 * party, so we do not spread a malformed non-object payload.
 */
function withParentCancel(s: RunSession, data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  return {
    ...(data as Record<string, unknown>),
    cancel: (reason?: string) => {
      killChildSafely(s);
      settle(s, s.rejectPromise, new AgencyCancelledError(reason));
    },
  };
}

/**
 * Fire the PARENT's registered callbacks for an event forwarded from a child.
 *
 * MUST STAY SYNCHRONOUS (like handleTelemetryMessage): handleChildMessage
 * void-invokes its async dispatch, so FIFO arrival-order processing holds only
 * while this path has no awaits. Parent callbacks fire fire-and-forget (void
 * invokeCallbacks) so a slow or throwing parent callback cannot wedge the pump.
 *
 * invokeCallbacks re-emits upward when THIS process is itself a subprocess, so a
 * grandchild's event relays to the root with no explicit relay code.
 */
export function handleCallbackMessage(s: RunSession, msg: IpcCallbackMessage): void {
  if (s.settled) return; // drop post-settle events
  if (!isForwardableCallbackName(msg.name)) return; // child is less-trusted

  const data = msg.name === "onAgentStart" ? withParentCancel(s, msg.data) : msg.data;
  void invokeCallbacks({ ctx: s.ctx, name: msg.name, data, stateStack: s.stateStack });
}
```

(d) Add the dispatch case in `handleChildMessage` (after the `"telemetry"` branch at `ipc.ts:913-914`):

```typescript
  } else if (msg.type === "callback") {
    handleCallbackMessage(s, msg);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/ipc.test.ts 2>&1 | tee /tmp/cbf-3.log`
Expected: PASS (all existing ipc tests plus the 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/ipc.ts lib/runtime/ipc.test.ts
git commit -m "Add parent-side callback handler and wire IpcCallbackMessage" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Oversize/unserializable callback messages drop, never kill

**Files:**
- Modify: `lib/runtime/ipc.ts` — the serialization/limit branches in `handleChildMessage` (`ipc.ts:894-906`); export `handleChildMessage` for tests.
- Test: `lib/runtime/ipc.test.ts`

**Interfaces:**
- Consumes: existing `handleChildMessage`, `makeSession`.
- Produces: `export async function handleChildMessage(...)` (was private).

- [ ] **Step 1: Write the failing test**

Add to `lib/runtime/ipc.test.ts` (add `handleChildMessage` to the top-of-file import from `./ipc.js`):

```typescript
describe("handleChildMessage oversize handling", () => {
  it("drops an oversize callback message instead of killing the run", async () => {
    const rejections: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: {}, topLevelCallbacks: [], stateStack: stack };
    // makeSession default ipcPayload is 1 byte, so any callback payload is oversize.
    const session = makeSession({ ctx, stateStack: stack, rejectPromise: (e: any) => rejections.push(e) });

    await handleChildMessage(session, { type: "callback", name: "onNodeStart", data: { nodeName: "big" } });

    expect(session.settled).toBe(false);
    expect(rejections).toEqual([]);
  });

  it("still kills the run for an oversize non-callback message", async () => {
    const stack = new StateStack();
    const ctx: any = { lockReleasers: {}, stateStack: stack };
    const session = makeSession({ ctx, stateStack: stack });

    await handleChildMessage(session, { type: "result", value: { big: "x".repeat(50) } } as any);

    expect(session.settled).toBe(true); // settleWithLimitFailure fired
  });

  it("drops an UNSERIALIZABLE callback message instead of killing the run", async () => {
    // Covers the `!serialized.ok` observational branch (separate from oversize).
    const rejections: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: {}, topLevelCallbacks: [], stateStack: stack };
    const session = makeSession({
      ctx, stateStack: stack,
      limits: { wallClock: 1000, memory: 1, ipcPayload: 1e9, stdout: 1 }, // large, so oversize is NOT the cause
      rejectPromise: (e: any) => rejections.push(e),
    });
    const circular: any = { type: "callback", name: "onNodeStart", data: {} };
    circular.data.self = circular; // JSON.stringify throws -> serialized.ok === false

    await handleChildMessage(session, circular);

    expect(session.settled).toBe(false);
    expect(rejections).toEqual([]);
  });

  it("routes a within-limit callback through the dispatch case to the parent callback", async () => {
    // Directly exercises Task 3(d) — the `msg.type === "callback"` dispatch case
    // in handleChildMessage. The other handleCallbackMessage tests call it
    // directly, and the oversize test drops BEFORE dispatch, so without this the
    // dispatch wiring is only covered by the slow E2E (Task 5). A missing/typo'd
    // dispatch case would leave `fired` empty here.
    const fired: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: { onNodeStart: (d: any) => fired.push(d) }, topLevelCallbacks: [], stateStack: stack };
    const session = makeSession({
      ctx, stateStack: stack,
      limits: { wallClock: 1000, memory: 1, ipcPayload: 1e9, stdout: 1 },
    });

    await handleChildMessage(session, { type: "callback", name: "onNodeStart", data: { nodeName: "routed" } });
    await flush(); // handleCallbackMessage void-invokes invokeCallbacks; let the microtask chain drain

    expect(fired).toEqual([{ nodeName: "routed" }]);
  });
});
```

Note: `flush` is the `const flush = () => new Promise((r) => setImmediate(r))` helper introduced in Task 3 (file scope); reuse it. If Task 3 and Task 4 land in a different order, hoist `flush` to the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/ipc.test.ts 2>&1 | tee /tmp/cbf-4.log`
Expected: FAIL — either `handleChildMessage` is not exported, or the oversize callback test fails because the current code calls `settleWithLimitFailure` (session settles) for the callback message. (The unserializable-drop and dispatch-route tests also fail against the pre-change code: the former settles via the serialize-error branch; the latter cannot import the unexported `handleChildMessage`.)

- [ ] **Step 3: Write minimal implementation**

In `lib/runtime/ipc.ts`:

(a) Export `handleChildMessage` — change `async function handleChildMessage` (`ipc.ts:889`) to `export async function handleChildMessage`.

(b) Add a declarative drop-policy predicate near the other module-level
helpers, so the generic serialize/size gate does NOT hard-code which message
types are droppable (keeps the transport "how" separate from the drop-policy
"what"):

```typescript
/** Message types whose delivery is observational — an oversize or
 * unserializable one is DROPPED, never fatal, because it cannot affect the run
 * outcome (unlike result/interrupt/error/lock messages, which must settle or
 * kill the run). Extend this list when adding another fire-and-forget message. */
const OBSERVATIONAL_MESSAGE_TYPES: readonly string[] = ["callback"];

function isObservationalMessage(msg: { type?: string }): boolean {
  return typeof msg.type === "string" && OBSERVATIONAL_MESSAGE_TYPES.includes(msg.type);
}
```

(c) Replace the two serialization/limit branches (`ipc.ts:895-906`) with:

```typescript
  if (!serialized.ok) {
    // An observational message is never worth killing the run over.
    if (isObservationalMessage(msg)) {
      ipcLog("recv", { type: "observational_dropped", messageType: msg.type, reason: "unserializable" });
      return;
    }
    settle(s, s.rejectPromise, new Error(
      `Failed to serialize subprocess message: ${serialized.error}`,
    ));
    return;
  }
  if (serialized.byteLength > s.limits.ipcPayload) {
    // Drop an oversize observational message rather than settleWithLimitFailure
    // (which kills the run) — preserves the pure-observation invariant.
    if (isObservationalMessage(msg)) {
      ipcLog("recv", { type: "observational_dropped", messageType: msg.type, reason: "oversize" });
      return;
    }
    settleWithLimitFailure(s, "ipc_payload", s.limits.ipcPayload, serialized.byteLength, {
      samplePrefix: serialized.serialized.slice(0, 1024),
    });
    return;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/ipc.test.ts 2>&1 | tee /tmp/cbf-4.log`
Expected: PASS (existing tests plus the 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/ipc.ts lib/runtime/ipc.test.ts
git commit -m "Drop oversize callback messages instead of killing the run" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: End-to-end Agency execution tests

**Files:**
- Create: `tests/agency/subprocess/callback-forwarding-child-events.agency` + `.test.json`
- Create: `tests/agency/subprocess/callback-forwarding-nested-relay.agency` + `.test.json`

**Interfaces:**
- Consumes: the full forwarding pipeline from Tasks 1-4.
- Produces: two passing execution tests. No LLM calls (deterministic; node-entry `onNodeStart` fires without any LLM).

- [ ] **Step 1: Build the runtime (subprocess forks the built runtime)**

Run: `make 2>&1 | tee /tmp/cbf-make.log`
Expected: build succeeds (no errors).

- [ ] **Step 2: Write the child-events test**

Create `tests/agency/subprocess/callback-forwarding-child-events.agency`:

```
import { compile, run } from "std::agency"

// The parent registers an onNodeStart callback filtered to a node name that
// ONLY the child uses. Without forwarding, the parent's callback never sees the
// child's node entry, so `seen` stays 0. With forwarding, the child's
// onNodeStart is delivered to the parent and increments `seen`.
let seen: number = 0

node main() {
  callback("onNodeStart") as data {
    if (data.nodeName == "childOnlyNode") {
      seen = seen + 1
    }
  }
  const source = """
node childOnlyNode() {
  return "child done"
}
"""
  const compileResult = compile(source)
  if (isFailure(compileResult)) {
    return "compile failed"
  }
  handle {
    const result = run(compiled: compileResult.value, node: "childOnlyNode")
    if (isFailure(result)) {
      return "run failed"
    }
    return "childNodeSeen:${seen > 0}"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
```

Create `tests/agency/subprocess/callback-forwarding-child-events.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Parent onNodeStart callback fires for the child subprocess node entry",
      "input": "",
      "expectedOutput": "\"childNodeSeen:true\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 3: Run the child-events test to verify it passes**

Run: `pnpm run agency test tests/agency/subprocess/callback-forwarding-child-events.agency 2>&1 | tee /tmp/cbf-e2e-1.log`
Expected: PASS — output `"childNodeSeen:true"`.

- [ ] **Step 4: Write the nested-relay test**

Create `tests/agency/subprocess/callback-forwarding-nested-relay.agency` (models `cost-nested-relay-trips-root.agency`):

```
import { compile, run } from "std::agency"

// The grandchild fires onNodeStart for "grandNode". The mid-tier child has no
// callbacks of its own but relays the event upward (its invokeCallbacks
// re-emits because that process is in IPC mode). The ROOT parent's callback,
// filtered to "grandNode", must fire -> proves automatic nested relay.
let seen: number = 0

node main() {
  callback("onNodeStart") as data {
    if (data.nodeName == "grandNode") {
      seen = seen + 1
    }
  }
  const grandSource = """
node grandNode() {
  return "grandchild done"
}
"""
  const childSource = """
import { compile, run } from "std::agency"
node main(grandSource: string) {
  const c = compile(grandSource)
  if (isFailure(c)) {
    return "inner compile failed"
  }
  handle {
    const result = run(compiled: c.value, node: "grandNode")
    if (isFailure(result)) {
      return "inner run failed"
    }
    return "middle done"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
"""
  const compileResult = compile(childSource)
  if (isFailure(compileResult)) {
    return "compile failed"
  }
  handle {
    const result = run(
      compiled: compileResult.value,
      node: "main",
      args: { grandSource: grandSource },
    )
    if (isFailure(result)) {
      return "run failed"
    }
    return "grandchildSeen:${seen > 0}"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
```

Create `tests/agency/subprocess/callback-forwarding-nested-relay.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Root parent callback fires for a grandchild node event relayed through a callbackless mid-tier",
      "input": "",
      "expectedOutput": "\"grandchildSeen:true\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 5: Run the nested-relay test to verify it passes**

Run: `pnpm run agency test tests/agency/subprocess/callback-forwarding-nested-relay.agency 2>&1 | tee /tmp/cbf-e2e-2.log`
Expected: PASS — output `"grandchildSeen:true"`.

- [ ] **Step 6: Commit**

```bash
git add tests/agency/subprocess/callback-forwarding-child-events.agency tests/agency/subprocess/callback-forwarding-child-events.test.json tests/agency/subprocess/callback-forwarding-nested-relay.agency tests/agency/subprocess/callback-forwarding-nested-relay.test.json
git commit -m "Add E2E subprocess callback-forwarding tests (child events + nested relay)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/dev/subprocess-ipc.md` — add the new message + handler + relay; remove the callback-forwarding limitation bullet.
- Modify: `docs/misc/lifecycleHooks.md` — note that callbacks fire for subprocess events.

**Interfaces:** none (docs only).

- [ ] **Step 1: Update subprocess-ipc.md**

In `docs/dev/subprocess-ipc.md`: (a) add a subsection describing the `"callback"` message (`IpcCallbackMessage`), the choke-point emission in `invokeCallbacks`, the synchronous `handleCallbackMessage`, the automatic nested relay, the `onAgentStart.cancel` reconstruction, and the oversize-drop invariant; (b) find the "Remaining limitations" (or equivalent) section and remove the bullet stating that parent callbacks do not fire for subprocess events. Verify the current wording first:

Run: `grep -n "callback\|limitation\|Remaining" docs/dev/subprocess-ipc.md 2>&1 | tee /tmp/cbf-docs.log`

- [ ] **Step 2: Update lifecycleHooks.md**

In `docs/misc/lifecycleHooks.md`: add a short note that a parent's registered callbacks also fire for events inside a `std::agency run()` subprocess (forwarded fire-and-forget), that they are observational, that forwarding is unconditional (fires even with no parent callback; heavier payloads than in-process — see the plan's Scope section), and that `onStream`, `onOAuthRequired`, and `onTrace` are NOT forwarded (`onStream`/`onOAuthRequired` bypass or would break over the one-way choke point; `onTrace` is not dispatched today). Also note that `onAgentStart.cancel` fired from a parent callback is a best-effort async kill of the child, not the synchronous in-process prevent-start. Verify current wording first:

Run: `grep -n "onStream\|subprocess\|invokeCallbacks" docs/misc/lifecycleHooks.md 2>&1 | tee -a /tmp/cbf-docs.log`

- [ ] **Step 3: Commit**

```bash
git add docs/dev/subprocess-ipc.md docs/misc/lifecycleHooks.md
git commit -m "Document subprocess callback forwarding" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage** (checked against `docs/superpowers/specs/2026-07-02-subprocess-callback-forwarding-design.md`):
- Emission at the `invokeCallbacks` choke point → Task 2. ✓
- Leaf module `callbackForwarding.ts`, layering-safe, strips functions → Task 1. ✓
- Wire `IpcCallbackMessage` on `SubprocessToParent` + `"callback"` dispatch → Task 3. ✓
- Synchronous parent `handleCallbackMessage`, name validation, post-settle drop, `void invokeCallbacks` → Task 3. ✓
- `onAgentStart.cancel` reconstructed real (kill + settle cancelled) → Task 3 (unit-tested; E2E intentionally omitted because cancel surfaces as a propagating abort). ✓
- Automatic nested relay → Task 3 impl (re-entrant `invokeCallbacks`) + Task 5 E2E. ✓
- Oversize/unserializable never kills the run (child skip + parent drop) → Task 1 (child skip) + Task 4 (parent drop). ✓
- `onStream`/`onOAuthRequired`/`onTrace` NOT forwarded → `NON_FORWARDABLE_CALLBACKS` denylist enforces the two function/Promise-bearing ones (Task 1, with a test); `onTrace` excluded by non-existence. Rationale + inclusion cost → "Scope & design tradeoffs". Documented in Task 6. ✓
- Unconditional forwarding of heavy payloads is an accepted v1 tradeoff (no listener gating) → documented in "Scope & design tradeoffs", the Global Constraints, and the `callbackForwarding.ts` module doc. ✓
- `onAgentStart.cancel` is best-effort/async (NOT the synchronous in-process prevent-start semantic), with the settle-race no-op called out → Task 3 comment. ✓
- Purely observational, no blocking callbacks → reflected in comments/docs; nothing to implement. ✓
- Tests: unit (sender, emit, handler, oversize) + E2E (child events, nested relay) → Tasks 1-5. ✓
  - Each test is written to FAIL if its target code breaks (mutation-aware): the unknown-name test registers under the bogus name so it discriminates the `isForwardableCallbackName` guard (Task 3); Task 2 asserts forwarding is ADDITIVE (local callback still fires); Task 4 covers BOTH oversize and unserializable observational drops AND the `handleChildMessage` dispatch case (via a within-limit callback that reaches `handleCallbackMessage`), plus the complementary non-callback-still-kills case. ✓
- Docs → Task 6. ✓

**Placeholder scan:** No TBD/TODO; all code shown in full; all expected outputs are concrete strings. ✓

**Type consistency:** `sendCallbackToParent(name: CallbackName, data: unknown, maxBytes?)` (Task 1) is called as `sendCallbackToParent(name, data)` (Task 2). `IpcCallbackMessage` shape `{ type, name, data }` is identical across Tasks 1, 3, 4. `handleCallbackMessage(s: RunSession, msg: IpcCallbackMessage)` (Task 3) matches the dispatch call site. `handleChildMessage` exported in Task 4 matches its Task 4 test import. ✓
