import { describe, it, expect, afterEach } from "vitest";
import { createHttpHandler } from "./adapter.js";
import { createLogger } from "../../logger.js";
import { RuntimeContext } from "../../runtime/state/context.js";
import { runExportedFunctionForServe } from "../../runtime/node.js";
import { addCost } from "../../runtime/cost.js";
import { returnedOutcome, unusedPublicInvoke } from "../testOutcome.js";
import { usageReconcileTolerance } from "../../runtime/invocationUsage.js";
import type { GraphState } from "../../runtime/types.js";
import type { AgencyFunction } from "../../runtime/agencyFunction.js";
import type { ServedExportedFunction } from "../types.js";

// End-to-end usage accounting through the REAL HTTP adapter + the real
// runExportedFunctionForServe core. Priced work is a fake `addCost` charge (the
// same billCharge path an LLM completion uses) so no live model is needed. The
// compiled-module + real-LLM path (and subprocess/grandchild propagation) are
// covered by functionFrame.integration (CI) and the ipc / invocationUsage unit
// tests; this file pins the cross-cutting adapter-level properties.
describe("serve cost seam — end to end", () => {
  const BUDGET_ENV = ["AGENCY_IPC", "AGENCY_MAX_COST", "AGENCY_MAX_TIME"] as const;
  const saved: Record<string, string | undefined> = {};
  const setup = () =>
    BUDGET_ENV.forEach((k) => {
      saved[k] = process.env[k];
      delete process.env[k];
    });
  afterEach(() =>
    BUDGET_ENV.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }),
  );

  function makeCtx(budget?: { maxCost?: number; maxTimeMs?: number }) {
    return new RuntimeContext<GraphState>({
      statelogConfig: {
        host: "",
        apiKey: "",
        projectId: "",
        debugMode: false,
        observability: false,
      },
      smoltalkDefaults: {},
      dirname: process.cwd(),
      budget,
    });
  }

  function servedFunction(
    ctx: RuntimeContext<GraphState>,
    body: () => unknown,
  ): ServedExportedFunction {
    const fn = { invoke: async () => body() } as unknown as AgencyFunction;
    return {
      kind: "function",
      ...unusedPublicInvoke,
      name: "run",
      description: "run",
      parameters: [],
      agencyFunction: fn,
      interruptEffects: [],
      invokeServed: (namedArgs) => runExportedFunctionForServe({ ctx, fn, namedArgs }),
    };
  }

  function handlerFor(ctx: RuntimeContext<GraphState>, body: () => unknown) {
    return createHttpHandler({
      exports: [servedFunction(ctx, body)],
      logger: createLogger("error"),
      hasInterrupts: () => false,
      respondToInterrupts: async () => returnedOutcome({ data: undefined }),
    });
  }

  it("success carries the exact priced cost and reads complete", async () => {
    setup();
    const result = await handlerFor(makeCtx(), () => {
      addCost(0.03);
      return "done";
    })("POST", "/function/run", {});
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true, value: "done" });
    expect(result.usage?.cost.totalCost).toBeCloseTo(0.03);
    expect(result.usage?.pricingComplete).toBe(true);
    expect(result.usageComplete).toBe(true);
  });

  it("success carries a reconciled manual breakdown (addCost has model '')", async () => {
    setup();
    const result = await handlerFor(makeCtx(), () => {
      addCost(0.03);
      return "done";
    })("POST", "/function/run", {});
    // addCost is a manual charge, so it lands in a single manual entry (model "").
    expect(result.usage?.entries).toHaveLength(1);
    expect(result.usage?.entries[0]).toMatchObject({ kind: "manual", model: "" });
    expect(result.usage?.entries[0].cost.totalCost).toBeCloseTo(0.03);
    const attributed = result.usage!.entries.reduce(
      (total, entry) => total + entry.cost.totalCost,
      0,
    );
    expect(Math.abs(attributed - result.usage!.cost.totalCost)).toBeLessThanOrEqual(
      usageReconcileTolerance(result.usage!.cost.totalCost),
    );
  });

  it("two concurrent invocations report independent usage (own execCtx each)", async () => {
    setup();
    const cheap = handlerFor(makeCtx(), () => {
      addCost(0.01);
      return "a";
    })("POST", "/function/run", {});
    const dear = handlerFor(makeCtx(), () => {
      addCost(0.5);
      return "b";
    })("POST", "/function/run", {});
    const [a, b] = await Promise.all([cheap, dear]);
    expect(a.usage?.cost.totalCost).toBeCloseTo(0.01);
    expect(b.usage?.cost.totalCost).toBeCloseTo(0.5);
  });

  it("a function that spends then throws still reports the pre-throw cost", async () => {
    setup();
    const result = await handlerFor(makeCtx(), () => {
      addCost(0.02);
      throw new Error("kaboom");
    })("POST", "/function/run", {});
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: false, error: "Tool execution failed" });
    expect(result.usage?.cost.totalCost).toBeCloseTo(0.02);
    // The breakdown is not dropped on the error path.
    expect(result.usage?.entries[0]?.cost.totalCost).toBeCloseTo(0.02);
    expect(result.usageComplete).toBe(true);
  });

  it("a baked budget trip returns 402 carrying the cost up to the trip", async () => {
    setup();
    const result = await handlerFor(makeCtx({ maxCost: 0 }), () => {
      addCost(1);
      return "x";
    })("POST", "/function/run", {});
    expect(result.status).toBe(402);
    expect(result.body).toMatchObject({ code: "budgetExceeded", dimension: "cost", limit: 0 });
    expect(result.usage?.cost.totalCost).toBeCloseTo(1);
  });

  it("/list carries no usage (no invocation started)", async () => {
    setup();
    const result = await handlerFor(makeCtx(), () => "x")("GET", "/list", undefined);
    expect(result.usage).toBeUndefined();
    expect(result.usageComplete).toBeUndefined();
  });
});
