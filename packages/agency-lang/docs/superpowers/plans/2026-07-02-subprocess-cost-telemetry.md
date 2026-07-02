# Subprocess Cost-Guard Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. (This project's owner has said NOT to use subagent-driven development — work inline in the main session.) Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parent cost guards see subprocess LLM spend live: each paid call in a child fire-and-forgets a telemetry message upward; the parent charges its guards and kills the child on a trip, which surfaces as the standard cost-limit Failure at the owning `guard(cost:)` boundary.

**Architecture:** One dependency-free leaf sender (`costTelemetry.ts`, which also owns the shared `isPayableCost` wire-contract predicate) called from `StateStack.chargeGuards` — the choke point every paid site funnels through — plus one new `handleChildMessage` case in `ipc.ts` that bills the charge and enforces. The billing pair (`localCost += x; chargeGuards(x)`) is extracted as `StateStack.billCharge` so `prompt.ts`, `addCost`, and the new handler share one named sequence instead of three inline copies (enforcement stays at call sites — it legitimately varies). Nested relay is automatic: the mid-tier handler's own `chargeGuards` re-emits upward because that process is itself in IPC mode.

**Tech Stack:** TypeScript runtime, Node IPC (`process.send`), existing guard machinery (`CostGuard`, `enforceGuards`, guard-trip abort ownership), `DeterministicClient` synthetic cost for tests.

**Spec:** `docs/superpowers/specs/2026-07-02-subprocess-cost-telemetry-design.md`. All paths relative to `packages/agency-lang/`.

## Global Constraints

- Agency syntax rules apply to test files (verify with `pnpm run ast <file>` when unsure).
- Save all test output to files under `/tmp/cost-telemetry/` (`mkdir -p` once); never rerun slow tests to re-read failures.
- Test commands: unit `pnpm vitest run <file>`; execution `pnpm run agency test <file>`. `make` after any stdlib/*.agency change. Do NOT run the full agency suite locally.
- No dynamic imports; objects not Maps; arrays not Sets; types not interfaces; never amend/force-push; no apostrophes in `-m` commit messages (use `-F` file if needed).
- Spec invariants: telemetry is fire-and-forget (never parks the child); charges are per-call incremental (no double-charge across pause/resume); post-settle telemetry charges but does not enforce; trip rejection must carry the guard-trip abort so the OWNING boundary converts it (the stdlib run()'s plain `try` re-throws trips — do not convert them in ipc.ts).
- ORDERING INVARIANT: `handleTelemetryMessage` must stay fully synchronous. `handleChildMessage` is void-invoked (`ipc.ts:896`), so arrival-order processing (telemetry before the child's own terminal `result`, per IPC FIFO) holds only while the telemetry path contains no `await` — an await before enforcement would let a fast child's result settle the session before the trip fires. Do not add async work (statelog etc.) to this path.

## Verified facts the tasks rely on

- `StateStack.chargeGuards(amount)` is at `lib/runtime/state/stateStack.ts` (~line 515): `for (const g of this.guards) g.charge(amount);` — its only direct callers are `prompt.ts` (~559-562) and `cost.ts` `addCost` (the memory subsystem pays via `addCost` at `memory/manager.ts:44`, image generation at `stdlib/image.ts:96`). Both sites run the same inline pair `localCost += amount; chargeGuards(amount)` then enforce — Task 1 extracts that pair as `StateStack.billCharge`.
- `stack.enforceGuards()` throws the guard-trip abort; a plain `try` re-throws it; the owning `guard(cost:)` boundary converts it to `failure` with `error.type === "guardFailure"`, `error.maxCost`, `error.actualCost`.
- `GuardExceededError` (`guard.ts:474`) extends `AgencyAbort` and carries the `guardId` the ownership conversion matches on; `isGuardExceededError` is exported at `guard.ts:493`. Unit tests must assert the rejection IS this error (identity matters for `ownedGuardIds` matching), not just match message text.
- `handleChildMessage` is invoked as `void handleChildMessage(s, msg)` (`ipc.ts:896`) — see the ORDERING INVARIANT above.
- `docs/superpowers/specs/` is gitignored by repo convention: the spec will NOT be visible in the PR, so the PR body must inline the design summary rather than link the spec path.
- `DeterministicClient` charges `SYNTHETIC_COST.totalCost = 0.000002` per `llm()` call (`lib/runtime/deterministicClient.ts:62`).
- Execution tests provide mocks via test.json `"useTestLLMProvider": true, "llmMocks": [...]` → the runner sets `AGENCY_LLM_MOCKS` env → `buildForkOptions` spreads `process.env`, so mocks reach subprocesses; EACH process gets its own full mock queue (count mocks per process, not per test).
- Guard syntax: `import { guard } from "std::thread"`; `guard(cost: 0.000003) as { ... }` returns a Result. `getCost()` from `std::thread` reads `stack.localCost`.
- `RunSession` (ipc.ts) has `{ sessionId, child, limits, ctx, stateStack, resolvePromise, rejectPromise, settled, ... }`; `settle(s, fn, value)` funnels every terminal path; the kill-log pattern is `ipcLog("send", { type: "kill_failed", detail })`.

## File structure

| File | Responsibility |
|---|---|
| `lib/runtime/costTelemetry.ts` (new) | Leaf fire-and-forget sender + `IpcTelemetryMessage` type + `isPayableCost` wire predicate (shared by sender and handler so both ends enforce the same contract). Imports nothing from the runtime (the `subprocessRunInfo.ts` layering pattern) so `stateStack.ts` can call it without cycles. |
| `lib/runtime/state/stateStack.ts` | New `billCharge` method (the localCost + chargeGuards pair) + one emission line in `chargeGuards`. |
| `lib/runtime/prompt.ts` | Switch the inline billing pair (~559-561) to `billCharge`. No behavior change. |
| `lib/runtime/cost.ts` | Switch `addCost`'s inline billing pair to `billCharge`. No behavior change. |
| `lib/runtime/ipc.ts` | `handleTelemetryMessage` + dispatch case + ipcLog case; union membership. |
| `tests/agency/subprocess/cost-*` | Four E2E scenarios. |
| Docs | `docs/site/guide/guards.md`, `docs/dev/subprocess-ipc.md`, `stdlib/agency.agency` run() docstring. |

---

### Task 0: Branch setup

The previous worktree branch (`worktree-subprocess-pause-resume`) is merged; start fresh from origin/main in the same worktree.

- [ ] **Step 1: Sync and branch**

```bash
cd /Users/adityabhargava/agency-lang/.claude/worktrees/subprocess-pause-resume
git fetch origin
git checkout -b subprocess-cost-telemetry origin/main
cp /Users/adityabhargava/agency-lang/packages/agency-lang/docs/superpowers/specs/2026-07-02-subprocess-cost-telemetry-design.md packages/agency-lang/docs/superpowers/specs/
cp /Users/adityabhargava/agency-lang/packages/agency-lang/docs/superpowers/plans/2026-07-02-subprocess-cost-telemetry.md packages/agency-lang/docs/superpowers/plans/
mkdir -p /tmp/cost-telemetry
cd packages/agency-lang
make > /tmp/cost-telemetry/setup-make.log 2>&1; echo "make: $?"
```

- [ ] **Step 2: Baseline**

```bash
pnpm vitest run lib/runtime/ipc.test.ts lib/runtime/guard.test.ts > /tmp/cost-telemetry/baseline.log 2>&1; echo "unit: $?"
pnpm run agency test tests/agency/guards/guard-cost-trip.agency >> /tmp/cost-telemetry/baseline.log 2>&1; echo "guard: $?"
pnpm run agency test tests/agency/subprocess/run-basic.agency >> /tmp/cost-telemetry/baseline.log 2>&1; echo "subprocess: $?"
```
Expected: all exit 0.

---

### Task 1: Leaf sender + `billCharge` + emission in `chargeGuards`

**Files:**
- Create: `lib/runtime/costTelemetry.ts`
- Modify: `lib/runtime/state/stateStack.ts` (~line 515: add `billCharge`, emit in `chargeGuards`)
- Modify: `lib/runtime/prompt.ts` (~559-561: switch to `billCharge`)
- Modify: `lib/runtime/cost.ts` (`addCost`: switch to `billCharge`)
- Test: `lib/runtime/costTelemetry.test.ts` (new)

**Interfaces:**
- Produces (Task 2 depends on these exact shapes):

```typescript
// costTelemetry.ts
export type IpcTelemetryMessage = {
  type: "telemetry";
  costUsd: number;
};
export function isPayableCost(costUsd: unknown): costUsd is number;
export function sendCostTelemetryToParent(costUsd: number): void;

// stateStack.ts
billCharge(amount: number): void;  // method on StateStack
```

- [ ] **Step 1: Write the failing tests**

Create `lib/runtime/costTelemetry.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { isPayableCost, sendCostTelemetryToParent } from "./costTelemetry.js";
import { StateStack } from "./state/stateStack.js";
import { CostGuard } from "./guard.js";

describe("isPayableCost", () => {
  it("accepts positive finite numbers only", () => {
    expect(isPayableCost(0.5)).toBe(true);
    expect(isPayableCost(0)).toBe(false);
    expect(isPayableCost(-1)).toBe(false);
    expect(isPayableCost(NaN)).toBe(false);
    expect(isPayableCost(Infinity)).toBe(false);
    expect(isPayableCost("0.5")).toBe(false);
    expect(isPayableCost(undefined)).toBe(false);
  });
});

describe("sendCostTelemetryToParent", () => {
  const originalSend = process.send;
  const originalIpc = process.env.AGENCY_IPC;

  afterEach(() => {
    process.send = originalSend;
    if (originalIpc === undefined) delete process.env.AGENCY_IPC;
    else process.env.AGENCY_IPC = originalIpc;
    vi.restoreAllMocks();
  });

  it("sends the telemetry message when in IPC mode", () => {
    process.env.AGENCY_IPC = "1";
    const send = vi.fn(() => true);
    process.send = send as any;
    sendCostTelemetryToParent(0.5);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "telemetry", costUsd: 0.5 });
  });

  it("no-ops outside IPC mode", () => {
    delete process.env.AGENCY_IPC;
    const send = vi.fn(() => true);
    process.send = send as any;
    sendCostTelemetryToParent(0.5);
    expect(send).not.toHaveBeenCalled();
  });

  it("no-ops for zero, negative, and non-finite cost", () => {
    process.env.AGENCY_IPC = "1";
    const send = vi.fn(() => true);
    process.send = send as any;
    sendCostTelemetryToParent(0);
    sendCostTelemetryToParent(-1);
    sendCostTelemetryToParent(NaN);
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows a dead-channel send error", () => {
    process.env.AGENCY_IPC = "1";
    process.send = vi.fn(() => { throw new Error("channel closed"); }) as any;
    expect(() => sendCostTelemetryToParent(0.5)).not.toThrow();
  });
});

describe("StateStack.chargeGuards emission", () => {
  const originalSend = process.send;
  const originalIpc = process.env.AGENCY_IPC;

  afterEach(() => {
    process.send = originalSend;
    if (originalIpc === undefined) delete process.env.AGENCY_IPC;
    else process.env.AGENCY_IPC = originalIpc;
    vi.restoreAllMocks();
  });

  it("emits exactly once per charge, even with zero guards installed", () => {
    // Emission must be unconditional on guards being present: a mid-tier
    // relay process may have NO local guards but must still forward the
    // grandchild spend upward.
    process.env.AGENCY_IPC = "1";
    const send = vi.fn(() => true);
    process.send = send as any;
    const stack = new StateStack();
    stack.chargeGuards(0.25);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "telemetry", costUsd: 0.25 });
  });

  it("does not emit for a zero charge", () => {
    process.env.AGENCY_IPC = "1";
    const send = vi.fn(() => true);
    process.send = send as any;
    new StateStack().chargeGuards(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("StateStack.billCharge", () => {
  it("accumulates localCost and really charges guards in one call", () => {
    const stack = new StateStack();
    const guard = new CostGuard(0.1);
    stack.guards.push(guard);
    stack.billCharge(0.25);
    expect(stack.localCost).toBe(0.25);
    // 0.25 > 0.1: check() reporting a trip proves the guard was charged,
    // not just localCost.
    expect(guard.check(stack)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run lib/runtime/costTelemetry.test.ts > /tmp/cost-telemetry/t1-red.log 2>&1; echo "exit: $?"; tail -5 /tmp/cost-telemetry/t1-red.log
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the leaf sender**

Create `lib/runtime/costTelemetry.ts`:

```typescript
/**
 * Fire-and-forget cost telemetry from a subprocess to its parent, so
 * parent-side cost guards see child LLM spend live (see
 * docs/superpowers/specs/2026-07-02-subprocess-cost-telemetry-design.md).
 *
 * Deliberately dependency-free (the subprocessRunInfo.ts layering
 * pattern): `StateStack.chargeGuards` calls this on every paid charge,
 * and stateStack must not import ipc.ts. The message type lives here and
 * is re-exported by ipc.ts into the SubprocessToParent union.
 *
 * Never blocks and never throws: there is no reply, no listener, and a
 * dead channel is swallowed — the bootstrap disconnect watchdog is about
 * to reap this process anyway.
 */

export type IpcTelemetryMessage = {
  type: "telemetry";
  costUsd: number;
};

/** The wire contract for a billable cost: a positive finite number.
 * Shared by the sender and the parent-side handler so both ends of the
 * channel enforce the same rule (the receiving side matters more — the
 * child is the less-trusted party). */
export function isPayableCost(costUsd: unknown): costUsd is number {
  return typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0;
}

export function sendCostTelemetryToParent(costUsd: number): void {
  if (process.env.AGENCY_IPC !== "1" || typeof process.send !== "function") return;
  if (!isPayableCost(costUsd)) return;
  const msg: IpcTelemetryMessage = { type: "telemetry", costUsd };
  try {
    process.send(msg);
  } catch (err) {
    // Channel gone — parent died; the watchdog will exit this process.
    // Deliberately swallowed (fire-and-forget invariant), but traceable:
    // ipcLog is unreachable from this leaf module, so mirror its gating.
    if (process.env.AGENCY_IPC_DEBUG === "1") {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ipc:telemetry] send failed: ${detail}\n`);
    }
  }
}
```

- [ ] **Step 4: `billCharge` + emit from `chargeGuards`**

In `lib/runtime/state/stateStack.ts`, add the import (top of file, alongside the other runtime imports):

```typescript
import { sendCostTelemetryToParent } from "../costTelemetry.js";
```

add `billCharge` directly above `chargeGuards`, and change `chargeGuards` (~line 515):

```typescript
  /**
   * Bill one paid charge to this stack: accumulate the branch-local cost
   * accumulator and charge every active guard. The single billing
   * sequence every paid site runs — llm (prompt.ts), addCost (cost.ts;
   * memory and image generation pay through it), and the parent-side
   * subprocess telemetry handler (ipc.ts). Enforcement stays at call
   * sites because it legitimately varies: prompt/addCost always enforce;
   * the telemetry handler skips enforcement once its session has settled.
   */
  billCharge(amount: number): void {
    this.localCost += amount;
    this.chargeGuards(amount);
  }

  chargeGuards(amount: number): void {
    for (const g of this.guards) g.charge(amount);
    // Subprocess: forward this charge to the parent so ITS cost guards
    // see the spend live. Emission is per paid call and unconditional on
    // local guards existing: a mid-tier relay may have none but must
    // still forward grandchild spend upward. No-op outside IPC mode.
    sendCostTelemetryToParent(amount);
  }
```

(Keep the existing doc comment on `chargeGuards`; only the body gains the emission line.)

- [ ] **Step 5: Switch the two existing paid sites to `billCharge`**

`lib/runtime/prompt.ts` (~559-561) — replace the inline pair, keeping the tokens line and the enforce:

```typescript
  const callCost = completion.cost?.totalCost ?? 0;
  targetStack.billCharge(callCost);
  targetStack.localTokens += completion.usage?.totalTokens ?? 0;
  targetStack.enforceGuards();
```

`lib/runtime/cost.ts` `addCost` — same substitution (docstring stays accurate as written):

```typescript
export function addCost(amount: number): void {
  const stack = getRuntimeContext().stack;
  stack.billCharge(amount);
  stack.enforceGuards();
}
```

- [ ] **Step 6: Run tests + typecheck + paid-site regression**

```bash
pnpm vitest run lib/runtime/costTelemetry.test.ts lib/runtime/guard.test.ts lib/runtime/memory/manager.test.ts > /tmp/cost-telemetry/t1-green.log 2>&1; echo "unit: $?"; grep -E "Tests " /tmp/cost-telemetry/t1-green.log
npx tsc --noEmit >> /tmp/cost-telemetry/t1-green.log 2>&1; echo "tsc: $?"
pnpm run agency test tests/agency/guards/guard-cost-trip.agency > /tmp/cost-telemetry/t1-guard-regress.log 2>&1; echo "guard-cost-trip: $?"
```
Expected: PASS / clean / exit 0. `manager.test.ts` and `guard-cost-trip` cover the two switched paid sites (`addCost` and the llm path). (If `toHaveBeenCalledExactlyOnceWith` is unavailable in this vitest version, use `toHaveBeenCalledTimes(1)` + `toHaveBeenCalledWith(...)`.)

- [ ] **Step 7: Commit**

```bash
cd /Users/adityabhargava/agency-lang/.claude/worktrees/subprocess-pause-resume
git add packages/agency-lang/lib/runtime/costTelemetry.ts packages/agency-lang/lib/runtime/costTelemetry.test.ts packages/agency-lang/lib/runtime/state/stateStack.ts packages/agency-lang/lib/runtime/prompt.ts packages/agency-lang/lib/runtime/cost.ts packages/agency-lang/docs/superpowers/plans/2026-07-02-subprocess-cost-telemetry.md
git commit -m "feat: emit per-call cost telemetry from chargeGuards; extract billCharge"
cd packages/agency-lang
```

---

### Task 2: Parent-side telemetry handler

**Files:**
- Modify: `lib/runtime/ipc.ts` (import/re-export the type; add to `SubprocessToParent`; `handleTelemetryMessage`; dispatch case in `handleChildMessage`; `ipcLog` case)
- Test: `lib/runtime/ipc.test.ts`

**Interfaces:**
- Consumes: `IpcTelemetryMessage` / `isPayableCost` (Task 1); `StateStack.billCharge` (Task 1); `settle`, `RunSession`, `ipcLog` (existing).
- Produces: `export function handleTelemetryMessage(s: RunSession, msg: IpcTelemetryMessage): void` — exported for unit tests (`RunSession` becomes an exported type for the same reason).

- [ ] **Step 1: Write the failing tests**

Add to `lib/runtime/ipc.test.ts`:

```typescript
import { handleTelemetryMessage } from "./ipc.js";
import { StateStack } from "./state/stateStack.js";
import { CostGuard, isGuardExceededError } from "./guard.js";

describe("handleTelemetryMessage", () => {
  const makeSession = (stack: StateStack) => {
    const kills: string[] = [];
    const rejections: any[] = [];
    const session: any = {
      sessionId: "s1",
      child: { kill: (sig: string) => { kills.push(sig); return true; }, connected: true },
      limits: { wallClock: 1000, memory: 1, ipcPayload: 1, stdout: 1 },
      ctx: { lockReleasers: {} },
      stateStack: stack,
      resolvePromise: () => {},
      rejectPromise: (err: any) => { rejections.push(err); },
      settled: false,
      startedAt: Date.now(),
      wallClockTimer: null,
      stdoutBytes: 0,
      stoppedForwarding: false,
      detachAbortListener: null,
    };
    return { session, kills, rejections };
  };

  it("charges localCost and guards; no trip under budget", () => {
    const stack = new StateStack();
    const guard = new CostGuard(1.0);
    stack.guards.push(guard);
    const { session, kills, rejections } = makeSession(stack);

    handleTelemetryMessage(session, { type: "telemetry", costUsd: 0.25 });

    expect(stack.localCost).toBe(0.25);
    expect(guard.check(stack)).toBeNull();
    expect(kills).toEqual([]);
    expect(rejections).toEqual([]);
    expect(session.settled).toBe(false);
  });

  it("a trip kills the child and rejects the session with the guard-trip abort", () => {
    const stack = new StateStack();
    stack.guards.push(new CostGuard(0.1));
    const { session, kills, rejections } = makeSession(stack);

    handleTelemetryMessage(session, { type: "telemetry", costUsd: 0.2 });

    expect(kills).toEqual(["SIGKILL"]);
    expect(rejections).toHaveLength(1);
    expect(session.settled).toBe(true);
    // The rejection must be the guard-trip abort ITSELF (identity, not a
    // wrapper or re-thrown copy) so the OWNING boundary's ownedGuardIds
    // matching converts it (the stdlib run() plain try re-throws).
    expect(isGuardExceededError(rejections[0])).toBe(true);
    expect(String(rejections[0])).toMatch(/cost/i);
  });

  it("post-settle telemetry still charges (the spend was real) but does not enforce", () => {
    const stack = new StateStack();
    stack.guards.push(new CostGuard(0.1));
    const { session, kills, rejections } = makeSession(stack);
    session.settled = true;

    handleTelemetryMessage(session, { type: "telemetry", costUsd: 0.2 });

    expect(stack.localCost).toBe(0.2);
    expect(kills).toEqual([]);
    expect(rejections).toEqual([]);
  });

  it("ignores malformed cost values", () => {
    const stack = new StateStack();
    const { session } = makeSession(stack);
    handleTelemetryMessage(session, { type: "telemetry", costUsd: NaN } as any);
    handleTelemetryMessage(session, { type: "telemetry", costUsd: -5 } as any);
    handleTelemetryMessage(session, { type: "telemetry" } as any);
    expect(stack.localCost).toBe(0);
  });
});
```

(Check `CostGuard`'s import path/export and `stack.guards` mutability against `lib/runtime/guard.ts` / `stateStack.ts` — if `guards` is not directly pushable, use the stack's guard-push method the generated code uses; `grep -n "pushGuard\|guards.push" lib/runtime/state/stateStack.ts`.)

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run lib/runtime/ipc.test.ts > /tmp/cost-telemetry/t2-red.log 2>&1; echo "exit: $?"; grep -E "FAIL|Tests " /tmp/cost-telemetry/t2-red.log | head -3
```
Expected: FAIL — `handleTelemetryMessage` not exported.

- [ ] **Step 3: Implement**

In `lib/runtime/ipc.ts`:

1. Import + re-export the type so the wire union stays discoverable in one place (the predicate comes along for the handler):

```typescript
import { isPayableCost, type IpcTelemetryMessage } from "./costTelemetry.js";
export { type IpcTelemetryMessage };
```

2. Add `| IpcTelemetryMessage` to the `SubprocessToParent` union.

3. Export the `RunSession` type (change `type RunSession` to `export type RunSession`).

4. Add the handler (next to `handleErrorMessage`):

```typescript
/** Child (or descendant, via relay) reported a paid call. Bill it to the
 * run() call-site stack via the same billCharge every in-process paid
 * site uses: localCost (parent getCost() reflects child spend live) plus
 * the guards — whose chargeGuards re-emits upward when THIS process is
 * itself a subprocess, which is what relays grandchild spend to the root
 * with no explicit plumbing. Billing is unconditional (the spend already
 * happened, even post-settle); enforcement only runs on a live session:
 * a trip kills the child and REJECTS the session with the guard-trip
 * abort, which propagates through invokeSubprocess → runBatch (errors
 * win over interrupts) → the stdlib run() plain `try` re-throws trips →
 * the user's owning guard(cost:) boundary converts it to the standard
 * cost-limit Failure.
 *
 * MUST STAY SYNCHRONOUS: handleChildMessage void-invokes its async
 * dispatch, so arrival-order processing (all telemetry before the
 * child's own terminal message, per IPC FIFO) holds only while this
 * path contains no awaits — an await before enforcement would let a
 * fast child's result settle the session before the trip fires.
 *
 * Known getCost() edge: post-settle billing (possible only on kill
 * paths — FIFO rules it out on normal completion) charges the shared
 * guard REFERENCES correctly, but the localCost increment can land
 * after a fork branch's cost delta has already propagated at join, so
 * getCost() may slightly undercount on abnormal termination. Budgets
 * never undercount; do not "fix" this by skipping post-settle billing. */
export function handleTelemetryMessage(s: RunSession, msg: IpcTelemetryMessage): void {
  if (!isPayableCost(msg.costUsd)) return;
  s.stateStack.billCharge(msg.costUsd);
  if (s.settled) return;
  try {
    s.stateStack.enforceGuards();
  } catch (err) {
    try {
      s.child.kill("SIGKILL");
    } catch (killErr) {
      ipcLog("send", { type: "kill_failed", detail: killErr instanceof Error ? killErr.message : String(killErr) });
    }
    settle(s, s.rejectPromise, err);
  }
}
```

5. Dispatch case in `handleChildMessage` (after the `interrupted` case):

```typescript
  } else if (msg.type === "telemetry") {
    handleTelemetryMessage(s, msg);
```

6. `ipcLog` detail case:

```typescript
  else if (type === "telemetry") detail = `costUsd=${msg.costUsd}`;
```

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm vitest run lib/runtime/ipc.test.ts lib/runtime/costTelemetry.test.ts > /tmp/cost-telemetry/t2-green.log 2>&1; echo "unit: $?"; grep -E "Tests " /tmp/cost-telemetry/t2-green.log
npx tsc --noEmit >> /tmp/cost-telemetry/t2-green.log 2>&1; echo "tsc: $?"
```
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/adityabhargava/agency-lang/.claude/worktrees/subprocess-pause-resume
git add packages/agency-lang/lib/runtime/ipc.ts packages/agency-lang/lib/runtime/ipc.test.ts
git commit -m "feat: parent charges cost guards from subprocess telemetry and kills on trip"
cd packages/agency-lang
```

---

### Task 3: E2E suite

Budget math throughout: `SYNTHETIC_COST.totalCost = 0.000002` per mocked `llm()` call; each PROCESS gets its own full mock queue from the inherited env, so `llmMocks` needs as many entries as the busiest single process makes calls.

**Files:**
- Test: `tests/agency/subprocess/cost-guard-trips-on-child-spend.agency` + `.test.json`
- Test: `tests/agency/subprocess/cost-child-spend-in-getcost.agency` + `.test.json`
- Test: `tests/agency/subprocess/cost-nested-relay-trips-root.agency` + `.test.json`
- Test: `tests/agency/subprocess/cost-two-children-share-budget.agency` + `.test.json`
- Test: `tests/agency/subprocess/cost-no-double-charge-across-pause.agency` + `.test.json`

**Interfaces:** consumes Tasks 1-2; produces nothing new. If any test exposes a bug, fix it in this task.

- [ ] **Step 1: Trip test**

`cost-guard-trips-on-child-spend.agency`:

```agency
import { compile, run } from "std::agency"
import { guard } from "std::thread"

// The child makes 3 mocked llm() calls at 0.000002 each. The parent guard
// caps at 0.000003: the second call's telemetry pushes spent to 0.000004,
// the guard trips, the child is killed, and the trip surfaces as the
// standard cost-limit Failure at this guard boundary.
node main() {
  const source = """
node main() {
  const a = llm("Reply with: one")
  const b = llm("Reply with: two")
  const c = llm("Reply with: three")
  return c
}
"""
  const compileResult = compile(source)
  if (isFailure(compileResult)) {
    return "compile failed"
  }
  handle {
    const result = guard(cost: 0.000003) as {
      return run(compiled: compileResult.value, node: "main")
    }
    if (isFailure(result)) {
      return "tripped:${result.error.type}"
    }
    return "did not trip"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
```

`.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Parent cost guard trips on subprocess spend and kills the child",
      "input": "",
      "expectedOutput": "\"tripped:guardFailure\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [
        { "return": "one" },
        { "return": "two" },
        { "return": "three" }
      ]
    }
  ]
}
```

Note the guard block returns `run(...)`'s Result on success — if the block-return shape misbehaves, bind to a `let` outside the guard instead (`guard-cost-no-trip.agency` demonstrates the working block-return pattern).

- [ ] **Step 2: getCost test**

`cost-child-spend-in-getcost.agency`:

```agency
import { compile, run } from "std::agency"
import { getCost } from "std::thread"

// Under budget: the run succeeds AND the parent's getCost() reflects the
// child's spend live (the parent itself makes zero llm calls, so any
// positive cost came through telemetry).
node main() {
  const source = """
node main() {
  const a = llm("Reply with: one")
  const b = llm("Reply with: two")
  return b
}
"""
  const compileResult = compile(source)
  if (isFailure(compileResult)) {
    return "compile failed"
  }
  handle {
    const result = run(compiled: compileResult.value, node: "main")
    if (isFailure(result)) {
      return "run failed"
    }
    return "childSpendVisible:${getCost() > 0}"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
```

`.test.json`: expected `"childSpendVisible:true"`, `useTestLLMProvider: true`, two mocks (`one`, `two`), no interruptHandlers.

- [ ] **Step 3: Nested relay test**

`cost-nested-relay-trips-root.agency` — the grandchild spends; only the ROOT holds a guard; the mid-tier has none and must relay:

```agency
import { compile, run } from "std::agency"
import { guard } from "std::thread"

node main() {
  const grandSource = """
node main() {
  const a = llm("Reply with: one")
  const b = llm("Reply with: two")
  const c = llm("Reply with: three")
  return c
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
    const result = run(compiled: c.value, node: "main")
    if (isSuccess(result)) {
      return result.value.data
    }
    return "inner run failed"
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
    const result = guard(cost: 0.000003) as {
      return run(
        compiled: compileResult.value,
        node: "main",
        args: { grandSource: grandSource },
      )
    }
    if (isFailure(result)) {
      return "tripped:${result.error.type}"
    }
    return "did not trip"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
```

`.test.json`: expected `"tripped:guardFailure"`, `useTestLLMProvider: true`, three mocks. (The trip kills the MID process; the grandchild is reaped by the disconnect watchdog — the chain-reap shipped with pause/resume.)

- [ ] **Step 4: Shared-budget test**

`cost-two-children-share-budget.agency` — the discriminating case for the rejected ship-guards-into-child design: each child alone (2 × 0.000002 = 0.000004) is under the 0.000005 cap, but the two together (0.000008) must trip the ONE shared budget:

```agency
import { compile, run } from "std::agency"
import { guard } from "std::thread"

node main() {
  const source = """
node main(tag: string) {
  const a = llm("Reply with: one")
  const b = llm("Reply with: two")
  return tag
}
"""
  const compileResult = compile(source)
  if (isFailure(compileResult)) {
    return "compile failed"
  }
  const compiled = compileResult.value
  handle {
    const result = guard(cost: 0.000005) as {
      const results = fork(["a", "b"]) as item {
        return run(compiled: compiled, node: "main", args: { tag: item })
      }
      return results
    }
    if (isFailure(result)) {
      return "tripped:${result.error.type}"
    }
    return "did not trip"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
```

`.test.json`: expected `"tripped:guardFailure"`, `useTestLLMProvider: true`, two mocks (each child process consumes its own queue). The outcome is interleaving-independent: total spend strictly exceeds the cap while each child alone stays under it.

- [ ] **Step 5: Pause/resume no-double-charge test**

`cost-no-double-charge-across-pause.agency` — one paid call before the pause, one after the resume; the parent's total must be EXACTLY two calls' worth (a replay that re-emitted the first call's telemetry would make it three). `0.000002 + 0.000002 = 0.000004` is exact in floating point (`x + x`), so the equality assertion is safe:

```agency
import { compile, run } from "std::agency"
import { getCost } from "std::thread"

node main() {
  const source = """
import { bash } from "std::shell"
node main() {
  const a = llm("Reply with: one")
  let r = bash("echo pause-here")
  const b = llm("Reply with: two")
  return b
}
"""
  const compileResult = compile(source)
  if (isFailure(compileResult)) {
    return "compile failed"
  }
  handle {
    const result = run(compiled: compileResult.value, node: "main")
    if (isFailure(result)) {
      return "run failed"
    }
    return "exactlyTwoCalls:${getCost() == 0.000004}"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
```

`.test.json`: expected `"exactlyTwoCalls:true"`, `useTestLLMProvider: true`, two mocks (`one`, `two`), and `"interruptHandlers": [{ "action": "approve" }]` (the unhandled bash pauses the child; the approval resumes it — the resumed segment replays the completed first llm() step without re-emitting).

- [ ] **Step 6: Parse-check, rebuild, run all five**

```bash
make > /tmp/cost-telemetry/t3-make.log 2>&1; echo "make: $?"
for t in cost-guard-trips-on-child-spend cost-child-spend-in-getcost cost-nested-relay-trips-root cost-two-children-share-budget cost-no-double-charge-across-pause; do
  if pnpm run ast tests/agency/subprocess/$t.agency > /dev/null 2>&1; then echo "$t: parses"; else echo "$t: PARSE FAIL"; continue; fi
  pnpm run agency test tests/agency/subprocess/$t.agency > /tmp/cost-telemetry/t3-$t.log 2>&1
  echo "$t: exit $?"
done
```
Expected: all PASS. Debug with `AGENCY_IPC_DEBUG=1` (telemetry lines show `costUsd=`). Likely failure spots: guard-block return shape (see Step 1 note); fork+guard composition timing (the trip rejection surfaces after `Promise.allSettled` — both children finish or die first; the assertion is outcome-only so this is fine).

- [ ] **Step 7: Regression sweep + commit**

```bash
for t in run-basic pause-multi-cycle concurrent-handled nested-pause-resume; do
  pnpm run agency test tests/agency/subprocess/$t.agency > /tmp/cost-telemetry/t3-regress-$t.log 2>&1; echo "$t: $?"
done
pnpm run agency test tests/agency/guards/guard-cost-trip.agency > /tmp/cost-telemetry/t3-regress-guard.log 2>&1; echo "guard-cost-trip: $?"
cd /Users/adityabhargava/agency-lang/.claude/worktrees/subprocess-pause-resume
git add packages/agency-lang/tests/agency/subprocess/cost-*
git commit -m "test: subprocess cost telemetry E2E suite"
cd packages/agency-lang
```

---

### Task 4: Docs, final verification, PR

**Files:**
- Modify: `docs/site/guide/guards.md` (cost guards cover subprocess spend — add a short subsection after the cost-guard section)
- Modify: `docs/dev/subprocess-ipc.md` (telemetry message in the protocol block; a "Cost guards" paragraph; REMOVE the cost-guard bullet from Remaining limitations)
- Modify: `stdlib/agency.agency` (`run()` docstring: enclosing cost guards meter the subprocess) — then `make`

- [ ] **Step 1: Docs edits**

`docs/dev/subprocess-ipc.md` — add to the Subprocess → Parent protocol block:

```typescript
{ type: "telemetry", costUsd }   // fire-and-forget, one per paid call
```

and a paragraph under Limits:

```markdown
**Cost guards** meter subprocess spend live: every paid call in a child
fire-and-forgets `{ type: "telemetry", costUsd }` upward (emitted from
`StateStack.chargeGuards`, the choke point every paid site funnels
through). The parent charges `localCost` + its guards on the run()
call-site stack — so parent `getCost()` includes child spend — and a trip
kills the child and surfaces the standard cost-limit Failure at the
owning `guard(cost:)` boundary. Relay to the root is automatic in nested
trees (the mid-tier handler's own `chargeGuards` re-emits upward).
Detection latency is at most one paid call, matching in-process CostGuard
semantics. Telemetry is cost-only; tokens arrive terminally via
`result.tokens`. One `getCost()` edge: telemetry arriving after a kill
(abort, wall-clock, stdout, memory — FIFO rules this out on normal
completion) still charges budgets via the shared guard references, but
can be invisible to `getCost()` if the owning fork branch already joined.
Budgets never undercount; `getCost()` may, on abnormal termination only.
```

Delete the `- **Cost-guard telemetry**: ...` bullet from Remaining limitations.

`docs/site/guide/guards.md` — locate the cost-guard section and add:

```markdown
Cost guards also meter subprocesses: spend from `std::agency run()` —
including nested subprocesses — is charged to enclosing cost guards in
real time, and a tripped budget terminates the subprocess and fails the
guard block with the usual cost-limit failure. `getCost()` reflects
subprocess spend as it happens.
```

`stdlib/agency.agency` `run()` docstring — after the resource-limits paragraph add:

```
  Enclosing cost guards meter the subprocess: each paid call inside it is charged to the parent's guard(cost:) budgets in real time, and a tripped budget terminates the subprocess and fails the guard block.
```

Then `make` (stdlib changed) and check `git status` for regenerated `docs/site/stdlib/` output — commit whatever `agency doc` regenerates.

- [ ] **Step 2: Final verification**

```bash
npx tsc --noEmit > /tmp/cost-telemetry/final.log 2>&1; echo "tsc: $?"
pnpm run lint:structure >> /tmp/cost-telemetry/final.log 2>&1; echo "lint: $?"
pnpm vitest run lib/runtime > /tmp/cost-telemetry/final-unit.log 2>&1; echo "runtime unit: $?"; grep -E "Tests " /tmp/cost-telemetry/final-unit.log
for f in tests/agency/subprocess/cost-*.agency; do pnpm run agency test "$f" > "/tmp/cost-telemetry/final-$(basename $f .agency).log" 2>&1; echo "$(basename $f .agency): $?"; done
```
Expected: all clean/green.

- [ ] **Step 3: PR**

Write the PR body to `/tmp/cost-telemetry/pr-body.md`. Do NOT link the spec path — `docs/superpowers/specs/` is gitignored, so the link would be dead for reviewers; inline the design summary instead (the chargeGuards-choke-point + automatic-relay architecture; the `billCharge` extraction unifying the three paid-site billing sequences; the getCost decision; the at-most-one-call detection latency, trip-kills-not-pauses, and abnormal-termination getCost-undercount limitations; the five E2E scenarios; end with the standard Claude Code attribution footer), then:

```bash
cd /Users/adityabhargava/agency-lang/.claude/worktrees/subprocess-pause-resume
git push -u origin subprocess-cost-telemetry
gh pr create --title "Cost guards meter subprocess spend via per-call telemetry" --body-file /tmp/cost-telemetry/pr-body.md
```
