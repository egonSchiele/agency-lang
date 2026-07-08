import { describe, it, expect } from "vitest";
import { runInTestContext } from "../runtime/asyncContext.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import {
  _tag,
  _setTags,
  _getTags,
  _redact,
  _removeTag,
  _removeAllTags,
} from "./tag.js";

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
  it("tags and reads back a primitive by value; _tag returns current tags", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      expect(_tag("secret", "color", "blue")).toEqual({ color: "blue" });
      expect(_getTags("secret")).toEqual({ color: "blue" });
      expect(_getTags("other")).toEqual({});
    });
  });

  it("setTags merges multiple tags; removeTag/removeAllTags return remaining", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      expect(_setTags("v", { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
      expect(_removeTag("v", "a")).toEqual({ b: 2 });
      expect(_removeAllTags("v")).toEqual({});
      expect(_getTags("v")).toEqual({});
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

  it("redact() sets redact:true (via GlobalStore.markRedacted) and returns tags", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      expect(_redact("sk-1")).toEqual({ redact: true });
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

  it("throws outside an Agency frame (stdlib helpers require the active branch)", () => {
    // These helpers use getRuntimeContext(), the documented strict accessor, so
    // calling them with no active branch surfaces a clear error rather than
    // silently writing into a discarded store.
    expect(() => _tag("x", "a", 1)).toThrow();
    expect(() => _getTags("x")).toThrow();
  });
});
