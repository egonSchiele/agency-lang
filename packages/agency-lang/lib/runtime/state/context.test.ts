import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeContext } from "./context.js";
import { StateStack } from "./stateStack.js";
import { AgencyCancelledError } from "../errors.js";
import { _resetStoreRegistry, MemoryFrame } from "../memory/index.js";

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

describe("RuntimeContext memory frames", () => {
  let tmpRoot: string;
  let dirA: string;
  let dirB: string;
  let dirJson: string;

  beforeEach(() => {
    _resetStoreRegistry();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ctxmem-"));
    dirA = path.join(tmpRoot, "a");
    dirB = path.join(tmpRoot, "b");
    dirJson = path.join(tmpRoot, "json");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    fs.mkdirSync(dirJson);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    _resetStoreRegistry();
  });

  function makeCtx(memory?: { dir: string }) {
    return new RuntimeContext({
      statelogConfig: {
        host: "https://example.com",
        apiKey: "test-api-key",
        projectId: "test-project",
        debugMode: false,
      },
      smoltalkDefaults: {},
      dirname: tmpRoot,
      memory,
    });
  }

  it("getActiveMemoryManager() returns undefined when nothing is configured", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    expect(execCtx.getActiveMemoryManager()).toBeUndefined();
  });

  it("returns a JSON-seeded manager when only agency.json is set", async () => {
    const ctx = makeCtx({ dir: dirJson });
    const execCtx = await ctx.createExecutionContext("r1");
    const m = execCtx.getActiveMemoryManager();
    expect(m).toBeDefined();
  });

  it("frame push overrides JSON; pop returns to JSON manager (same instance)", async () => {
    const ctx = makeCtx({ dir: dirJson });
    const execCtx = await ctx.createExecutionContext("r1");
    const jsonManager = execCtx.getActiveMemoryManager();
    expect(jsonManager).toBeDefined();

    execCtx.stateStack.pushMemoryFrame(new MemoryFrame({ dir: dirA }));
    const aManager = execCtx.getActiveMemoryManager();
    expect(aManager).toBeDefined();
    expect(aManager).not.toBe(jsonManager);

    execCtx.stateStack.popMemoryFrame();
    expect(execCtx.getActiveMemoryManager()).toBe(jsonManager);
  });

  it("manager cache survives push/pop/push (pop back returns the cached A)", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    execCtx.stateStack.pushMemoryFrame(new MemoryFrame({ dir: dirA }));
    const a1 = execCtx.getActiveMemoryManager();

    execCtx.stateStack.pushMemoryFrame(new MemoryFrame({ dir: dirB }));
    const b = execCtx.getActiveMemoryManager();
    expect(b).not.toBe(a1);

    execCtx.stateStack.popMemoryFrame();
    const a2 = execCtx.getActiveMemoryManager();
    expect(a2).toBe(a1);
  });

  it("re-seeds the JSON bottom frame when restoring an old checkpoint without memoryFrames", async () => {
    const ctx = makeCtx({ dir: dirJson });
    const execCtx = await ctx.createExecutionContext("r1");

    // Simulate an old-format stateStack: has `other.memoryId` but no
    // `other.memoryFrames` (predates this feature).
    const stack = new StateStack();
    stack.other.memoryId = "alice";
    execCtx.stateStack = stack;

    const m = execCtx.getActiveMemoryManager();
    expect(m).toBeDefined();
    expect(execCtx.stateStack.activeMemoryFrame()?.configKey).toBe(
      fs.realpathSync(dirJson),
    );
  });

  it("returns undefined after the user pops the JSON-seeded bottom frame", async () => {
    // Per plan resolved decision (Gap 5): disableMemory() pops
    // whatever is on top, including the JSON-seeded bottom frame.
    // Memory then goes off until the next enableMemory(). The
    // old-checkpoint re-seed deliberately does NOT fire after an
    // explicit pop — `popMemoryFrame` leaves an empty array on the
    // stack so we can distinguish "never set" from "explicitly
    // emptied."
    const ctx = makeCtx({ dir: dirJson });
    const execCtx = await ctx.createExecutionContext("r1");
    expect(execCtx.getActiveMemoryManager()).toBeDefined();

    execCtx.stateStack.popMemoryFrame();
    expect(execCtx.getActiveMemoryManager()).toBeUndefined();
  });
});
