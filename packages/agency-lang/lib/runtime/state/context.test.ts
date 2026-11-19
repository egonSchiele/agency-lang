import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeContext } from "./context.js";
import { Checkpoint } from "./checkpointStore.js";
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

describe("trace id minting", () => {
  afterEach(() => {
    delete process.env.AGENCY_TRACE_ID;
  });

  it("takes the trace id from AGENCY_TRACE_ID when none is explicit", () => {
    process.env.AGENCY_TRACE_ID = "trace-from-env";
    expect((makeMockCtx() as any).statelogConfig.traceId).toBe("trace-from-env");
  });

  it("an explicit traceId beats the env var", () => {
    process.env.AGENCY_TRACE_ID = "trace-from-env";
    const ctx = new RuntimeContext({
      statelogConfig: {
        host: "https://example.com",
        apiKey: "test-api-key",
        projectId: "test-project",
        debugMode: false,
        traceId: "explicit-trace",
      },
      smoltalkDefaults: {},
      dirname: "/tmp",
    });
    expect((ctx as any).statelogConfig.traceId).toBe("explicit-trace");
  });
});

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
      expect(ctx.abortController.signal.reason).toBeInstanceOf(AgencyCancelledError);
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
      const execCtx = await ctx.createExecutionContext({ runId: "foo" });
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

  describe("background jobs", () => {
    it("each execution context starts holding no jobs, in a list of its own", async () => {
      const ctx = makeMockCtx();
      ctx.heldJobs.push({
        handle: { id: "job-000001", kind: "shell", label: "x", startedAt: 0 },
        read: { stdout: 0, stderr: 0 },
        finalRead: false,
      });
      const execCtx = await ctx.createExecutionContext({ runId: "foo" });
      expect(execCtx.heldJobs).toEqual([]);
      expect(execCtx.startingJobs).toBe(0);
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
    const execCtx = await ctx.createExecutionContext({ runId: "r1" });
    expect(execCtx.getActiveMemoryManager(execCtx.stateStack)).toBeUndefined();
  });

  it("returns a JSON-seeded manager when only agency.json is set", async () => {
    const ctx = makeCtx({ dir: dirJson });
    const execCtx = await ctx.createExecutionContext({ runId: "r1" });
    const m = execCtx.getActiveMemoryManager(execCtx.stateStack);
    expect(m).toBeDefined();
  });

  it("frame push overrides JSON; pop returns to JSON manager (same instance)", async () => {
    const ctx = makeCtx({ dir: dirJson });
    const execCtx = await ctx.createExecutionContext({ runId: "r1" });
    const jsonManager = execCtx.getActiveMemoryManager(execCtx.stateStack);
    expect(jsonManager).toBeDefined();

    execCtx.stateStack.pushMemoryFrame(new MemoryFrame({ dir: dirA }, execCtx.host));
    const aManager = execCtx.getActiveMemoryManager(execCtx.stateStack);
    expect(aManager).toBeDefined();
    expect(aManager).not.toBe(jsonManager);

    execCtx.stateStack.popMemoryFrame();
    expect(execCtx.getActiveMemoryManager(execCtx.stateStack)).toBe(jsonManager);
  });

  it("manager cache survives push/pop/push (pop back returns the cached A)", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext({ runId: "r1" });
    execCtx.stateStack.pushMemoryFrame(new MemoryFrame({ dir: dirA }, execCtx.host));
    const a1 = execCtx.getActiveMemoryManager(execCtx.stateStack);

    execCtx.stateStack.pushMemoryFrame(new MemoryFrame({ dir: dirB }, execCtx.host));
    const b = execCtx.getActiveMemoryManager(execCtx.stateStack);
    expect(b).not.toBe(a1);

    execCtx.stateStack.popMemoryFrame();
    const a2 = execCtx.getActiveMemoryManager(execCtx.stateStack);
    expect(a2).toBe(a1);
  });

  it("re-seeds the JSON bottom frame when restoring an old checkpoint without memoryFrames", async () => {
    const ctx = makeCtx({ dir: dirJson });
    const execCtx = await ctx.createExecutionContext({ runId: "r1" });

    // Simulate an old-format stateStack: has `other.memoryId` but no
    // `other.memoryFrames` (predates this feature).
    const stack = new StateStack();
    stack.other.memoryId = "alice";
    execCtx.stateStack = stack;

    const m = execCtx.getActiveMemoryManager(execCtx.stateStack);
    expect(m).toBeDefined();
    expect(execCtx.stateStack.activeMemoryFrame()?.configKey).toBe(fs.realpathSync(dirJson));
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
    const execCtx = await ctx.createExecutionContext({ runId: "r1" });
    expect(execCtx.getActiveMemoryManager(execCtx.stateStack)).toBeDefined();

    execCtx.stateStack.popMemoryFrame();
    expect(execCtx.getActiveMemoryManager(execCtx.stateStack)).toBeUndefined();
  });
});

describe("throwIfCancelled", () => {
  it("throws the recorded cancel reason and otherwise returns", () => {
    const ctx = makeMockCtx();
    expect(() => ctx.throwIfCancelled()).not.toThrow();
    ctx.cancel("stop");
    expect(() => ctx.throwIfCancelled()).toThrow(AgencyCancelledError);
  });
});

describe("the count of started programs", () => {
  it("starts at zero, on a context and on the execution context made from it", async () => {
    const ctx = makeMockCtx();
    expect(ctx.spawnCount).toBe(0);
    ctx.spawnCount = 4;
    const execCtx = await ctx.createExecutionContext({ runId: "run-1" });
    expect(execCtx.spawnCount).toBe(0);
  });

  // A resume in a new process: the context starts at zero.
  it("takes a saved count that is larger than its own", () => {
    const ctx = makeMockCtx();
    ctx.adoptSpawnCount(3);
    expect(ctx.spawnCount).toBe(3);
  });

  // A restore() after two more starts: those processes were still started.
  it("keeps its own count when the saved one is smaller", () => {
    const ctx = makeMockCtx();
    ctx.spawnCount = 5;
    ctx.adoptSpawnCount(3);
    expect(ctx.spawnCount).toBe(5);
  });

  it("is carried by a checkpoint into the context that restores it", async () => {
    const first = await makeMockCtx().createExecutionContext({ runId: "run-1" });
    first.spawnCount = 3;
    first.stateStack.nodesTraversed = ["main"];
    const checkpoint = Checkpoint.fromStateStack(first.stateStack, first, {
      moduleId: "m",
      scopeName: "main",
      stepPath: "0",
    });
    const resumed = await makeMockCtx().createExecutionContext({ runId: "run-1" });
    resumed.restoreState(checkpoint);
    expect(resumed.spawnCount).toBe(3);
  });

  // A checkpoint from before the field.
  it("is unchanged by a checkpoint that saved no count", () => {
    const ctx = makeMockCtx();
    ctx.spawnCount = 2;
    ctx.adoptSpawnCount(undefined);
    expect(ctx.spawnCount).toBe(2);
  });
});
