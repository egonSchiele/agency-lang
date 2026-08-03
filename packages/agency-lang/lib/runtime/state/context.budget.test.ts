import { describe, it, expect } from "vitest";
import { RuntimeContext } from "./context.js";

// Regression guard for the RuntimeContext → execCtx handoff: installRootBudget
// reads `execCtx.budget`, and createExecutionContext copies fields one by one.
// If `budget` is not copied, the whole config/override budget is a silent no-op.
function makeContext(budget?: { maxCost?: number; maxTimeMs?: number }) {
  return new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: "/project",
    budget,
  });
}

describe("createExecutionContext budget propagation", () => {
  it("copies the resolved budget onto the execution context", async () => {
    const execCtx = await makeContext({ maxCost: 0.5, maxTimeMs: 1000 }).createExecutionContext("run-1");
    expect(execCtx.budget).toEqual({ maxCost: 0.5, maxTimeMs: 1000 });
  });

  it("leaves budget undefined when none is configured", async () => {
    const execCtx = await makeContext().createExecutionContext("run-2");
    expect(execCtx.budget).toBeUndefined();
  });
});
