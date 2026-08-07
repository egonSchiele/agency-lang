import { describe, it, expect } from "vitest";
import { RuntimeContext } from "./context.js";

// The per-invocation override reaches a run through createExecutionContext: the
// resolver has already projected the allow-list into `contextOverride`, and this
// method applies it over the frozen parent for that one child only.
function makeParent() {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://base",
      apiKey: "base-key",
      projectId: "base-proj",
      debugMode: false,
      observability: false,
    },
    smoltalkDefaults: {},
    dirname: "/project",
    budget: { maxCost: 5, maxTimeMs: 60_000 },
    maxCallDepth: 100,
    failurePropagation: "on",
  });
}

describe("createExecutionContext per-invocation override", () => {
  it("applies the override to this child only, override-wins per field", async () => {
    const parent = makeParent();
    const overridden = await parent.createExecutionContext({
      runId: "overridden-run",
      contextOverride: {
        budget: { maxCost: 1 },
        maxCallDepth: 10,
        failurePropagation: "off",
      },
    });

    expect(overridden.getRunId()).toBe("overridden-run");
    // maxCost overridden; parent's maxTimeMs retained (the merge layers budget).
    expect(overridden.budget).toEqual({ maxCost: 1, maxTimeMs: 60_000 });
    expect(overridden.maxCallDepth).toBe(10);
    expect(overridden.failurePropagation).toBe("off");
  });

  it("leaves a child without an override at the frozen parent values", async () => {
    const parent = makeParent();
    const base = await parent.createExecutionContext({ runId: "base-run" });

    expect(base.getRunId()).toBe("base-run");
    expect(base.budget).toEqual({ maxCost: 5, maxTimeMs: 60_000 });
    expect(base.maxCallDepth).toBe(100);
    expect(base.failurePropagation).toBe("on");
  });

  it("does not mutate the parent when a child overrides", async () => {
    const parent = makeParent();
    await parent.createExecutionContext({
      runId: "overridden-run",
      contextOverride: { budget: { maxCost: 1 }, maxCallDepth: 10 },
    });

    expect(parent.budget).toEqual({ maxCost: 5, maxTimeMs: 60_000 });
    expect(parent.maxCallDepth).toBe(100);
  });

  // A subprocess spawned by this run inherits its telemetry sink via
  // getStatelogSink() → withParentStatelog. So the effective per-invocation sink
  // (host/apiKey/projectId) must be visible there, not the frozen parent's.
  it("exposes the per-invocation remote sink through getStatelogSink", async () => {
    const parent = makeParent();
    const execCtx = await parent.createExecutionContext({
      runId: "run",
      contextOverride: {
        observability: true,
        log: { host: "https://call", apiKey: "call-key", projectId: "call-proj" },
      },
    });

    expect(execCtx.getStatelogSink()).toEqual({
      observability: true,
      host: "https://call",
      apiKey: "call-key",
      projectId: "call-proj",
    });
  });
});
