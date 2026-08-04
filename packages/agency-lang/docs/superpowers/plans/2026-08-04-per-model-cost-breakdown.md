# Per-Model Cost Breakdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every hosted serve invocation a per-model breakdown of priced cost and input/output tokens, plus a `modelAttributionComplete` trust signal, riding the existing invocation-usage meter and reconciling to the authoritative flat total.

**Architecture:** A charge's attribution is a discriminated value — `{kind:"model",model}` or `{kind:"unattributed"}` — carried on `InvocationUsageDelta` and its IPC wire message. The `InvocationUsageMeter` buckets each measurable charge into a `models` map or an `unattributed` row and emits both in its snapshot. A measurable *received* delta with **no** attribution (an older child) trips `modelAttributionComplete` at the IPC boundary. The HTTP adapter surfaces all of it to the host with no logic change.

**Tech Stack:** TypeScript runtime (`lib/runtime`), Vitest. No codegen/template changes. No `.agency` stdlib changes.

**Spec:** `docs/superpowers/specs/2026-08-04-per-model-cost-breakdown-design.md` (v3, post-second-review).

**Plan refinement over the spec:** `isMeasurableDelta` belongs in `invocationUsage.ts` beside the delta type and row-creation rule, not in `recordPaidUsage.ts`. This plan's placement supersedes File 5 of the spec so the meter and IPC provenance check reuse one definition.

## Global Constraints

- NEVER use dynamic imports. Use objects not maps, arrays not sets, `type` not `interface`.
- Do NOT edit `docs/site/**` (only `docs/dev/**`). Do NOT edit `CHANGELOG.md`. Do NOT commit to `main`; work on the task branch. Owner squash-merges the PR — do not merge it yourself.
- Lint (enforced by `eslint.config.js`): max 1250 lines/file, 150 lines/function. `docs/dev/coding-standards.md` sets a stricter *style target* of 1000/100 — keep new code near the target and prefer a new small module over growing `invocationUsage.ts` or `ipc.ts`.
- Commit messages / PR bodies go in a FILE passed with `git commit -F <file>` (apostrophes on the command line break). Follow the repo's commit conventions; this environment appends the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer — keep it on your own commits.
- Run ONLY the test file(s) for the task you are on: `pnpm test:run <path>`. Do NOT run the full suite. Run `make` ONCE at the very end (Task 6) — it is the only full typecheck/build and it is slow.
- Every test here is deterministic and makes NO LLM calls.
- The authoritative flat `pricedCost` accumulation (#801) must stay byte-identical — only ADD the breakdown alongside it.
- Reconciliation precision is an explicit accounting policy, not a proof that every sub-threshold omitted charge is detectable: consumers accept discrepancies up to `max(1e-9 USD, 1e-9 × |pricedCost|)`. At `$10,000`, that is `$0.00001`. The flat total remains authoritative.
- No `make fixtures`: the one changed signature (`accountCompletionUsage`) has a single runtime caller and no template reference — verified, no codegen impact.
- Reuse existing test fixtures, do NOT invent new ones: `recordPaidUsage.test.ts` has `makeCtx()` = `new RuntimeContext<GraphState>({ statelogConfig, smoltalkDefaults, dirname })`; `ipc.test.ts` has canonical `makeSession`, `makeTelemetrySession`, and `makeUsageSession` helpers. A direct usage handler test MUST use a real `StateStack` through `makeUsageSession()` — overriding only `ctx` leaves the canonical mock's `stateStack: {}` and crashes in `billCharge`.

---

### Task 1: Attribution types, meter bucketing, reconciliation

Add the discriminated attribution, the `models`/`unattributed`/`modelAttributionComplete` state, and the reconciliation tolerance. Pure meter logic — no IPC, no prompt wiring.

**Files:**
- Modify: `lib/runtime/invocationUsage.ts`
- Test: `lib/runtime/invocationUsage.test.ts` (exists — extend)

**Interfaces:**
- Produces:
  - `UsageAttribution = { kind: "model"; model: string } | { kind: "unattributed" }`
  - `ModelUsageRow = { pricedCost; inputTokens; outputTokens }`
  - `USAGE_RECONCILE_ABS_USD`, `USAGE_RECONCILE_REL`, `usageReconcileTolerance(total): number`
  - `isMeasurableDelta(delta): boolean`, owned beside `InvocationUsageDelta` and reused by meter bucketing and IPC provenance detection
  - `InvocationUsage` gains optional `models?`, `unattributed?`, `modelAttributionComplete?`
  - `InvocationUsageDelta` gains optional `attribution?: UsageAttribution`
  - `completionUsageDelta({..., model})` → sets `{kind:"model"}`; `paidCostDelta` → sets `{kind:"unattributed"}`; `normalizeUsageDelta` → `attribution` via `normalizeAttribution`
  - `InvocationUsageMeter.markModelAttributionIncomplete(): boolean`; snapshot emits the three new fields

- [ ] **Step 1: Write the failing tests**

Extend `lib/runtime/invocationUsage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  InvocationUsageMeter, completionUsageDelta, paidCostDelta, normalizeUsageDelta,
  usageReconcileTolerance,
} from "./invocationUsage.js";

type Usage = ReturnType<InvocationUsageMeter["snapshot"]>["usage"];
function rowSumCost(usage: Usage) {
  const modelCost = Object.values(usage.models ?? {})
    .reduce((total, row) => total + row.pricedCost, 0);
  return modelCost + (usage.unattributed?.pricedCost ?? 0);
}
function reconciles(usage: Usage) {
  return Math.abs(rowSumCost(usage) - usage.pricedCost)
    <= usageReconcileTolerance(usage.pricedCost);
}

describe("InvocationUsageMeter per-model breakdown", () => {
  it("files a priced completion under its model row and reconciles", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(completionUsageDelta({
      cost: 0.1,
      inputTokens: 100,
      outputTokens: 20,
      model: "opus",
    }));
    const { usage } = meter.snapshot();
    expect(usage.models!["opus"]).toEqual({ pricedCost: 0.1, inputTokens: 100, outputTokens: 20 });
    expect(reconciles(usage)).toBe(true);
  });

  it("routes addCost spend to unattributed, not models", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(paidCostDelta(0.03));
    const { usage } = meter.snapshot();
    expect(usage.models).toEqual({});
    expect(usage.unattributed).toEqual({ pricedCost: 0.03, inputTokens: 0, outputTokens: 0 });
    expect(reconciles(usage)).toBe(true);
  });

  it("mixes a model row and unattributed", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(completionUsageDelta({
      cost: 0.1,
      inputTokens: 1,
      outputTokens: 1,
      model: "opus",
    }));
    meter.merge(paidCostDelta(0.03));
    const { usage } = meter.snapshot();
    expect(usage.models!["opus"].pricedCost).toBeCloseTo(0.1);
    expect(usage.unattributed!.pricedCost).toBeCloseTo(0.03);
    expect(reconciles(usage)).toBe(true);
  });

  it("makes no row for a pure unknown-cost delta and keeps attribution complete", () => {
    const meter = new InvocationUsageMeter();
    meter.merge({
      pricedCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      unknownCostCallCount: 1,
    });
    const { usage } = meter.snapshot();
    expect(usage.models).toEqual({});
    expect(usage.unattributed).toEqual({ pricedCost: 0, inputTokens: 0, outputTokens: 0 });
    expect(usage.pricingComplete).toBe(false);
    expect(usage.modelAttributionComplete).toBe(true);
  });

  it("treats __proto__ as a plain own key", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(completionUsageDelta({
      cost: 0.01,
      inputTokens: 1,
      outputTokens: 1,
      model: "__proto__",
    }));
    expect(Object.prototype.hasOwnProperty.call(
      meter.snapshot().usage.models,
      "__proto__",
    )).toBe(true);
    expect(({} as any).pricedCost).toBeUndefined();
  });

  it("aggregates repeated charges for one model into one row", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(completionUsageDelta({
      cost: 0.01, inputTokens: 10, outputTokens: 2, model: "opus",
    }));
    meter.merge(completionUsageDelta({
      cost: 0.02, inputTokens: 20, outputTokens: 4, model: "opus",
    }));
    expect(meter.snapshot().usage.models!["opus"]).toEqual({
      pricedCost: 0.03,
      inputTokens: 30,
      outputTokens: 6,
    });
  });

  it("reconciles a regrouping-sensitive interleave within tolerance where === fails", () => {
    const meter = new InvocationUsageMeter();
    const sequence: [string, number][] = [
      ["alpha", 0.1],
      ["beta", 0.1],
      ["alpha", 0.1],
      ["beta", 0.1],
      ["alpha", 0.1],
      ["beta", 0.1],
      ["alpha", 0.1],
    ];
    for (const [model, cost] of sequence) {
      meter.merge(completionUsageDelta({
        cost,
        inputTokens: 1,
        outputTokens: 1,
        model,
      }));
    }
    const { usage } = meter.snapshot();
    const rowSum = usage.models!["alpha"].pricedCost
      + usage.models!["beta"].pricedCost;
    expect(rowSum).not.toBe(usage.pricedCost);                 // 0.7000000000000001 vs 0.7
    expect(Math.abs(rowSum - usage.pricedCost)).toBeLessThanOrEqual(usageReconcileTolerance(usage.pricedCost));
  });

  it("keeps a real model named 'unknown model' as an ordinary row", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(completionUsageDelta({
      cost: 0.01,
      inputTokens: 1,
      outputTokens: 1,
      model: "unknown model",
    }));
    const { usage } = meter.snapshot();
    expect(usage.models!["unknown model"].pricedCost).toBeCloseTo(0.01);
    expect(usage.unattributed).toEqual({ pricedCost: 0, inputTokens: 0, outputTokens: 0 });
  });

  it("returns independent copies from snapshot", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(completionUsageDelta({
      cost: 0.1, inputTokens: 1, outputTokens: 1, model: "opus",
    }));
    const firstSnapshot = meter.snapshot().usage;
    firstSnapshot.models!["opus"].pricedCost = 999;
    firstSnapshot.models!["extra"] = {
      pricedCost: 5,
      inputTokens: 0,
      outputTokens: 0,
    };
    firstSnapshot.unattributed!.pricedCost = 999;

    const secondSnapshot = meter.snapshot().usage;
    expect(secondSnapshot.models!["opus"].pricedCost).toBeCloseTo(0.1);
    expect(secondSnapshot.models!["extra"]).toBeUndefined();
    expect(secondSnapshot.unattributed!.pricedCost).toBe(0);
  });

  it("flips modelAttributionComplete once, idempotently", () => {
    const meter = new InvocationUsageMeter();
    expect(meter.snapshot().usage.modelAttributionComplete).toBe(true);
    expect(meter.markModelAttributionIncomplete()).toBe(true);
    expect(meter.markModelAttributionIncomplete()).toBe(false);
    expect(meter.snapshot().usage.modelAttributionComplete).toBe(false);
  });

  it("fails reconciliation when a row is corrupted above tolerance (check has teeth)", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(completionUsageDelta({
      cost: 0.1, inputTokens: 1, outputTokens: 1, model: "opus",
    }));
    const { usage } = meter.snapshot();
    usage.models!["opus"].pricedCost -= 2 * usageReconcileTolerance(usage.pricedCost);
    expect(reconciles(usage)).toBe(false);
  });
});

describe("normalizeUsageDelta attribution", () => {
  it("preserves model and unattributed, drops malformed/absent to undefined", () => {
    const modelDelta = normalizeUsageDelta({
      pricedCost: 0.1,
      inputTokens: 1,
      outputTokens: 1,
      unknownCostCallCount: 0,
      attribution: { kind: "model", model: "opus" },
    });
    expect(modelDelta?.attribution).toEqual({ kind: "model", model: "opus" });

    const unattributedDelta = normalizeUsageDelta({
      pricedCost: 0.1,
      inputTokens: 1,
      outputTokens: 1,
      unknownCostCallCount: 0,
      attribution: { kind: "unattributed" },
    });
    expect(unattributedDelta?.attribution).toEqual({ kind: "unattributed" });

    const malformedAttributions = [
      undefined,
      null,
      42,
      { kind: "model" },
      { kind: "model", model: "" },
      { kind: "nope" },
    ];
    for (const malformedAttribution of malformedAttributions) {
      const normalized = normalizeUsageDelta({
        pricedCost: 0.1,
        inputTokens: 1,
        outputTokens: 1,
        unknownCostCallCount: 0,
        attribution: malformedAttribution,
      });
      expect(normalized?.attribution).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/runtime/invocationUsage.test.ts`
Expected: FAIL (new exports/fields absent).

- [ ] **Step 3: Implement in `lib/runtime/invocationUsage.ts`**

Add, per the spec's File 1 section: `USAGE_RECONCILE_ABS_USD`/`USAGE_RECONCILE_REL`/`usageReconcileTolerance`; `ModelUsageRow`; `UsageAttribution`; `newRow()` + `copyModels()` locals; `models`/`unattributed`/`modelAttributionComplete` optional fields on `InvocationUsage`; `attribution?` on `InvocationUsageDelta`; and `isMeasurableDelta(delta)` beside that type. Use `isMeasurableDelta` in `merge` before selecting `attribution.kind === "model"` → `models[attribution.model] ??= newRow()`, else `unattributed`. Add `markModelAttributionIncomplete()`; the three new snapshot fields; `{kind:"model"}` in `completionUsageDelta`; `{kind:"unattributed"}` in `paidCostDelta`; and `normalizeAttribution` wired into `normalizeUsageDelta`. Use block-bodied `if` statements and descriptive names throughout.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:run lib/runtime/invocationUsage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** — `feat(serve): attribution-tagged per-model breakdown in the usage meter`

---

### Task 2: Model-identity helper + thread the model into completion accounting

**Files:**
- Create: `lib/runtime/modelIdentity.ts`
- Test: `lib/runtime/modelIdentity.test.ts` (create)
- Modify: `lib/runtime/recordPaidUsage.ts` (`accountCompletionUsage` + `model` param)
- Modify: `lib/runtime/prompt.ts:732,773`
- Test: `lib/runtime/recordPaidUsage.test.ts` (exists — extend)

**Interfaces:**
- Consumes: `completionUsageDelta({..., model})` (Task 1).
- Produces: `resolveCompletionModel(completionModel, configuredModel): string`; `accountCompletionUsage(ctx, targetStack, completion, model: string)`.

- [ ] **Step 1: Write the failing tests**

`lib/runtime/modelIdentity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveCompletionModel } from "./modelIdentity.js";

describe("resolveCompletionModel", () => {
  it("prefers the provider-reported completion model", () => {
    expect(resolveCompletionModel("opus-4.8", "sonnet")).toBe("opus-4.8");
  });
  it("falls back to the configured model when the completion model is empty/absent", () => {
    expect(resolveCompletionModel(undefined, "sonnet")).toBe("sonnet");
    expect(resolveCompletionModel("", "sonnet")).toBe("sonnet");
    expect(resolveCompletionModel(null, "sonnet")).toBe("sonnet");
  });
  it("returns 'unknown model' when neither is available", () => {
    expect(resolveCompletionModel(undefined, undefined)).toBe("unknown model");
    expect(resolveCompletionModel("", "")).toBe("unknown model");
  });
});
```

In `lib/runtime/recordPaidUsage.test.ts` (reuse its `makeCtx()`):

```ts
it("accountCompletionUsage attributes to the provided model", () => {
  const ctx = makeCtx();
  const stack = new StateStack();
  accountCompletionUsage(
    ctx,
    stack,
    {
      cost: { totalCost: 0.1 },
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    },
    "opus-4.8",
  );
  const { usage } = ctx.invocationUsage.snapshot();
  expect(usage.models!["opus-4.8"]).toEqual({
    pricedCost: 0.1,
    inputTokens: 5,
    outputTokens: 2,
  });
});
```

(`accountCompletionUsage` is already imported in that test file; add it to the import if not.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/runtime/modelIdentity.test.ts lib/runtime/recordPaidUsage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `lib/runtime/modelIdentity.ts` with `resolveCompletionModel` (spec File 2). In `recordPaidUsage.ts`, add the `model: string` param to `accountCompletionUsage` and pass it into `completionUsageDelta`. In `prompt.ts:732` replace the inline expression with `resolveCompletionModel(completion.model, clientConfig.model)`; at `prompt.ts:773` call `accountCompletionUsage(ctx, targetStack, completion, modelName)`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:run lib/runtime/modelIdentity.test.ts lib/runtime/recordPaidUsage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** — `feat(serve): resolveCompletionModel helper + thread model into accounting`

---

### Task 3: Carry attribution over IPC (send + receive)

**Files:**
- Modify: `lib/runtime/costTelemetry.ts` (`IpcInvocationUsageMessage` gains `attribution?`)
- Test: `lib/runtime/costTelemetry.test.ts` (exists — send-side assertion), `lib/runtime/ipc.test.ts` (exists — receive bucketing + concurrency)

**Interfaces:**
- Consumes: `normalizeUsageDelta`/attribution (Task 1), `handleInvocationUsageMessage` (existing).
- Produces: `IpcInvocationUsageMessage.attribution?: UsageAttribution`.

- [ ] **Step 1: Write the failing tests**

Send side — in `costTelemetry.test.ts`, add `completionUsageDelta` and `paidCostDelta` to the imports from `invocationUsage.ts`. The file already stubs and restores `process.send`; follow that pattern:

```ts
it("relays attribution for a completion and an addCost charge", () => {
  vi.stubEnv("AGENCY_IPC", "1");
  const send = vi.fn(() => true);
  process.send = send as any;

  sendInvocationUsageToParent(completionUsageDelta({
    cost: 0.1,
    inputTokens: 1,
    outputTokens: 1,
    model: "opus",
  }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    type: "invocationUsage",
    attribution: { kind: "model", model: "opus" },
  }));

  send.mockClear();
  sendInvocationUsageToParent(paidCostDelta(0.03));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    type: "invocationUsage",
    attribution: { kind: "unattributed" },
  }));
});
```

Receive side — add these inside the existing `describe("handleInvocationUsageMessage (full delta)")` block in `ipc.test.ts`, reusing its `makeUsageSession()` helper. That helper supplies both the meter-bearing `ctx` and a real `StateStack`:

```ts
it("buckets a modeled child charge under its model", () => {
  const { session, ctx } = makeUsageSession();
  handleInvocationUsageMessage(session, {
    type: "invocationUsage",
    pricedCost: 0.1,
    inputTokens: 100,
    outputTokens: 20,
    unknownCostCallCount: 0,
    attribution: { kind: "model", model: "opus-4.8" },
  });
  const { usage } = ctx.invocationUsage.snapshot();
  expect(usage.models!["opus-4.8"]).toEqual({
    pricedCost: 0.1,
    inputTokens: 100,
    outputTokens: 20,
  });
  expect(usage.modelAttributionComplete).toBe(true);
});

it("keeps two concurrent sessions' model rows independent", () => {
  const first = makeUsageSession();
  const second = makeUsageSession();

  handleInvocationUsageMessage(first.session, {
    type: "invocationUsage",
    pricedCost: 0.1,
    inputTokens: 1,
    outputTokens: 1,
    unknownCostCallCount: 0,
    attribution: { kind: "model", model: "opus" },
  });
  handleInvocationUsageMessage(second.session, {
    type: "invocationUsage",
    pricedCost: 0.2,
    inputTokens: 1,
    outputTokens: 1,
    unknownCostCallCount: 0,
    attribution: { kind: "model", model: "haiku" },
  });

  expect(Object.keys(first.ctx.invocationUsage.snapshot().usage.models!))
    .toEqual(["opus"]);
  expect(Object.keys(second.ctx.invocationUsage.snapshot().usage.models!))
    .toEqual(["haiku"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/runtime/costTelemetry.test.ts lib/runtime/ipc.test.ts`
Expected: FAIL on the attribution assertions.

- [ ] **Step 3: Implement**

`costTelemetry.ts`: add `attribution?: UsageAttribution` to `IpcInvocationUsageMessage`. Confirm `sendInvocationUsageToParent` still spreads the whole delta so `attribution` is included, and the all-zero skip is unchanged. `handleInvocationUsageMessage` needs no bucketing change — `normalizeUsageDelta` now carries `attribution`, so `accountChildUsage → recordPaidUsageAt → meter.merge` files it correctly. (The provenance trip is Task 4.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:run lib/runtime/costTelemetry.test.ts lib/runtime/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** — `feat(serve): relay charge attribution across the subprocess boundary`

---

### Task 4: `modelAttributionComplete` — trip on missing provenance (non-cuttable)

Detect a measurable received delta with no attribution (a #801 or legacy child) and flip the axis; relay it up like `usageComplete`.

**Files:**
- Modify: `lib/runtime/costTelemetry.ts` (marker message + sender)
- Modify: `lib/runtime/recordPaidUsage.ts` (`markModelAttributionIncompleteAt`)
- Modify: `lib/runtime/ipc.ts` (`accountChildUsageWithProvenance`, both receive handlers, dispatch case at ~`ipc.ts:1141`)
- Test: `lib/runtime/costTelemetry.test.ts`, `lib/runtime/ipc.test.ts`

**Interfaces:**
- Consumes: `isMeasurableDelta(delta)` from Task 1.
- Produces: `IpcModelAttributionIncompleteMessage = { type: "modelAttributionIncomplete" }`, `sendModelAttributionIncompleteToParent()`, `markModelAttributionIncompleteAt(ctx)`.

- [ ] **Step 1: Write the failing tests**

In `costTelemetry.test.ts`, import `sendModelAttributionIncompleteToParent` and mirror the existing `sendInvocationUsageIncompleteToParent` test so the new marker's upward relay is directly covered:

```ts
describe("sendModelAttributionIncompleteToParent", () => {
  it("sends the marker in IPC mode and no-ops otherwise", () => {
    const send = vi.fn(() => true);
    process.send = send as any;

    sendModelAttributionIncompleteToParent();
    expect(send).not.toHaveBeenCalled();

    vi.stubEnv("AGENCY_IPC", "1");
    sendModelAttributionIncompleteToParent();
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "modelAttributionIncomplete",
    });
  });
});
```

In the existing `handleInvocationUsageMessage` describe block in `ipc.test.ts`, reuse `makeUsageSession()`:

```ts
it("trips attribution incomplete on a #801 child delta with no attribution", () => {
  const { session, ctx } = makeUsageSession();
  handleInvocationUsageMessage(session, {
    type: "invocationUsage",
    pricedCost: 0.1,
    inputTokens: 1,
    outputTokens: 1,
    unknownCostCallCount: 0,
  });
  const { usage } = ctx.invocationUsage.snapshot();
  expect(usage.unattributed!.pricedCost).toBeCloseTo(0.1);
  expect(usage.modelAttributionComplete).toBe(false);
});

it("does NOT trip for an explicitly unattributed child charge", () => {
  const { session, ctx } = makeUsageSession();
  handleInvocationUsageMessage(session, {
    type: "invocationUsage",
    pricedCost: 0.05,
    inputTokens: 0,
    outputTokens: 0,
    unknownCostCallCount: 0,
    attribution: { kind: "unattributed" },
  });
  expect(ctx.invocationUsage.snapshot().usage.modelAttributionComplete).toBe(true);
});
```

In the existing legacy telemetry describe block, use `makeTelemetrySession(new StateStack())` and inspect its canonical session's meter:

```ts
it("trips on a legacy {costUsd} telemetry message with payable cost", () => {
  const { session } = makeTelemetrySession(new StateStack());
  handleTelemetryMessage(session, { type: "telemetry", costUsd: 0.05 });
  const { usage } = session.ctx.invocationUsage.snapshot();
  expect(usage.unattributed!.pricedCost).toBeCloseTo(0.05);
  expect(usage.modelAttributionComplete).toBe(false);
});
```

Finally, test receive dispatch using `makeUsageSession()`; combined with the direct sender test above, this pins both hops of marker propagation without constructing a real subprocess:

```ts
it("propagates a modelAttributionIncomplete marker through the dispatch entry point", async () => {
  const { session, ctx } = makeUsageSession();
  await handleChildMessage(session, { type: "modelAttributionIncomplete" });
  expect(ctx.invocationUsage.snapshot().usage.modelAttributionComplete).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/runtime/costTelemetry.test.ts lib/runtime/ipc.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`costTelemetry.ts`: `IpcModelAttributionIncompleteMessage`, `sendModelAttributionIncompleteToParent()`, add to `IpcUsageMessage` union (spec File 4).

`recordPaidUsage.ts`: add `markModelAttributionIncompleteAt(ctx)`, mirroring `markInvocationUsageIncompleteAt`. `isMeasurableDelta` already belongs to `invocationUsage.ts` from Task 1; import it where IPC performs provenance detection rather than redefining it here.

`ipc.ts`:
- Add `accountChildUsageWithProvenance(session, delta)`. In a block-bodied `if`, call `markModelAttributionIncompleteAt(session.ctx)` when `isMeasurableDelta(delta) && delta.attribution === undefined`, then call `accountChildUsage(session, delta)`.
- `handleInvocationUsageMessage`: route the normalized delta through `accountChildUsageWithProvenance`.
- `handleTelemetryMessage`: build the legacy delta (no attribution) and route it through `accountChildUsageWithProvenance` too (no special-casing — the same rule trips it).
- Add a block-bodied dispatch branch in `handleChildMessage` (`ipc.ts:1141` area) for `msg.type === "modelAttributionIncomplete"` that calls `markModelAttributionIncompleteAt(s.ctx)`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:run lib/runtime/costTelemetry.test.ts lib/runtime/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** — `feat(serve): modelAttributionComplete axis for provenance-missing subprocess spend`

---

### Task 5: Surface the breakdown on serve outcomes

**Files:**
- Verify (edit only on a type mismatch): `lib/serve/http/adapter.ts`
- Test: `lib/serve/http/serveCostSeam.integration.test.ts` (exists — extend)
- Test: `lib/serve/http/adapter.test.ts` (exists — add focused interrupt/resume pass-through coverage)

- [ ] **Step 1: Add focused outcome-path coverage**

In `serveCostSeam.integration.test.ts`, import `usageReconcileTolerance` and extend the existing real-meter success and throw tests. This file uses a hand-built served function—not a source-based node harness—so keep it focused on proving that actual `addCost` meter state reaches the adapter:

```ts
it("success carries a reconciled unattributed breakdown", async () => {
  setup();
  const result = await handlerFor(
    makeCtx(),
    () => {
      addCost(0.03);
      return "done";
    },
  )("POST", "/function/run", {});

  expect(result.usage!.unattributed!.pricedCost).toBeCloseTo(0.03);
  const modelCost = Object.values(result.usage!.models ?? {})
    .reduce((total, row) => total + row.pricedCost, 0);
  const attributedCost = modelCost + result.usage!.unattributed!.pricedCost;
  expect(Math.abs(attributedCost - result.usage!.pricedCost))
    .toBeLessThanOrEqual(usageReconcileTolerance(result.usage!.pricedCost));
  expect(result.usage!.modelAttributionComplete).toBe(true);
});

it("carries the breakdown on a thrown outcome", async () => {
  setup();
  const result = await handlerFor(makeCtx(), () => {
    addCost(0.02);
    throw new Error("kaboom");
  })("POST", "/function/run", {});

  expect(result.usage!.unattributed!.pricedCost).toBeCloseTo(0.02);
  expect(result.usage!.modelAttributionComplete).toBe(true);
});
```

In `adapter.test.ts`, use its existing `makeExports`, `makeInterrupt`, `returnedOutcome`, and `createHttpHandler` helpers to test the generic interrupt and resume branches with a synthetic populated snapshot. This is intentionally an adapter test: the feature does not change interrupt execution, while `serveCostSeam.integration.test.ts` above already proves real meter-to-adapter integration.

```ts
it("preserves the complete usage breakdown on interrupt and resume results", async () => {
  const breakdownUsage = {
    pricedCost: 0.03,
    inputTokens: 0,
    outputTokens: 0,
    unknownCostCallCount: 0,
    pricingComplete: true,
    models: {},
    unattributed: { pricedCost: 0.03, inputTokens: 0, outputTokens: 0 },
    modelAttributionComplete: true,
  };
  const pendingInterrupt = makeInterrupt("usage-interrupt");
  const pausedValue = { interrupts: [pendingInterrupt] };
  const { exports } = makeExports();
  const mainNode = exports.find((item) => item.kind === "node");
  if (!mainNode || mainNode.kind !== "node") {
    throw new Error("main node fixture missing");
  }
  mainNode.invokeServed = async () => returnedOutcome(pausedValue, {
    usage: breakdownUsage,
  });

  const handler = createHttpHandler({
    exports,
    logger: createLogger("error"),
    hasInterrupts: (data) => data === pausedValue,
    respondToInterrupts: async () => returnedOutcome(
      { data: "resumed" },
      { usage: breakdownUsage },
    ),
  });

  const paused = await handler("POST", "/node/main", {});
  expect(paused.usage).toEqual(breakdownUsage);

  const resumed = await handler("POST", "/resume", {
    interrupts: [pendingInterrupt],
    responses: [{ type: "approve" }],
  });
  expect(resumed.usage).toEqual(breakdownUsage);
});
```

- [ ] **Step 2: Run to verify the additive fields already flow through**

Run: `pnpm test:run lib/serve/http/serveCostSeam.integration.test.ts lib/serve/http/adapter.test.ts`
Expected: PASS after Tasks 1–4. This task intentionally tests an existing whole-object adapter seam; a failure indicates a real type or field-copy mismatch that Step 3 must fix.

- [ ] **Step 3: Implement / verify**

`withUsage` (`adapter.ts:133`) copies the whole `usage` object, so no edit is expected. If TypeScript flags the widened `usage` type on `RouteResult`, confirm that it still references `InvocationUsageSnapshot["usage"]`; do not add field-by-field adapter copying. The integration test proves a real meter snapshot, while the adapter test proves the unchanged generic node-interrupt and resume result paths preserve that object.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:run lib/serve/http/serveCostSeam.integration.test.ts lib/serve/http/adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** — `test(serve): preserve usage breakdown across serve outcomes`

---

### Task 6: Docs + full build + finish

**Files:**
- Modify: `docs/dev/hosted-agent-execution.md`
- Modify (only if it describes the delta shape): `docs/dev/async-context.md`

- [ ] **Step 1: Update `docs/dev/hosted-agent-execution.md`**

In the serve cost seam section, document: `models` + `unattributed`; the discriminated `attribution` on the delta/wire and why an optional scalar was insufficient; the `usageReconcileTolerance` relative+absolute contract and that the flat total is authoritative; the explicit accounting policy that discrepancies at or below `max(1e-9 USD, 1e-9 × |pricedCost|)` are accepted even if they could represent a real tiny omitted charge; the `$10,000` → `$0.00001` example; the three completeness axes (`pricingComplete` = price availability, `usageComplete` = telemetry delivery, `modelAttributionComplete` = model labels trustworthy) and how they differ; the model-identity precedence via `resolveCompletionModel`; and the host's "absent ≠ zero spend" rollout rule.

- [ ] **Step 2: Full typecheck/build**

Run: `make`
Expected: clean build (the one full typecheck — per-file vitest runs use esbuild and do not type-check).

- [ ] **Step 3: Commit** — `docs(dev): per-model cost breakdown on the serve cost seam`

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch. Base branch: `main`. Push and open a PR; the owner squash-merges.

---

## Self-review notes (author)

- **Spec coverage:** T1 → decisions 1,2,3 + invariant + reconciliation; T2 → decision 5 (identity helper) + model threading; T3 → attribution on the wire (send+receive); T4 → decision 4 (`modelAttributionComplete`, provenance rule); T5 → host surfacing + all outcomes; T6 → docs.
- **Review points closed:** blocking (discriminated `attribution`, T1/T3/T4); FP test now uses a verified regrouping sequence with `not.toBe` (T1); identity precedence tested directly via `resolveCompletionModel` (T2); real `makeCtx`/`makeUsageSession`/`makeTelemetrySession` fixtures used, including a real `StateStack` (T2/T3/T4); charge-attribution and incompleteness-marker send sides tested directly (T3/T4); interrupt+resume pass-through covered concretely in `adapter.test.ts`, while the real meter integration remains in `serveCostSeam.integration.test.ts` (T5); relative+absolute tolerance is an explicit product precision policy and the negative test fails at twice the named threshold (T1/T6); lint limits stated as enforced 1250/150 with the 1000/100 style target; commit trailer framed as the repo/environment convention.
- **Type consistency:** `UsageAttribution`, `attribution?`, `resolveCompletionModel`, `accountCompletionUsage(...,model)`, `IpcInvocationUsageMessage.attribution?`, `markModelAttributionIncomplete`/`markModelAttributionIncompleteAt`, `isMeasurableDelta`, `accountChildUsageWithProvenance`, `usageReconcileTolerance` are used identically across tasks.
- **Anti-pattern review closed:** the semantic predicate `isMeasurableDelta` is owned once in `invocationUsage.ts` and reused by meter bucketing and IPC provenance detection; new snippets use block-bodied conditionals, descriptive names, and multiline setup; imperative mutation remains encapsulated behind `recordPaidUsageAt` and `InvocationUsageMeter.merge`.
- **No codegen / no fixtures:** verified — `accountCompletionUsage` has one runtime caller and no template reference.
- **`modelAttributionComplete` is non-cuttable:** the #801 child (attribution-less `invocationUsage`) and the legacy `{costUsd}` handler are both live; the axis is the signal that a received delta lost its model.
