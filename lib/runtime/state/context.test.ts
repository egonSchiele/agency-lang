import { describe, it, expect } from "vitest";
import { RuntimeContext } from "./context.js";
import { AgencyCancelledError } from "../errors.js";

function makeMockCtx() {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: {},
    dirname: "/tmp",
  });
}

describe("RuntimeContext", () => {
  it("should initialize debugger field as null", () => {
    const ctx = makeMockCtx();
    expect(ctx.debuggerState).toBeNull();
  });

  describe("abort / cancel", () => {
    it("should initialize with a fresh AbortController", () => {
      const ctx = makeMockCtx();
      expect(ctx.abortController).toBeInstanceOf(AbortController);
      expect(ctx.aborted).toBe(false);
    });

    it("cancel() should abort the controller", () => {
      const ctx = makeMockCtx();
      ctx.cancel();
      expect(ctx.aborted).toBe(true);
      expect(ctx.abortController.signal.aborted).toBe(true);
    });

    it("cancel() should set an AgencyCancelledError as the abort reason", () => {
      const ctx = makeMockCtx();
      ctx.cancel("user stop");
      expect(ctx.abortController.signal.reason).toBeInstanceOf(
        AgencyCancelledError,
      );
      expect(ctx.abortController.signal.reason.message).toBe("user stop");
    });

    it("cancel() should be idempotent", () => {
      const ctx = makeMockCtx();
      ctx.cancel("first");
      ctx.cancel("second");
      expect(ctx.abortController.signal.reason.message).toBe("first");
    });

    it("createExecutionContext should get a fresh AbortController", async () => {
      const ctx = makeMockCtx();
      const execCtx = await ctx.createExecutionContext("foo");
      expect(execCtx.abortController).toBeInstanceOf(AbortController);
      expect(execCtx.abortController).not.toBe(ctx.abortController);
      expect(execCtx.aborted).toBe(false);
    });

    it("cleanup() should abort the controller", () => {
      const ctx = makeMockCtx();
      expect(ctx.aborted).toBe(false);
      ctx.cleanup();
      expect(ctx.abortController.signal.aborted).toBe(true);
    });
  });
});
