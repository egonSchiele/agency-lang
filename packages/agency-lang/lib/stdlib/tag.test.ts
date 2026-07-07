import { describe, it, expect } from "vitest";
import { runInTestContext } from "../runtime/asyncContext.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import { _tag, _getTags, _redact } from "./tag.js";

function makeCtx() {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
      observability: true,
    },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
}

describe("std::tag TS helpers", () => {
  it("tags and reads back a primitive by value", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      _tag("secret", "color", "blue");
      expect(_getTags("secret")).toEqual({ color: "blue" });
      expect(_getTags("other")).toEqual({});
    });
  });

  it("tags an object by reference", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      const o = { id: 1 };
      _tag(o, "source", "upload");
      expect(_getTags(o)).toEqual({ source: "upload" });
      expect(_getTags({ id: 1 })).toEqual({}); // distinct reference
    });
  });

  it("redact() sets redact:true (via GlobalStore.markRedacted)", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      _redact("sk-1");
      expect(_getTags("sk-1")).toEqual({ redact: true });
      expect(execCtx.globals.isRedacted("sk-1")).toBe(true);
    });
  });

  it("_getTags returns a copy, not the live store object", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      _tag("k", "a", 1);
      const t = _getTags("k");
      (t as Record<string, unknown>)["a"] = 999;
      expect(_getTags("k")).toEqual({ a: 1 });
    });
  });

  it("_tag is a no-op outside an Agency frame", () => {
    expect(() => _tag("x", "a", 1)).not.toThrow();
    expect(_getTags("x")).toEqual({});
  });
});
