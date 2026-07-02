import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import {
  clampLimits,
  serializeInterruptsForIpc,
  setSubprocessRunInfo,
  getSubprocessRunInfo,
  resolveDepthCap,
  attachSessionHandlers,
  withParentStatelog,
  DEFAULT_MAX_SUBPROCESS_DEPTH,
  SUBPROCESS_DEPTH_CEILING,
} from "./ipc.js";

describe("withParentStatelog", () => {
  it("forwards the parent logFile (absolutized) when the parent logs and the caller set none", () => {
    const out = withParentStatelog(undefined, { observability: true, logFile: "log.jsonl" });
    expect(out).toEqual({
      observability: true,
      log: { logFile: path.resolve(process.cwd(), "log.jsonl") },
    });
  });

  it("an explicit child logFile always wins", () => {
    const overrides = { observability: true, log: { logFile: "child.jsonl" } };
    expect(withParentStatelog(overrides, { observability: true, logFile: "log.jsonl" })).toBe(overrides);
  });

  it("forwards nothing when the parent has observability off", () => {
    expect(withParentStatelog(undefined, { observability: false, logFile: "log.jsonl" })).toBeUndefined();
  });

  it("forwards observability alone when the parent has no file sink", () => {
    expect(withParentStatelog(undefined, { observability: true })).toEqual({ observability: true });
  });
});

describe("resolveDepthCap", () => {
  afterEach(() => setSubprocessRunInfo({ depth: 0 }));

  it("uses the param cap when no ancestor cap exists", () => {
    expect(resolveDepthCap(DEFAULT_MAX_SUBPROCESS_DEPTH)).toBe(DEFAULT_MAX_SUBPROCESS_DEPTH);
  });

  it("clamps the param cap to the hard ceiling", () => {
    expect(resolveDepthCap(100)).toBe(SUBPROCESS_DEPTH_CEILING);
  });

  it("a tighter ancestor cap always wins", () => {
    setSubprocessRunInfo({ depth: 1, maxDepth: 2 });
    expect(resolveDepthCap(5)).toBe(2);
  });

  it("a looser param cap cannot loosen the ancestor cap", () => {
    setSubprocessRunInfo({ depth: 1, maxDepth: 3 });
    expect(resolveDepthCap(10)).toBe(3);
  });
});

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

describe("wall-clock timer is per execution segment", () => {
  // Replaces the deleted pause-limit-wallclock-resets execution test: the
  // per-segment property (paused time never counts against wallClock)
  // cannot be asserted end-to-end without segment-time-vs-cap arithmetic,
  // which is inherently flaky on loaded CI runners (observed ~2s of pure
  // per-segment overhead). The property is structural — each session arms
  // its own timer and settle() clears it — so pin it with fake timers.
  const makeFakeChild = () => {
    const listeners: Record<string, (arg: any) => void> = {};
    return {
      child: {
        stdout: null,
        stderr: null,
        on: (evt: string, cb: (arg: any) => void) => { listeners[evt] = cb; },
        send: () => true,
        connected: true,
        kill: () => true,
      },
      listeners,
    };
  };

  const makeSession = (child: any, outcomes: any[]): any => ({
    sessionId: "seg-test",
    child,
    limits: { wallClock: 5000, memory: 1, ipcPayload: 1024 * 1024 * 1024, stdout: 1024 * 1024 * 1024 },
    ctx: { lockReleasers: {} },
    stateStack: {},
    resolvePromise: (v: any) => outcomes.push({ kind: "resolve", v }),
    rejectPromise: (e: any) => outcomes.push({ kind: "reject", e }),
    settled: false,
    startedAt: Date.now(),
    wallClockTimer: null,
    stdoutBytes: 0,
    stoppedForwarding: false,
    detachAbortListener: null,
  });

  it("arms on session start and is cleared when the child pauses; never fires afterward", async () => {
    vi.useFakeTimers();
    try {
      const { child, listeners } = makeFakeChild();
      const outcomes: any[] = [];
      const session = makeSession(child, outcomes);

      attachSessionHandlers(session, { type: "run", scriptPath: "/x.js", node: "main", args: {} });
      expect(session.wallClockTimer).not.toBeNull();

      // Child pauses (self-checkpointed): the segment is over — its
      // remaining budget must die with it.
      listeners["message"]({ type: "interrupted", interrupts: [], checkpoint: {}, subprocessSessionId: "s" });
      await vi.advanceTimersByTimeAsync(0);
      expect(session.settled).toBe(true);
      expect(session.wallClockTimer).toBeNull();

      // Long past the cap: no wall_clock failure may fire — paused time
      // never counts.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].kind).toBe("resolve");
      expect(outcomes[0].v.type).toBe("interrupted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a running segment that exceeds its own budget fails with the wall_clock limit", async () => {
    vi.useFakeTimers();
    try {
      const { child } = makeFakeChild();
      const outcomes: any[] = [];
      const session = makeSession(child, outcomes);

      attachSessionHandlers(session, { type: "run", scriptPath: "/x.js", node: "main", args: {} });
      await vi.advanceTimersByTimeAsync(5001);

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].kind).toBe("resolve");
      expect(outcomes[0].v.type).toBe("result");
      expect(outcomes[0].v.value.error.limit).toBe("wall_clock");
    } finally {
      vi.useRealTimers();
    }
  });

  it("each new session arms a fresh timer with the full budget", () => {
    vi.useFakeTimers();
    try {
      const first = makeFakeChild();
      const firstOutcomes: any[] = [];
      const s1 = makeSession(first.child, firstOutcomes);
      attachSessionHandlers(s1, { type: "run", scriptPath: "/x.js", node: "main", args: {} });
      first.listeners["message"]({ type: "interrupted", interrupts: [], checkpoint: {}, subprocessSessionId: "s" });

      // A resume segment (second session) gets its own full budget,
      // independent of how much the first segment used.
      const second = makeFakeChild();
      const secondOutcomes: any[] = [];
      const s2 = makeSession(second.child, secondOutcomes);
      attachSessionHandlers(s2, { type: "resume", scriptPath: "/x.js", node: "main", checkpoint: {}, interrupts: [], responses: [] });
      expect(s2.wallClockTimer).not.toBeNull();
      expect(s2.wallClockTimer).not.toBe(s1.wallClockTimer);
    } finally {
      vi.useRealTimers();
    }
  });
});
