import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildRunInstruction,
  buildForkOptions,
  sendInterruptToParent,
  setSubprocessIpcPayloadLimit,
  type RunLimits,
} from "./ipc.js";

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
});

describe("subprocess interrupt IPC", () => {
  const originalSend = process.send;

  afterEach(() => {
    process.send = originalSend;
    setSubprocessIpcPayloadLimit(Infinity);
    vi.restoreAllMocks();
  });

  it("correlates parent decisions to the matching interrupt", async () => {
    const sent: any[] = [];
    process.send = vi.fn((msg: any) => {
      sent.push(msg);
      return true;
    }) as any;

    const first = sendInterruptToParent(
      { kind: "test", message: "first", data: {}, origin: "test" },
      { propagated: false },
    );
    const second = sendInterruptToParent(
      { kind: "test", message: "second", data: {}, origin: "test" },
      { propagated: false },
    );

    expect(sent).toHaveLength(2);
    expect(sent[0].interruptId).toBeTruthy();
    expect(sent[1].interruptId).toBeTruthy();
    expect(sent[0].interruptId).not.toBe(sent[1].interruptId);

    process.emit("message", {
      type: "decision",
      interruptId: sent[1].interruptId,
      approved: true,
      value: "second-approved",
    });
    process.emit("message", {
      type: "decision",
      interruptId: sent[0].interruptId,
      approved: false,
      value: "first-rejected",
    });

    await expect(first).resolves.toEqual({ type: "reject", value: "first-rejected" });
    await expect(second).resolves.toEqual({ type: "approve", value: "second-approved" });
  });

  it("sends a structured limit error instead of an oversized interrupt", async () => {
    const sent: any[] = [];
    process.send = vi.fn((msg: any) => {
      sent.push(msg);
      return true;
    }) as any;
    setSubprocessIpcPayloadLimit(1);

    await expect(sendInterruptToParent(
      { kind: "test", message: "too large", data: { value: "é" }, origin: "test" },
      { propagated: false },
    )).resolves.toEqual({ type: "reject", value: expect.stringContaining("ipc_payload") });

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("error");
    expect(JSON.parse(sent[0].error)).toMatchObject({
      reason: "limit_exceeded",
      limit: "ipc_payload",
      threshold: 1,
    });
  });
});
