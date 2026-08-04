# Serve Cost Seam — Implementation Plan (agency-lang half)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 3 (2026-08-04):** Incorporates both reviews and the focused `docs/dev/anti-patterns.md` audit. All ownership and compatibility decisions are now locked; no task defers an architectural choice to implementation.

**Goal:** Surface trusted, fresh per-invocation usage on every post-execution HTTP serve outcome, including whether subprocess telemetry is complete, without changing ordinary node/function/resume or MCP wire semantics.

**Architecture:** There are two declarative boundaries. Accounting sites submit an `InvocationUsageDelta` to `recordPaidUsageAt({ ctx, stack }, delta)`, which reuses `StateStack.billCharge` for branch/guard bookkeeping, merges the invocation meter, and relays the full delta once; `recordPaidUsage(delta)` is only an ambient convenience for TS helpers such as `addCost`. Runtime execution is owned by outcome-producing cores; existing public APIs unwrap-or-rethrow their `ServedInvocationOutcome`, while generated serve-only invokers return the outcome to HTTP/MCP adapters.

**Tech Stack:** TypeScript runtime (`lib/runtime/`), typestache templates, HTTP/MCP serve adapters, Node IPC, Vitest.

## Global Constraints

- A meter is fresh for every execution context and is never serialized or restored from a checkpoint.
- `pricedCost` includes every valid nonnegative amount that participates in `StateStack.billCharge`, including `addCost` and subprocess spend.
- Finite zero is a known free price. An absent, negative, or non-finite completion price is unknown, contributes zero priced cost, and increments `unknownCostCallCount`.
- Invalid `addCost` input throws; it is never silently normalized to zero.
- Usage is present on success, interrupt, 402, generic failure, and cancellation after an execution context exists. `/list`, 404, and pre-context 400 responses omit it.
- `usageComplete` describes telemetry delivery, while `pricingComplete` describes price availability. Never overload one for the other.
- Returned values and thrown errors are never mutated or wrapped. Preserve error identity, `readCause`, stack, cause, runtime/statelog error reporting, and 402 classification.
- Handler registration and cleanup order are safety infrastructure and must remain unchanged.
- `recordPaidUsageAt` is synchronous. IPC telemetry handling must remain synchronous through billing and guard enforcement.
- Modify `.mustache` template sources and run `pnpm run templates`; do not hand-edit generated template `.ts` files.
- Follow `docs/dev/coding-standards.md` and `docs/dev/anti-patterns.md`: types not interfaces, objects not maps, arrays not sets, no dynamic imports.
- Save test output to a file on every run so failures can be inspected without rerunning expensive tests.

## Locked Contracts

```ts
export type InvocationUsage = {
  pricedCost: number;
  inputTokens: number;
  outputTokens: number;
  unknownCostCallCount: number;
  pricingComplete: boolean;
};

export type InvocationUsageDelta = {
  pricedCost: number;
  inputTokens: number;
  outputTokens: number;
  unknownCostCallCount: number;
};

export type InvocationUsageSnapshot = {
  usage: InvocationUsage;
  usageComplete: boolean;
};

export type ServedInvocationOutcome<T> =
  | ({ status: "returned"; value: T } & InvocationUsageSnapshot)
  | ({ status: "threw"; error: unknown } & InvocationUsageSnapshot);

export type InvocationAccountingTarget = {
  ctx: RuntimeContext<GraphState>;
  stack: StateStack;
};
```

`pricingComplete` is derived from `unknownCostCallCount === 0`. `usageComplete` starts `true` and becomes permanently `false` if an abnormal subprocess termination means unsent usage cannot be ruled out. A `false` value makes `usage` a trusted lower bound, not an authoritative final total; the statelog consumer must treat that attempt conservatively.

### Exact invocation compatibility seam

The runtime exposes outcome-returning functions:

```ts
runNodeForServe(args): Promise<ServedInvocationOutcome<RunNodeResult<any>>>
runExportedFunctionForServe(args): Promise<ServedInvocationOutcome<unknown>>
respondToInterruptsForServe(args): Promise<ServedInvocationOutcome<RunNodeResult<any>>>
```

Existing `runNode`, `runExportedFunction`, and `respondToInterrupts` call the same internal cores and use `unwrapServedInvocationOutcome` to preserve their current raw return/throw contracts.

Current compiled modules add three separate exports without changing existing exports:

```ts
__invokeNodeForServe(nodeName, data)
__invokeFunctionForServe(fn, namedArgs)
__respondToInterruptsForServe(interrupts, responses, opts?)
```

`discoverExports` requires these current-compile serve invokers. Old bundles without them fail fast with a recompile-required error; they cannot satisfy the usage contract. The existing exported node functions, `__invokeFunction`, and `respondToInterrupts` remain unchanged for CLI, debugger, subprocess, and other callers.

---

### Task 1: Usage types, validation, and meter

**Files:**
- Create: `lib/runtime/invocationUsage.ts`
- Create: `lib/runtime/invocationUsage.test.ts`

**Interfaces:**
- Produces: all locked types above; `InvocationUsageMeter`; `completionUsageDelta`; `paidCostDelta`; `normalizeUsageDelta`; `unwrapServedInvocationOutcome`.

```ts
export class InvocationUsageMeter {
  merge(delta: InvocationUsageDelta): void;
  markIncomplete(): boolean; // true only on the first complete → incomplete transition
  snapshot(): InvocationUsageSnapshot;
}

export function completionUsageDelta(args: {
  cost: number | null | undefined;
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
}): InvocationUsageDelta;

export function paidCostDelta(amount: number): InvocationUsageDelta;
export function normalizeUsageDelta(raw: unknown): InvocationUsageDelta | null;
export function unwrapServedInvocationOutcome<T>(outcome: ServedInvocationOutcome<T>): T;
```

- [ ] **Step 1: Write failing unit tests.** Cover accumulation with `toBeCloseTo`; fresh completeness; permanent `markIncomplete`; `undefined`, `null`, zero, positive, negative, and `NaN` completion prices; absent tokens as zero; invalid tokens as zero; `paidCostDelta` rejecting negative/non-finite values; normalization preserving valid fields while converting an invalid cost into one unknown-cost call; and unwrap preserving thrown error identity, including strings and frozen objects.
- [ ] **Step 2: Run the tests and verify failure.** Run `pnpm vitest run lib/runtime/invocationUsage.test.ts > /tmp/serve-cost-task1.log 2>&1; code=$?; cat /tmp/serve-cost-task1.log; exit $code`. Expected: failure because the module does not exist.
- [ ] **Step 3: Implement the types and arithmetic.** Use private numeric fields in the meter. Validate token/count fields as finite nonnegative integers. Treat invalid completion cost as unknown; never as known-free zero.
- [ ] **Step 4: Run the same command and verify it passes.**
- [ ] **Step 5: Commit the task.**

### Task 2: Fresh, non-serialized execution-context ownership

**Files:**
- Modify: `lib/runtime/state/context.ts`
- Create: `lib/runtime/state/context.invocationUsage.test.ts`

**Interfaces:**
- Consumes: `InvocationUsageMeter`.
- Produces: `RuntimeContext.invocationUsage: InvocationUsageMeter`.

- [ ] **Step 1: Write failing context tests.** Assert that each `createExecutionContext` creates an independent complete zero meter; `restoreState` does not replace or hydrate it; checkpoint and `toJSON` output omit it.
- [ ] **Step 2: Run and capture failure.** Run `pnpm vitest run lib/runtime/state/context.invocationUsage.test.ts > /tmp/serve-cost-task2.log 2>&1; code=$?; cat /tmp/serve-cost-task2.log; exit $code`.
- [ ] **Step 3: Implement the field.** Initialize it explicitly inside `createExecutionContext`, which bypasses the constructor. Do not add it to checkpoint serialization or `restoreState`.
- [ ] **Step 4: Run the same command and verify it passes.**
- [ ] **Step 5: Commit the task.**

### Task 3: One explicit-target accounting operation

**Files:**
- Create: `lib/runtime/recordPaidUsage.ts`
- Modify: `lib/runtime/state/stateStack.ts`
- Modify: `lib/runtime/prompt.ts`
- Modify: `lib/runtime/cost.ts`
- Modify: `lib/runtime/costTelemetry.ts`
- Test: `lib/runtime/recordPaidUsage.test.ts`
- Test: `lib/runtime/prompt.test.ts`
- Test: `lib/runtime/agency.test.ts`
- Test: `lib/runtime/costTelemetry.test.ts`

**Interfaces:**
- Consumes: `InvocationAccountingTarget`, `InvocationUsageDelta`, `completionUsageDelta`, `paidCostDelta`.
- Produces:

```ts
export function recordPaidUsageAt(
  target: InvocationAccountingTarget,
  delta: InvocationUsageDelta,
): void;

export function recordPaidUsage(delta: InvocationUsageDelta): void;

export function markInvocationUsageIncompleteAt(
  ctx: RuntimeContext<GraphState>,
): void;
```

**Implementation rule:** `StateStack.billCharge(amount)` remains the sole implementation of `localCost` plus guard charging, but no longer emits IPC. `recordPaidUsageAt` calls `target.stack.billCharge`, merges `target.ctx.invocationUsage`, then calls `sendInvocationUsageToParent(delta)` once. `markInvocationUsageIncompleteAt` relays `sendInvocationUsageIncompleteToParent()` only when `meter.markIncomplete()` reports the first transition. Do not duplicate `billCharge` as `localCost += ...` plus `chargeGuards(...)` in the new file. `recordPaidUsage` reads ALS and delegates; only `addCost` uses it. Prompt passes its existing explicit `ctx` and `targetStack`. IPC will pass `RunSession.ctx/stateStack` in Task 4.

- [ ] **Step 1: Write failing accounting tests.** Prove one call bills local cost and guards once, merges once, and sends once; no IPC send occurs inside `billCharge`; `addCost(0.25)` records cost and still enforces; invalid `addCost` throws before mutation; an explicit branch target charges that branch rather than `ctx.stateStack`; an unpriced completion records tokens/unknown count without charging guards; and repeated incomplete marks emit one marker.
- [ ] **Step 2: Run and capture failure.** Run `pnpm vitest run lib/runtime/recordPaidUsage.test.ts lib/runtime/prompt.test.ts lib/runtime/agency.test.ts lib/runtime/costTelemetry.test.ts > /tmp/serve-cost-task3.log 2>&1; code=$?; cat /tmp/serve-cost-task3.log; exit $code`.
- [ ] **Step 3: Implement the full-delta sender and accounting boundary.** Define `sendInvocationUsageToParent(delta)` and `sendInvocationUsageIncompleteToParent()` in `costTelemetry.ts`. Preserve prompt's existing enforce-later behavior and `addCost`'s immediate `enforceGuards` behavior. Do not add an await.
- [ ] **Step 4: Run the Step 2 command and verify pass.**
- [ ] **Step 5: Commit the task.**

### Task 4: Full IPC deltas, out-of-frame accounting, and delivery completeness

**Files:**
- Modify: `lib/runtime/ipc.ts`
- Test: `lib/runtime/costTelemetry.test.ts`
- Test: `lib/runtime/ipc.test.ts`

**Interfaces:**
- Consumes: `recordPaidUsageAt`, `markInvocationUsageIncompleteAt`, `normalizeUsageDelta`.
- Produces a telemetry union containing a full usage delta and an incompleteness marker; retains legacy `{ type: "telemetry", costUsd }` receive compatibility.

**Delivery rule:** normal child completion relies on IPC FIFO: usage messages precede the terminal result/interrupt message. Every abnormal child termination marks the owning invocation incomplete before settlement and relays an incompleteness marker if this process is itself a child. Hard-kill paths keep accepting already-delivered post-settle usage as a best-known lower bound. Do not claim `usageComplete: true` after a killed child, even if its `close` event arrives cleanly, because unsent child telemetry cannot be ruled out.

- [ ] **Step 1: Write failing wire tests.** Cover full-delta serialization; zero-cost unpriced usage; legacy cost-only normalization; invalid cost becoming unknown rather than known-free; malformed token/count fields; sender failure remaining non-throwing; and an incompleteness marker.
- [ ] **Step 2: Write failing handler tests.** Call `handleTelemetryMessage` without an ALS frame and assert it uses `s.ctx/s.stateStack`; assert exact one-child and grandchild totals; assert enforcement stays synchronous; assert any wall-clock kill, cancellation kill, guard-trip kill, child error, unexpected close, or non-observational IPC failure permanently marks usage incomplete and relays the marker upward.
- [ ] **Step 3: Run `pnpm vitest run lib/runtime/costTelemetry.test.ts lib/runtime/ipc.test.ts > /tmp/serve-cost-task4.log 2>&1; code=$?; cat /tmp/serve-cost-task4.log; exit $code` and verify failure.**
- [ ] **Step 4: Implement the wire and handlers.** Keep telemetry handling synchronous. An incompleteness marker is idempotent locally but each process relays a received marker once; no cost is billed for the marker.
- [ ] **Step 5: Run the Step 3 command and verify pass.**
- [ ] **Step 6: Commit the task.**

### Task 5: Outcome-producing runtime cores with compatibility wrappers

**Files:**
- Modify: `lib/runtime/node.ts`
- Modify: `lib/runtime/interrupts.ts`
- Modify: `lib/runtime/index.ts`
- Create: `lib/runtime/invocationOutcome.test.ts`

**Interfaces:**
- Consumes: `ServedInvocationOutcome`, `InvocationUsageSnapshot`, `unwrapServedInvocationOutcome`.
- Produces: `runNodeForServe`, `runExportedFunctionForServe`, `respondToInterruptsForServe` with the exact signatures in “Locked Contracts”.

**Lifecycle rule:** each runtime file extracts one internal core that creates the execution context and returns an outcome. Immediately after successful context creation, one outer lifecycle boundary covers initialization, handler registration, budgets, callbacks, abort wiring, execution, error telemetry, and cleanup. Existing public functions call that core and unwrap-or-rethrow. Serve functions return the outcome unchanged.

For cleanup, retain the first execution error as the outcome error. Log a later cleanup error without replacing the first. If execution succeeded but cleanup failed, return a threw outcome containing the cleanup error. Take the final meter snapshot after cleanup attempts so cleanup-incurred paid usage is included. Preserve current statelog `runtimeError`/`agentEnd` emission and handler order.

- [ ] **Step 1: Write failing outcome tests.** Cover object/primitive/`undefined` returns; ordinary `Error`, string, frozen object, guard trip, and `AgencyCancelledError`; already-aborted input; post-context initialization failure; cleanup failure after success; cleanup failure after an execution error; runtime/statelog error emission; handler installation order; and resume-leg isolation.
- [ ] **Step 2: Add public compatibility tests.** Direct `runNode`, `runExportedFunction`, and `respondToInterrupts` calls must still return raw values and throw the identical original error.
- [ ] **Step 3: Run `pnpm vitest run lib/runtime/invocationOutcome.test.ts > /tmp/serve-cost-task5.log 2>&1; code=$?; cat /tmp/serve-cost-task5.log; exit $code` and verify failure.**
- [ ] **Step 4: Refactor into outcome cores and compatibility wrappers.** Do not wrap or mutate user errors. Keep handler registration inside the protected lifecycle.
- [ ] **Step 5: Run `pnpm vitest run lib/runtime/invocationOutcome.test.ts lib/runtime/interrupts.test.ts lib/runtime/hooks.test.ts lib/runtime/rootBudget.test.ts > /tmp/serve-cost-task5-pass.log 2>&1; code=$?; cat /tmp/serve-cost-task5-pass.log; exit $code` and verify pass.**
- [ ] **Step 6: Commit the task.**

### Task 6: Generated serve-only invokers and discovery contract

**Files:**
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache`
- Regenerate: `lib/templates/backends/typescriptGenerator/imports.ts` via `pnpm run templates`
- Modify: `lib/serve/types.ts`
- Modify: `lib/serve/discovery.ts`
- Modify: `lib/serve/createServeHandler.ts`
- Test: `lib/serve/discovery.test.ts`
- Test: `lib/serve/createServeHandler.test.ts`

**Interfaces:**
- Consumes: the three runtime `*ForServe` functions.
- Produces module exports `__invokeNodeForServe`, `__invokeFunctionForServe`, `__respondToInterruptsForServe`; discovered function/node invokers return `ServedInvocationOutcome<unknown>` whose returned `value` is already caller-facing data.

**Generated shape:** `__invokeNodeForServe(nodeName, data)` calls `runNodeForServe` with `__globalCtx` and `__initializeGlobals`. Function and resume equivalents bind the same module context. Existing node exports, `__invokeFunction`, and `respondToInterrupts` remain byte-compatible. `discoverExports` maps a returned node `RunNodeResult` to its `.data` while retaining the same usage fields and leaves a threw outcome untouched.

- [ ] **Step 1: Write failing discovery/factory tests.** Require all three serve invokers; return a clear “recompile with current Agency” error when absent; assert primitive function values, node `.data` mapping, unchanged errors, and preserved usage/completeness.
- [ ] **Step 2: Run `pnpm vitest run lib/serve/discovery.test.ts lib/serve/createServeHandler.test.ts > /tmp/serve-cost-task6.log 2>&1; code=$?; cat /tmp/serve-cost-task6.log; exit $code` and verify failure.**
- [ ] **Step 3: Modify only `imports.mustache`, then run `pnpm run templates`.** Inspect the generated `imports.ts`; do not edit it manually.
- [ ] **Step 4: Implement typed discovery and factory wiring.** `createServeHandler` passes `__respondToInterruptsForServe`, not public `respondToInterrupts`.
- [ ] **Step 5: Run the Step 2 test command, then `pnpm run typecheck > /tmp/serve-cost-task6-typecheck.log 2>&1; code=$?; cat /tmp/serve-cost-task6-typecheck.log; exit $code`; verify both pass.**
- [ ] **Step 6: Commit the task.**

### Task 7: Declarative HTTP and MCP adapter mapping

**Files:**
- Modify: `lib/serve/http/adapter.ts`
- Modify: `lib/serve/mcp/adapter.ts`
- Modify: `lib/serve/mcp/interruptLoop.ts`
- Modify: `lib/cli/serve.ts`
- Modify: `lib/templates/cli/standaloneHttp.mustache`
- Modify: `lib/templates/cli/standaloneMcp.mustache`
- Modify: `lib/templates/cli/standaloneMcpHttp.mustache`
- Regenerate corresponding template `.ts` files via `pnpm run templates`
- Test: `lib/serve/http/adapter.test.ts`
- Test: `lib/serve/mcp/adapter.test.ts`
- Test: `lib/serve/mcp/interruptLoop.test.ts`
- Test: `lib/serve/createServeHandler.test.ts`

**Interfaces:**
- Consumes: `ServedInvocationOutcome<unknown>` from every discovered invocation and serve resume.
- Produces HTTP `RouteResult` with optional `usage?: InvocationUsage` and `usageComplete?: boolean`; MCP wire remains unchanged.

**HTTP rule:** one `routeResultFor(outcome, options)` accepts `{ renderReturned, logger, what }`. Function routes supply `renderReturned: ok`; node/resume routes supply a callback that preserves today's interrupt detection before calling `ok`. Thrown outcomes retain today's 402/generic classification and server-side logging. The mapper adds usage fields once; pre-execution helpers continue returning no usage fields. `readCause` runs on the original `outcome.error`.

**MCP rule:** one local outcome-unwrapper returns `value` or throws `error` before entering the existing policy loop. Resume handlers call `__respondToInterruptsForServe`, unwrap the outcome, then unwrap `RunNodeResult.data`. MCP does not expose usage in v1. Preserve existing server-side/statelog error logging; converting an exception to an outcome is transport, not swallowing.

- [ ] **Step 1: Write failing HTTP tests.** Assert usage and completeness on success, interrupt, 402, generic failure, and cancellation; omission on `/list`, 404, and validation 400; and otherwise unchanged response bodies.
- [ ] **Step 2: Write failing MCP/CLI/template tests.** Assert function/node values and errors are wire-identical; policy-driven resume still works; generated standalone HTTP uses serve resume; generated standalone MCP variants unwrap serve resume.
- [ ] **Step 3: Run `pnpm vitest run lib/serve/http/adapter.test.ts lib/serve/mcp/adapter.test.ts lib/serve/mcp/interruptLoop.test.ts lib/serve/createServeHandler.test.ts > /tmp/serve-cost-task7.log 2>&1; code=$?; cat /tmp/serve-cost-task7.log; exit $code` and verify failure.**
- [ ] **Step 4: Implement the single HTTP mapper and MCP unwrapping.** Avoid duplicated per-branch usage decoration and nested ternaries.
- [ ] **Step 5: Run `pnpm run templates > /tmp/serve-cost-task7-templates.log 2>&1`, the Step 3 test command, and `pnpm run typecheck > /tmp/serve-cost-task7-typecheck.log 2>&1`; inspect all three saved logs and verify pass.**
- [ ] **Step 6: Commit the task.**

### Task 8: End-to-end behavioral proof

**Files:**
- Create: `lib/serve/http/serveCostSeam.integration.test.ts`

- [ ] **Step 1: Add compiled-module integration cases.** Through the real HTTP handler, prove exact usage for function/node success, interrupt, 402, generic throw, and cancellation; genuine zero price versus absent/invalid price; in-process versus child `addCost`; one child and one grandchild; two concurrent requests; and two resume legs that each exclude prior-leg usage.
- [ ] **Step 2: Add completeness cases.** Normal subprocess completion returns `usageComplete: true`; forced child kill returns `false`; a delivered late telemetry delta remains in the lower-bound usage when observed before the outcome.
- [ ] **Step 3: Run only this integration file into `/tmp/serve-cost-task8.log` and verify pass.** Do not run the full Agency execution suite.
- [ ] **Step 4: Run `pnpm run lint:structure` and `pnpm run typecheck`, saving output, and fix only issues caused by this change.**
- [ ] **Step 5: Commit the task.**

### Task 9: Developer documentation

**Files:**
- Modify: `docs/dev/hosted-agent-execution.md`
- Modify: `docs/dev/async-context.md`

- [ ] **Step 1: Document the accounting boundary.** Explain explicit versus ambient ownership, `billCharge` reuse, per-leg/non-serialized meters, valid/unknown pricing, and exact-once IPC deltas.
- [ ] **Step 2: Document the invocation boundary.** Explain public compatibility wrappers, generated serve-only exports, HTTP `usage`/`usageComplete`, MCP behavior, stale-bundle recompilation, and why abnormal child termination makes usage a trusted lower bound.
- [ ] **Step 3: Run Markdown/diff checks and commit.** Do not edit generated `docs/site/**` pages.

---

## Self-Review Checklist

- No placeholder or unresolved wrapper decision remains.
- `recordPaidUsageAt` accepts explicit ownership; IPC never requires ALS.
- `recordPaidUsageAt` reuses `StateStack.billCharge` instead of duplicating its mutable internals.
- Prompt passes `targetStack`; IPC passes `RunSession.ctx/stateStack`; only `addCost` uses ambient ownership.
- Function, node, and resume use the same outcome-core/compatibility-wrapper pattern.
- Existing public runtime and MCP values/errors remain unchanged.
- Existing runtime/statelog error logging remains inside the lifecycle core.
- Pricing incompleteness and telemetry incompleteness are distinct.
- Invalid prices cannot produce `pricingComplete: true`; invalid `addCost` cannot erase a charge silently.
- Normal child telemetry is exact; abnormal child termination is explicitly marked incomplete and never presented as authoritative.
- Handler registration is never skipped or restored from checkpoints.
- Template source files, not generated files, are the hand-edited source of truth.
- No full Agency test suite is run locally.

## Deferred

`runId` is not added to the usage result in v1. Correlation remains statelog-side and can be added separately without changing accounting correctness.
