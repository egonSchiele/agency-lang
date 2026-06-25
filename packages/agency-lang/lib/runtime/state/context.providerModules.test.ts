import { describe, it, expect } from "vitest";
import { RuntimeContext } from "./context.js";

function baseArgs() {
  return {
    statelogConfig: { host: "", projectId: "", apiKey: "", traceId: "t" },
    smoltalkDefaults: {},
  };
}

describe("RuntimeContext.providerModules", () => {
  it("defaults to [] when not provided", () => {
    const ctx = new RuntimeContext({ ...baseArgs(), dirname: "/x" });
    expect(ctx.providerModules).toEqual([]);
  });

  it("stores the configured paths", () => {
    const ctx = new RuntimeContext({
      ...baseArgs(),
      dirname: "/x",
      providerModules: ["./a.mjs"],
    });
    expect(ctx.providerModules).toEqual(["./a.mjs"]);
  });

  it("copies providerModules onto a child execution context", async () => {
    const ctx = new RuntimeContext({
      ...baseArgs(),
      dirname: "/x",
      providerModules: ["./a.mjs"],
    });
    const child = await ctx.createExecutionContext("run-1");
    expect(child.providerModules).toEqual(["./a.mjs"]);
  });
});
