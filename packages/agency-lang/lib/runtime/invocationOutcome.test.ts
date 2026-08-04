import { describe, it, expect, vi } from "vitest";
import {
  runExportedFunction,
  runExportedFunctionForServe,
  runNodeForServe,
} from "./node.js";
import { finishServedInvocation } from "./servedInvocationLifecycle.js";
import { RuntimeContext } from "./state/context.js";
import { AgencyCancelledError } from "./errors.js";
import { addCost } from "./cost.js";
import type { GraphState } from "./types.js";
import type { AgencyFunction } from "./agencyFunction.js";

function makeCtx(budget?: { maxCost?: number; maxTimeMs?: number }) {
  return new RuntimeContext<GraphState>({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: "/project",
    budget,
  });
}

/** A minimal exported function whose body runs `body` and returns its value. */
function fakeFn(body: () => unknown | Promise<unknown>): AgencyFunction {
  return { invoke: async () => body() } as unknown as AgencyFunction;
}

describe("runExportedFunctionForServe outcomes", () => {
  it.each([
    ["an object", { a: 1 }],
    ["a primitive string", "hello"],
    ["a number", 42],
    ["undefined", undefined],
  ])("returns a returned-outcome for %s, with a usage snapshot", async (_label, value) => {
    const outcome = await runExportedFunctionForServe({ ctx: makeCtx(), fn: fakeFn(() => value), namedArgs: {} });
    expect(outcome.status).toBe("returned");
    if (outcome.status === "returned") expect(outcome.value).toEqual(value);
    expect(outcome.usage).toMatchObject({ pricedCost: 0, pricingComplete: true });
    expect(outcome.usageComplete).toBe(true);
  });

  it.each([
    ["an Error", new Error("boom")],
    ["a string", "thrown-string"],
    ["a frozen object", Object.freeze({ code: "E" })],
  ])("returns a threw-outcome preserving the identical error: %s", async (_label, err) => {
    const outcome = await runExportedFunctionForServe({
      ctx: makeCtx(),
      fn: fakeFn(() => { throw err; }),
      namedArgs: {},
    });
    expect(outcome.status).toBe("threw");
    if (outcome.status === "threw") expect(outcome.error).toBe(err);
    expect(outcome.usage).toBeDefined();
  });

  it("a budget trip yields a threw-outcome carrying the cost incurred up to the trip", async () => {
    const outcome = await runExportedFunctionForServe({
      ctx: makeCtx({ maxCost: 0 }),
      fn: fakeFn(() => { addCost(1); return "unreached"; }),
      namedArgs: {},
    });
    expect(outcome.status).toBe("threw");
    expect(outcome.usage.pricedCost).toBeCloseTo(1);
  });
});

describe("runExportedFunction (public compatibility)", () => {
  it("returns the raw value", async () => {
    await expect(runExportedFunction({ ctx: makeCtx(), fn: fakeFn(() => "x"), namedArgs: {} })).resolves.toBe("x");
  });

  it("throws the identical original error", async () => {
    const err = new Error("orig");
    await expect(
      runExportedFunction({ ctx: makeCtx(), fn: fakeFn(() => { throw err; }), namedArgs: {} }),
    ).rejects.toBe(err);
  });
});

describe("runNodeForServe lifecycle boundary", () => {
  it("an already-aborted signal yields a threw-outcome with usage (context existed)", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runNodeForServe({
      ctx: makeCtx(),
      nodeName: "main",
      data: {},
      abortSignal: controller.signal,
    });
    expect(outcome.status).toBe("threw");
    if (outcome.status === "threw") expect(outcome.error).toBeInstanceOf(AgencyCancelledError);
    expect(outcome.usage).toBeDefined();
  });
});

describe("finishServedInvocation cleanup semantics", () => {
  it("a cleanup failure after success becomes the outcome error", async () => {
    const ctx = makeCtx();
    const cleanupErr = new Error("cleanup boom");
    const outcome = await finishServedInvocation(
      ctx,
      { status: "returned", value: "ok" },
      async () => { throw cleanupErr; },
    );
    expect(outcome.status).toBe("threw");
    if (outcome.status === "threw") expect(outcome.error).toBe(cleanupErr);
  });

  it("a cleanup failure after an execution error keeps the FIRST error and logs the cleanup one", async () => {
    const ctx = makeCtx();
    const firstErr = new Error("execution error");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outcome = await finishServedInvocation(
      ctx,
      { status: "threw", error: firstErr },
      async () => { throw new Error("cleanup boom"); },
    );
    expect(outcome.status).toBe("threw");
    if (outcome.status === "threw") expect(outcome.error).toBe(firstErr);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("snapshots usage AFTER cleanup (cleanup-incurred paid work counts)", async () => {
    const ctx = makeCtx();
    const outcome = await finishServedInvocation(
      ctx,
      { status: "returned", value: "ok" },
      async () => { ctx.invocationUsage.merge({ pricedCost: 0.5, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 0 }); },
    );
    expect(outcome.usage.pricedCost).toBeCloseTo(0.5);
  });
});
