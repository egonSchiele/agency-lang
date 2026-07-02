import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "path";

import {
  buildRunInstruction,
  buildForkOptions,
  cleanupSessionLocks,
  registerSessionLock,
  sendLockAcquireToParent,
  sendInterruptToParent,
  setSubprocessIpcPayloadLimit,
  withParentProviderModules,
  type RunLimits,
} from "./ipc.js";
import { RuntimeContext } from "./state/context.js";

const limits: RunLimits = {
  wallClock: 1000,
  memory: 512 * 1024 * 1024,
  ipcPayload: 1024,
  stdout: 1024,
};

describe("subprocess IPC config overrides", () => {
  it("includes config overrides in the run instruction", () => {
    expect(buildRunInstruction({
      scriptPath: "/tmp/agent.js",
      node: "main",
      args: { prompt: "x" },
      limits,
      configOverrides: { observability: true, log: { logFile: "task/statelog.jsonl" } },
    })).toMatchObject({
      type: "run",
      scriptPath: "/tmp/agent.js",
      node: "main",
      args: { prompt: "x" },
      ipcPayload: 1024,
      configOverrides: { observability: true, log: { logFile: "task/statelog.jsonl" } },
    });
  });

  it("adds cwd to fork options when provided", () => {
    expect(buildForkOptions({ limits, cwd: "/tmp/workdir" })).toMatchObject({
      cwd: "/tmp/workdir",
      env: expect.objectContaining({ AGENCY_IPC: "1" }),
    });
  });

  it("forwards the parent's provider modules as absolute paths", () => {
    const result = withParentProviderModules(
      { observability: true },
      ["./llama-setup.mjs", "/abs/other.mjs"],
    );
    // Existing overrides are preserved; provider paths are absolutized
    // against the parent's cwd so they resolve in a child with a different cwd.
    expect(result).toEqual({
      observability: true,
      client: {
        providerModules: [
          path.resolve(process.cwd(), "./llama-setup.mjs"),
          "/abs/other.mjs",
        ],
      },
    });
  });

  it("returns overrides unchanged when the parent has no provider modules", () => {
    const overrides = { observability: true };
    expect(withParentProviderModules(overrides, [])).toBe(overrides);
    expect(withParentProviderModules(undefined, [])).toBeUndefined();
  });
});

describe("subprocess interrupt IPC", () => {
  const originalSend = process.send;

  afterEach(() => {
    process.send = originalSend;
    setSubprocessIpcPayloadLimit(Infinity);
    vi.restoreAllMocks();
  });

  it("correlates parent outcomes to the matching interrupt id", async () => {
    const sent: any[] = [];
    process.send = vi.fn((msg: any) => {
      sent.push(msg);
      return true;
    }) as any;

    // The message id IS the caller's interrupt-level id, preserved verbatim.
    const first = sendInterruptToParent(
      { effect: "test", message: "first", data: {}, origin: "test" },
      "intr-first",
    );
    const second = sendInterruptToParent(
      { effect: "test", message: "second", data: {}, origin: "test" },
      "intr-second",
    );

    expect(sent).toHaveLength(2);
    expect(sent[0].interruptId).toBe("intr-first");
    expect(sent[1].interruptId).toBe("intr-second");

    process.emit("message", {
      type: "decision",
      interruptId: "intr-second",
      outcome: { kind: "approved", value: "second-approved" },
    });
    process.emit("message", {
      type: "decision",
      interruptId: "intr-first",
      outcome: { kind: "rejected", value: "first-rejected" },
    });

    await expect(first).resolves.toEqual({ kind: "rejected", value: "first-rejected" });
    await expect(second).resolves.toEqual({ kind: "approved", value: "second-approved" });
  });

  it("sends a structured limit error instead of an oversized interrupt", async () => {
    const sent: any[] = [];
    process.send = vi.fn((msg: any) => {
      sent.push(msg);
      return true;
    }) as any;
    setSubprocessIpcPayloadLimit(1);

    await expect(sendInterruptToParent(
      { effect: "test", message: "too large", data: { value: "é" }, origin: "test" },
      "intr-oversized",
    )).resolves.toEqual({ kind: "rejected", value: expect.stringContaining("ipc_payload") });

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("error");
    expect(JSON.parse(sent[0].error)).toMatchObject({
      reason: "limit_exceeded",
      limit: "ipc_payload",
      threshold: 1,
    });
  });

  it("reports interrupt serialization failures as plain errors", async () => {
    const sent: any[] = [];
    process.send = vi.fn((msg: any) => {
      sent.push(msg);
      return true;
    }) as any;

    const circular: Record<string, any> = {};
    circular.self = circular;

    await expect(sendInterruptToParent(
      { effect: "test", message: "bad", data: circular, origin: "test" },
      "intr-circular",
    )).resolves.toEqual({ kind: "rejected", value: expect.stringContaining("Failed to serialize interrupt payload") });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "error",
      error: expect.stringContaining("Failed to serialize interrupt payload"),
    });
  });
});

describe("subprocess lock IPC", () => {
  const originalSend = process.send;

  afterEach(() => {
    process.send = originalSend;
    vi.restoreAllMocks();
  });

  it("sends lock acquire and release messages correlated by request id", async () => {
    const sent: any[] = [];
    process.send = vi.fn((msg: any) => {
      sent.push(msg);
      return true;
    }) as any;

    const acquired = sendLockAcquireToParent("resource", { timeoutMs: 25 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "lockAcquire",
      name: "resource",
      timeoutMs: 25,
    });

    process.emit("message", {
      type: "lockGranted",
      requestId: sent[0].requestId,
    });

    const release = await acquired;
    release();

    expect(sent[1]).toEqual({
      type: "lockRelease",
      requestId: sent[0].requestId,
      name: "resource",
    });
  });

  it("includes stable lock owner ids on acquire and release when provided", async () => {
    const sent: any[] = [];
    process.send = vi.fn((msg: any) => {
      sent.push(msg);
      if (msg.type === "lockAcquire") {
        process.emit("message", {
          type: "lockGranted",
          requestId: msg.requestId,
        });
      }
      return true;
    }) as any;

    const release = await sendLockAcquireToParent("resource", { ownerId: "owner-1" });
    release();

    expect(sent[0]).toMatchObject({
      type: "lockAcquire",
      ownerId: "owner-1",
    });
    expect(sent[1]).toMatchObject({
      type: "lockRelease",
      ownerId: "owner-1",
    });
  });

  it("cleanupSessionLocks releases locks held by a closed child session", async () => {
    const ctx = new RuntimeContext({
      statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
      smoltalkDefaults: {},
      dirname: process.cwd(),
    });
    const events: string[] = [];
    registerSessionLock(ctx, "session-1", "resource\0owner-1", () => {
      events.push("released");
    });

    cleanupSessionLocks(ctx, "session-1");

    expect(events).toEqual(["released"]);
    expect(ctx.lockReleasers["resource\0owner-1"]).toBeUndefined();
  });
});
