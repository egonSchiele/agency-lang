# Subprocess Callback Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. NOTE: this repo forbids subagent-driven implementation — execute INLINE via superpowers:executing-plans in a fresh worktree off `origin/main`.

**Goal:** Forward a subprocess's lifecycle callbacks to its parent over IPC so a parent's registered `AgencyCallbacks` fire for events that happen inside a `std::agency run()` child.

**Architecture:** Fire-and-forget child→parent IPC, mirroring the shipped cost-telemetry design (PR #404). A single choke point (`invokeCallbacks` in `hooks.ts`) emits every event upward via a dependency-light leaf module; the parent re-fires its own registered callbacks by re-entering `invokeCallbacks`, which makes nested (grandchild) relay automatic. Callbacks are purely observational and never kill the run; the sole flow-affecting capability is `onAgentStart.cancel`, reconstructed parent-side to mirror in-process fidelity.

**Tech Stack:** TypeScript (Node `child_process` IPC via `process.send`), vitest for unit tests, Agency `.agency`/`.test.json` execution tests.

## Global Constraints

- Leaf module `callbackForwarding.ts` MUST NOT import `ipc.ts` (layering rule — `hooks.ts` imports the leaf, and `hooks.ts`/`stateStack.ts` must never pull in `ipc.ts`). Its only runtime import is `subprocessRunInfo.js`.
- `handleCallbackMessage` MUST be synchronous (no `await`) — `handleChildMessage` void-invokes its async dispatch, so IPC FIFO ordering holds only while the path has no awaits. Fire parent callbacks as `void invokeCallbacks(...)`.
- Forwarding is PURELY OBSERVATIONAL and MUST NEVER kill the run: a dead channel, oversize, or unserializable payload is dropped/swallowed, never fatal.
- Fire-and-forget: the child never waits for the parent's callback; no reply channel.
- Code style: NO dynamic imports; use objects not Maps; arrays not Sets; types not interfaces.
- Git: never force-push/amend. Commit messages use `-m` with NO apostrophes (apostrophes on the command line fail in this repo); add the trailer via a second `-m`.
- Testing: save test output to a file. Do NOT run the full agency suite — run only the specific tests named here.
- Run `make` before the Agency execution (E2E) tests: the subprocess child is forked from the built runtime.

---

## File Structure

- **Create** `lib/runtime/callbackForwarding.ts` — leaf module: `IpcCallbackMessage` wire type, `CALLBACK_PAYLOAD_LIMIT`, `sendCallbackToParent`. Child-side emission only.
- **Create** `lib/runtime/callbackForwarding.test.ts` — unit tests for the sender.
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/callbackForwarding.test.ts 2>&1 | tee /tmp/cbf-1.log`
Expected: FAIL — cannot resolve `./callbackForwarding.js` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `lib/runtime/callbackForwarding.ts`:

```typescript
/**
 * Fire-and-forget forwarding of lifecycle callbacks from a subprocess to its
 * parent, so a parent's registered AgencyCallbacks fire for events that happen
 * inside a std::agency run() child (see
 * docs/superpowers/specs/2026-07-02-subprocess-callback-forwarding-design.md).
 *
 * Dependency-light leaf (mirrors costTelemetry.ts): the only runtime import is
 * subprocessRunInfo.ts. invokeCallbacks (hooks.ts) calls sendCallbackToParent on
 * every event; hooks.ts must not import ipc.ts, so the wire type + sender live
 * here.
 *
 * Never blocks, never throws, and never kills the run: no reply, no listener; a
 * dead channel or an over-limit / unserializable payload is swallowed — the
 * event is observational, so dropping it is always safe.
 */

import { isIpcMode } from "./subprocessRunInfo.js";
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

function ipcChildDebug(line: string): void {
  if (process.env.AGENCY_IPC_DEBUG !== "1") return;
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[ipc:child] ${ts} ${line}\n`);
}

/** Forward one lifecycle event to the parent. No-op unless this process is a
 * forked Agency subprocess with a live IPC channel. `maxBytes` is overridable
 * only so tests can exercise the oversize-skip without a gigabyte payload. */
export function sendCallbackToParent(
  name: CallbackName,
  data: unknown,
  maxBytes: number = CALLBACK_PAYLOAD_LIMIT,
): void {
  if (!isIpcMode() || typeof process.send !== "function") return;
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
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/callbackForwarding.ts lib/runtime/callbackForwarding.test.ts
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
Expected: PASS (all existing hooks tests plus the 2 new ones).

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
    const fired: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: { onNodeStart: (d: any) => fired.push(d) }, topLevelCallbacks: [], stateStack: stack };
    const session = makeSession({ ctx, stateStack: stack });

    handleCallbackMessage(session, { type: "callback", name: "onBogus" as any, data: {} });
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

  let data: any = msg.data;
  if (msg.name === "onAgentStart") {
    // The child's cancel function was stripped by JSON. Reconstruct a REAL one:
    // the parent owns the child session, so a parent onAgentStart callback that
    // calls cancel() kills the child and settles run() as cancelled. Mirrors
    // in-process fidelity, where onAgentStart carries a real cancel.
    data = {
      ...(data as Record<string, unknown>),
      cancel: (reason?: string) => {
        killChildSafely(s);
        settle(s, s.rejectPromise, new AgencyCancelledError(reason));
      },
    };
  }
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/ipc.test.ts 2>&1 | tee /tmp/cbf-4.log`
Expected: FAIL — either `handleChildMessage` is not exported, or the oversize callback test fails because the current code calls `settleWithLimitFailure` (session settles) for the callback message.

- [ ] **Step 3: Write minimal implementation**

In `lib/runtime/ipc.ts`:

(a) Export `handleChildMessage` — change `async function handleChildMessage` (`ipc.ts:889`) to `export async function handleChildMessage`.

(b) Replace the two serialization/limit branches (`ipc.ts:895-906`) with:

```typescript
  if (!serialized.ok) {
    // A forwarded callback is observational — never kill the run over it.
    if (msg.type === "callback") { ipcLog("recv", { type: "callback_dropped", reason: "unserializable" }); return; }
    settle(s, s.rejectPromise, new Error(
      `Failed to serialize subprocess message: ${serialized.error}`,
    ));
    return;
  }
  if (serialized.byteLength > s.limits.ipcPayload) {
    // Drop an oversize observational callback rather than settleWithLimitFailure
    // (which kills the run) — preserves the pure-observation invariant.
    if (msg.type === "callback") { ipcLog("recv", { type: "callback_dropped", reason: "oversize" }); return; }
    settleWithLimitFailure(s, "ipc_payload", s.limits.ipcPayload, serialized.byteLength, {
      samplePrefix: serialized.serialized.slice(0, 1024),
    });
    return;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/ipc.test.ts 2>&1 | tee /tmp/cbf-4.log`
Expected: PASS (existing tests plus the 2 new ones).

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

In `docs/misc/lifecycleHooks.md`: add a short note that a parent's registered callbacks also fire for events inside a `std::agency run()` subprocess (forwarded fire-and-forget), that they are observational, and that `onStream` is the one exception (it bypasses the `invokeCallbacks` choke point and is not forwarded). Verify current wording first:

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
- `onStream` out of scope → documented in Task 6. ✓
- Purely observational, no blocking callbacks → reflected in comments/docs; nothing to implement. ✓
- Tests: unit (sender, emit, handler, oversize) + E2E (child events, nested relay) → Tasks 1-5. ✓
- Docs → Task 6. ✓

**Placeholder scan:** No TBD/TODO; all code shown in full; all expected outputs are concrete strings. ✓

**Type consistency:** `sendCallbackToParent(name: CallbackName, data: unknown, maxBytes?)` (Task 1) is called as `sendCallbackToParent(name, data)` (Task 2). `IpcCallbackMessage` shape `{ type, name, data }` is identical across Tasks 1, 3, 4. `handleCallbackMessage(s: RunSession, msg: IpcCallbackMessage)` (Task 3) matches the dispatch call site. `handleChildMessage` exported in Task 4 matches its Task 4 test import. ✓
