import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHttpHandler } from "./adapter.js";
import { createLogger } from "../../logger.js";
import { RuntimeContext } from "../../runtime/state/context.js";
import { runExportedFunctionForServe } from "../../runtime/node.js";
import { returnedOutcome, unusedPublicInvoke } from "../testOutcome.js";
import { addCost } from "../../runtime/cost.js";
import { AbortedResult } from "../../runtime/abortedResult.js";
import { AgencyCancelledError, makeAbortCause } from "../../runtime/errors.js";
import { State } from "../../runtime/state/stateStack.js";
import type { GraphState } from "../../runtime/types.js";
import type { AgencyFunction } from "../../runtime/agencyFunction.js";
import type { ServedExportedFunction } from "../types.js";

function makeCtx(budget?: { maxCost?: number; maxTimeMs?: number }): RuntimeContext<GraphState> {
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

/**
 * Regression test for the root budget on the *served-function* path.
 *
 * Only `runNode` used to install the root cost/time budget; a served
 * `POST /function/:name` ran through `runExportedFunction`, which built a
 * fresh execution context but never installed the guard — so a served
 * function ran uncapped. The fix hoists `installRootBudget` (and the run
 * policy handler) into the shared `initFreshExecCtx` bootstrap, so both
 * fresh-run entry points cap identically.
 *
 * This drives a real `runExportedFunction` through the actual HTTP adapter.
 * The function charges $1 via `addCost` (the exact sequence the built-in
 * `llm()` path runs after a completion); with a baked `maxCost: 0` budget
 * that charge must trip the root guard and surface as the typed 402
 * `budgetExceeded`. Before the fix nothing was installed, so the charge did
 * not trip and the call returned 200.
 */
describe("a served function respects the baked root budget", () => {
  // installRootBudget consults the environment: AGENCY_IPC makes it a no-op (a
  // child's budget is the parent's), and AGENCY_MAX_COST / AGENCY_MAX_TIME
  // OVERRIDE ctx.budget (the flag wins). Any of these, set by the dev shell or
  // leaked from another test, would flake these assertions (the limit wouldn't
  // be 0, or the "no baked budget" control would still be capped). Snapshot and
  // clear all three around each test, then restore.
  const BUDGET_ENV = ["AGENCY_IPC", "AGENCY_MAX_COST", "AGENCY_MAX_TIME"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of BUDGET_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of BUDGET_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // A minimal exported function whose body charges $1, routed through the real
  // runExportedFunction so it runs inside a node-grade frame with the budget
  // installed.
  function spendingFunction(ctx: RuntimeContext<GraphState>): ServedExportedFunction {
    const fn = {
      invoke: async () => {
        addCost(1);
        return "done";
      },
    } as unknown as AgencyFunction;
    return {
      kind: "function",
      ...unusedPublicInvoke,
      name: "spend",
      description: "charges $1",
      parameters: [],
      agencyFunction: fn,
      interruptEffects: [],
      invokeServed: (namedArgs) => runExportedFunctionForServe({ ctx, fn, namedArgs }),
    };
  }

  function handlerFor(ctx: RuntimeContext<GraphState>): ReturnType<typeof createHttpHandler> {
    return createHttpHandler({
      exports: [spendingFunction(ctx)],
      logger: createLogger("error"),
      hasInterrupts: () => false,
      respondToInterrupts: async () => returnedOutcome({ data: undefined }),
    });
  }

  it("trips the root budget and returns a typed 402 budgetExceeded", async () => {
    const result = await handlerFor(makeCtx({ maxCost: 0 }))("POST", "/function/spend", {});
    expect(result.status).toBe(402);
    expect(result.body).toMatchObject({
      success: false,
      code: "budgetExceeded",
      dimension: "cost",
      limit: 0,
      spent: 1,
    });
  });

  it("without a baked budget the same spend runs uncapped (200) — proving the guard is what caps it", async () => {
    const result = await handlerFor(makeCtx())("POST", "/function/spend", {});
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true, value: "done" });
  });
});

/**
 * Issue #807: the same trip, arriving as a VALUE rather than a throw.
 *
 * Compiled Agency code catches an abort in its own frame and returns an
 * `AbortedResult`, so a guard trip can reach the serve adapter as a return
 * value. The adapter classifies by cause on a *thrown* error, so such a trip
 * skipped the 402 branch entirely and came back as `200 { success: true }`
 * with the abort buried in `value` — a caller could not tell a budget-halted
 * run from a completed one. `runExportedFunctionCore` now converts at the
 * boundary (#906).
 *
 * The test above cannot catch this: its `invoke` throws, so it takes the
 * classification branch either way.
 */
describe("a served function surfaces a budget trip that arrives as a value", () => {
  function abortingFunction(ctx: RuntimeContext<GraphState>): ServedExportedFunction {
    const cause = makeAbortCause({
      kind: "guardTrip",
      dimension: "cost",
      limit: 0.01,
      spent: 0.05,
      guardId: "root",
    });
    // Exactly what a compiled def hands back when an abort stops it.
    const fn = {
      invoke: async () =>
        AbortedResult.fromError(new AgencyCancelledError("trip", cause), new State(), "chargeFn"),
    } as unknown as AgencyFunction;
    return {
      kind: "function",
      ...unusedPublicInvoke,
      name: "chargeFn",
      description: "returns an aborted result",
      parameters: [],
      agencyFunction: fn,
      interruptEffects: [],
      invokeServed: (namedArgs) => runExportedFunctionForServe({ ctx, fn, namedArgs }),
    };
  }

  it("returns a typed 402, not 200 with an abortedResult body", async () => {
    const handler = createHttpHandler({
      exports: [abortingFunction(makeCtx())],
      logger: createLogger("error"),
      hasInterrupts: () => false,
      respondToInterrupts: async () => returnedOutcome({ data: undefined }),
    });
    const result = await handler("POST", "/function/chargeFn", {});
    expect(result.status).toBe(402);
    expect(result.body).toMatchObject({
      success: false,
      code: "budgetExceeded",
      dimension: "cost",
      limit: 0.01,
      spent: 0.05,
    });
  });
});
