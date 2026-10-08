import { describe, it, expect } from "vitest";
import { RuntimeContext } from "./context.js";
import { FakeClock } from "../clock.js";
import { nodeHost } from "../../host/node/nodeHost.js";
import { resolveInvocation } from "../invocationOptions.js";
import type { Host } from "../../host/host.js";

function makeCtx(args: { host?: Host; clock?: FakeClock } = {}): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: { model: "default-model" },
    dirname: "/tmp",
    host: args.host,
    clock: args.clock,
  });
}

describe("RuntimeContext.host", () => {
  it("is a nodeHost when none is given", () => {
    const ctx = makeCtx();
    expect(ctx.host.name).toBe("node");
    expect(ctx.host.capabilities).toContain("fileRead");
  });

  it("keeps the host it is given", () => {
    const host = nodeHost({ capabilities: ["terminal"] });
    expect(makeCtx({ host }).host).toBe(host);
  });

  it("a clock argument replaces only the clock of the host", () => {
    const host = nodeHost({ capabilities: ["terminal"] });
    const clock = new FakeClock();
    const ctx = makeCtx({ host, clock });
    expect(ctx.host).not.toBe(host);
    expect(ctx.clock).toBe(clock);
    expect(ctx.host.clock).toBe(clock);
    expect(ctx.host.capabilities).toEqual(["terminal"]);
    expect(ctx.host.system).toBe(host.system);
  });

  it("an execution context has its parent's host", async () => {
    const host = nodeHost({ capabilities: ["env"] });
    const ctx = makeCtx({ host });
    const execCtx = await ctx.createExecutionContext({ runId: "r1" });
    expect(execCtx.host).toBe(host);
    expect(execCtx.clock).toBe(host.clock);
  });
});

describe("a host for one invocation", () => {
  it("a run given a host through InvocationOptions uses it", async () => {
    const ctx = makeCtx();
    const host = nodeHost({ capabilities: ["terminal"] });
    const resolved = resolveInvocation({ kind: "fresh", options: { host } });
    const execCtx = await ctx.createExecutionContext(resolved);
    expect(execCtx.host).toBe(host);
  });

  it("a second run with no host uses the default", async () => {
    const ctx = makeCtx();
    const host = nodeHost({ capabilities: ["terminal"] });
    await ctx.createExecutionContext(resolveInvocation({ kind: "fresh", options: { host } }));
    const second = await ctx.createExecutionContext(resolveInvocation({ kind: "fresh" }));
    expect(second.host).toBe(ctx.host);
    expect(second.host.name).toBe("node");
  });

  it("a resume keeps the host passed at resume", async () => {
    const ctx = makeCtx();
    const host = nodeHost({ capabilities: ["env"] });
    const resolved = resolveInvocation({ kind: "resume", runId: "r2", options: { host } });
    expect(resolved.host).toBe(host);
    const execCtx = await ctx.createExecutionContext(resolved);
    expect(execCtx.host).toBe(host);
    expect(execCtx.runId).toBe("r2");
  });
});
