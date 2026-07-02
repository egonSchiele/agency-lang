import { describe, it, expect, afterEach } from "vitest";
import { clampLimits, serializeInterruptsForIpc, setSubprocessRunInfo, getSubprocessRunInfo } from "./ipc.js";

describe("subprocess run info", () => {
  // Module-scoped per-PROCESS state (one run per subprocess). Tests share
  // the module instance, so isolate via afterEach instead of relying on
  // in-test reset ordering.
  afterEach(() => setSubprocessRunInfo({ depth: 0 }));

  it("defaults to depth 0 and round-trips", () => {
    expect(getSubprocessRunInfo()).toEqual({ depth: 0 });
    setSubprocessRunInfo({ runId: "r1", subprocessSessionId: "s1", parentSpanId: "sp1", depth: 1 });
    expect(getSubprocessRunInfo()).toEqual({ runId: "r1", subprocessSessionId: "s1", parentSpanId: "sp1", depth: 1 });
  });

  it("serializeInterruptsForIpc echoes the seeded session id", () => {
    setSubprocessRunInfo({ runId: "r1", subprocessSessionId: "sess-42", depth: 1 });
    const msg = serializeInterruptsForIpc([
      { type: "interrupt", interruptId: "i1", runId: "r1", effect: "e", message: "m", data: {}, origin: "o" } as any,
    ]);
    expect(msg.subprocessSessionId).toBe("sess-42");
  });
});

describe("serializeInterruptsForIpc", () => {
  it("strips per-interrupt checkpoints and hoists the shared one", () => {
    const cp = { id: 1, nodeId: "main", stack: [] };
    const interrupts = [
      { type: "interrupt", interruptId: "i1", runId: "r", effect: "std::bash", message: "m", data: {}, origin: "o", checkpoint: cp, checkpointId: 1 },
      { type: "interrupt", interruptId: "i2", runId: "r", effect: "std::bash", message: "m", data: {}, origin: "o", checkpoint: cp, checkpointId: 1 },
    ] as any[];
    const msg = serializeInterruptsForIpc(interrupts as any);
    expect(msg.type).toBe("interrupted");
    expect(msg.checkpoint).toBe(cp);
    expect(msg.interrupts.map((i) => i.interruptId)).toEqual(["i1", "i2"]);
    expect(msg.interrupts[0].runId).toBe("r");
    expect((msg.interrupts[0] as any).checkpoint).toBeUndefined();
    expect((msg.interrupts[0] as any).checkpointId).toBeUndefined();
    // The message must survive the JSON round-trip process.send performs —
    // a class instance anywhere in the tree would silently degrade here.
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });
});

describe("clampLimits", () => {
  it("clamps wallClock above 1h to 1h", () => {
    const out = clampLimits({
      wallClock: 10 * 60 * 60 * 1000,
      memory: 1,
      ipcPayload: 1,
      stdout: 1,
    });
    expect(out.wallClock).toBe(60 * 60 * 1000);
  });

  it("clamps memory above 4gb to 4gb", () => {
    const out = clampLimits({
      wallClock: 1,
      memory: 8 * 1024 * 1024 * 1024,
      ipcPayload: 1,
      stdout: 1,
    });
    expect(out.memory).toBe(4 * 1024 * 1024 * 1024);
  });

  it("clamps ipcPayload above 1gb to 1gb", () => {
    const out = clampLimits({
      wallClock: 1,
      memory: 1,
      ipcPayload: 4 * 1024 * 1024 * 1024,
      stdout: 1,
    });
    expect(out.ipcPayload).toBe(1024 * 1024 * 1024);
  });

  it("clamps stdout above 100mb to 100mb", () => {
    const out = clampLimits({
      wallClock: 1,
      memory: 1,
      ipcPayload: 1,
      stdout: 500 * 1024 * 1024,
    });
    expect(out.stdout).toBe(100 * 1024 * 1024);
  });

  it("leaves below-ceiling values unchanged", () => {
    const out = clampLimits({
      wallClock: 30000,
      memory: 256 * 1024 * 1024,
      ipcPayload: 1024,
      stdout: 512,
    });
    expect(out).toEqual({
      wallClock: 30000,
      memory: 256 * 1024 * 1024,
      ipcPayload: 1024,
      stdout: 512,
    });
  });
});
