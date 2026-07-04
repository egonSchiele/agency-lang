import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import {
  clampLimits,
  serializeInterruptsForIpc,
  setSubprocessRunInfo,
  getSubprocessRunInfo,
  resolveDepthCap,
  attachSessionHandlers,
  handleTelemetryMessage,
  handleCallbackMessage,
  handleChildMessage,
  withParentStatelog,
  DEFAULT_MAX_SUBPROCESS_DEPTH,
  SUBPROCESS_DEPTH_CEILING,
} from "./ipc.js";
import { State, StateStack } from "./state/stateStack.js";
import { AgencyAbort, AgencyCancelledError } from "./errors.js";
import { CostGuard, isGuardExceededError } from "./guard.js";

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

/** One canonical RunSession mock — when `RunSession` gains a field the
 * code under test reads, add it HERE so every suite sees it (the mocks
 * are `any`-typed, so a second hand-rolled literal would go stale
 * silently). Suites layer their specifics via `overrides`. */
const makeSession = (overrides: Record<string, any> = {}): any => ({
  sessionId: "test-session",
  child: { stdout: null, stderr: null, on: () => {}, send: () => true, connected: true, kill: () => true },
  limits: { wallClock: 1000, memory: 1, ipcPayload: 1, stdout: 1 },
  ctx: { lockReleasers: {} },
  stateStack: {},
  resolvePromise: () => {},
  rejectPromise: () => {},
  settled: false,
  startedAt: Date.now(),
  wallClockTimer: null,
  stdoutBytes: 0,
  stoppedForwarding: false,
  detachAbortListener: null,
  ...overrides,
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

  const makeSegmentSession = (child: any, outcomes: any[]): any => makeSession({
    sessionId: "seg-test",
    child,
    limits: { wallClock: 5000, memory: 1, ipcPayload: 1024 * 1024 * 1024, stdout: 1024 * 1024 * 1024 },
    resolvePromise: (v: any) => outcomes.push({ kind: "resolve", v }),
    rejectPromise: (e: any) => outcomes.push({ kind: "reject", e }),
  });

  it("arms on session start and is cleared when the child pauses; never fires afterward", async () => {
    vi.useFakeTimers();
    try {
      const { child, listeners } = makeFakeChild();
      const outcomes: any[] = [];
      const session = makeSegmentSession(child, outcomes);

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
      const session = makeSegmentSession(child, outcomes);

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
      const s1 = makeSegmentSession(first.child, firstOutcomes);
      attachSessionHandlers(s1, { type: "run", scriptPath: "/x.js", node: "main", args: {} });
      first.listeners["message"]({ type: "interrupted", interrupts: [], checkpoint: {}, subprocessSessionId: "s" });

      // A resume segment (second session) gets its own full budget,
      // independent of how much the first segment used.
      const second = makeFakeChild();
      const secondOutcomes: any[] = [];
      const s2 = makeSegmentSession(second.child, secondOutcomes);
      attachSessionHandlers(s2, { type: "resume", scriptPath: "/x.js", node: "main", checkpoint: {}, interrupts: [], responses: [] });
      expect(s2.wallClockTimer).not.toBeNull();
      expect(s2.wallClockTimer).not.toBe(s1.wallClockTimer);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("handleTelemetryMessage", () => {
  const makeTelemetrySession = (stack: StateStack) => {
    const kills: string[] = [];
    const rejections: any[] = [];
    const session = makeSession({
      child: { kill: (sig: string) => { kills.push(sig); return true; }, connected: true },
      stateStack: stack,
      rejectPromise: (err: any) => { rejections.push(err); },
    });
    return { session, kills, rejections };
  };

  it("charges localCost and guards; no trip under budget", () => {
    const stack = new StateStack();
    const guard = new CostGuard(1.0);
    stack.guards.push(guard);
    const { session, kills, rejections } = makeTelemetrySession(stack);

    handleTelemetryMessage(session, { type: "telemetry", costUsd: 0.25 });

    expect(stack.localCost).toBe(0.25);
    expect(guard.check(stack)).toBeNull();
    expect(kills).toEqual([]);
    expect(rejections).toEqual([]);
    expect(session.settled).toBe(false);
  });

  it("a trip kills the child and rejects the session with the guard-trip abort", () => {
    const stack = new StateStack();
    stack.guards.push(new CostGuard(0.1));
    const { session, kills, rejections } = makeTelemetrySession(stack);

    handleTelemetryMessage(session, { type: "telemetry", costUsd: 0.2 });

    expect(kills).toEqual(["SIGKILL"]);
    expect(rejections).toHaveLength(1);
    expect(session.settled).toBe(true);
    // The rejection must be the guard-trip abort ITSELF (identity, not a
    // wrapper or re-thrown copy) so the OWNING boundary's ownedGuardIds
    // matching converts it (the stdlib run() plain try re-throws).
    expect(isGuardExceededError(rejections[0])).toBe(true);
    expect(String(rejections[0])).toMatch(/cost/i);
  });

  it("post-settle telemetry still charges (the spend was real) but does not enforce", () => {
    const stack = new StateStack();
    stack.guards.push(new CostGuard(0.1));
    const { session, kills, rejections } = makeTelemetrySession(stack);
    session.settled = true;

    handleTelemetryMessage(session, { type: "telemetry", costUsd: 0.2 });

    expect(stack.localCost).toBe(0.2);
    expect(kills).toEqual([]);
    expect(rejections).toEqual([]);
  });

  it("ignores malformed cost values", () => {
    const stack = new StateStack();
    const { session } = makeTelemetrySession(stack);
    handleTelemetryMessage(session, { type: "telemetry", costUsd: NaN } as any);
    handleTelemetryMessage(session, { type: "telemetry", costUsd: -5 } as any);
    handleTelemetryMessage(session, { type: "telemetry" } as any);
    expect(stack.localCost).toBe(0);
  });
});

const flush = () => new Promise((r) => setImmediate(r));

describe("handleCallbackMessage", () => {
  it("fires the parent's registered callback with the forwarded data", async () => {
    const fired: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: { onNodeStart: (d: any) => fired.push(d) }, topLevelCallbacks: [], stateStack: stack };
    const session = makeSession({ ctx, stateStack: stack, limits: { wallClock: 1000, memory: 1, ipcPayload: 1e9, stdout: 1 } });

    handleCallbackMessage(session, { type: "callback", name: "onNodeStart", data: { nodeName: "childNode" } });
    await flush();

    expect(fired).toEqual([{ nodeName: "childNode" }]);
  });

  it("fires a SCOPED parent callback registered on an ancestor stack frame", async () => {
    // Regression guard: a node-level `callback("onNodeStart")` registers a
    // SCOPED callback on the parent's stack, found only by walking
    // ctx.stateStack. s.stateStack is the run() call-site SLICE and does NOT
    // contain the ancestor frame — the handler must ignore it and walk
    // ctx.stateStack (as in-process callHook does). With the old
    // `stateStack: s.stateStack` this callback was silently missed.
    const fired: any[] = [];
    const frame = new State();
    frame.addScopedCallback("onNodeStart", (d: any) => fired.push(d));
    const fullStack = new StateStack();
    fullStack.stack = [frame];
    const ctx: any = { callbacks: {}, topLevelCallbacks: [], stateStack: fullStack };
    // A DIFFERENT, empty slice — mimics the run() call-site slice.
    const session = makeSession({ ctx, stateStack: new StateStack(), limits: { wallClock: 1000, memory: 1, ipcPayload: 1e9, stdout: 1 } });

    handleCallbackMessage(session, { type: "callback", name: "onNodeStart", data: { nodeName: "child" } });
    await flush();

    expect(fired).toEqual([{ nodeName: "child" }]);
  });

  it("ignores an unknown callback name (child is less-trusted)", async () => {
    // Register the handler UNDER the bogus name. gatherCallbacks reads
    // ctx.callbacks[name] dynamically, so WITHOUT the isForwardableCallbackName
    // guard this would fire. This makes the test actually discriminate the guard
    // (registering it under a valid name would pass either way — false confidence).
    const fired: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: { onBogus: (d: any) => fired.push(d) }, topLevelCallbacks: [], stateStack: stack };
    const session = makeSession({ ctx, stateStack: stack });

    handleCallbackMessage(session, { type: "callback", name: "onBogus" as any, data: { x: 1 } });
    await flush();

    expect(fired).toEqual([]);
  });

  it("drops a callback that arrives after the session settled", async () => {
    const fired: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: { onNodeStart: (d: any) => fired.push(d) }, topLevelCallbacks: [], stateStack: stack };
    const session = makeSession({ ctx, stateStack: stack, settled: true });

    handleCallbackMessage(session, { type: "callback", name: "onNodeStart", data: { nodeName: "late" } });
    await flush();

    expect(fired).toEqual([]);
  });

  it("reconstructs onAgentStart.cancel to kill the child and settle cancelled", async () => {
    const kills: string[] = [];
    const rejections: any[] = [];
    const stack = new StateStack();
    const ctx: any = {
      callbacks: { onAgentStart: (d: any) => d.cancel("parent said stop") },
      topLevelCallbacks: [],
      stateStack: stack,
    };
    const session = makeSession({
      ctx,
      stateStack: stack,
      child: { kill: (sig: string) => { kills.push(sig); return true; }, connected: true },
      rejectPromise: (err: any) => { rejections.push(err); },
    });

    handleCallbackMessage(session, {
      type: "callback",
      name: "onAgentStart",
      data: { nodeName: "childToCancel", args: {}, messages: [] },
    });
    await flush();

    expect(kills).toEqual(["SIGKILL"]);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toBeInstanceOf(AgencyCancelledError);
    expect(session.settled).toBe(true);
  });

  it("routes an AgencyAbort thrown by a parent callback to kill + settle (guard trip / cancel)", async () => {
    // fireWithGuard re-throws AgencyAbort, so invokeCallbacks can reject. The
    // fire-and-forget `.catch` must route it to the session (not orphan it as an
    // unhandledRejection and lose the trip), mirroring handleTelemetryMessage.
    const kills: string[] = [];
    const rejections: any[] = [];
    const stack = new StateStack();
    const abort = new AgencyCancelledError("callback tripped a guard"); // an AgencyAbort
    const ctx: any = {
      callbacks: { onNodeStart: () => { throw abort; } },
      topLevelCallbacks: [],
      stateStack: stack,
    };
    const session = makeSession({
      ctx,
      stateStack: stack,
      child: { kill: (sig: string) => { kills.push(sig); return true; }, connected: true },
      rejectPromise: (e: any) => { rejections.push(e); },
      limits: { wallClock: 1000, memory: 1, ipcPayload: 1e9, stdout: 1 },
    });

    handleCallbackMessage(session, { type: "callback", name: "onNodeStart", data: { nodeName: "n" } });
    await flush();

    expect(kills).toEqual(["SIGKILL"]);
    expect(rejections).toEqual([abort]);
    expect(rejections[0]).toBeInstanceOf(AgencyAbort);
    expect(session.settled).toBe(true);
  });

  it("re-fires the mid-tier's own callback AND re-forwards upward (nested relay, both fire)", async () => {
    // Models a MID-TIER that is itself a subprocess: on a forwarded grandchild
    // event it must BOTH fire its own registered callback AND re-forward the
    // event to its parent (invokeCallbacks re-emits because this process is in
    // IPC mode). This is the deterministic equivalent of a "both fire" E2E —
    // which cannot be written cleanly because a run()-compiled child can't hold
    // top-level globals and a forwarded-event callback fires on the parentStore
    // frame (so node-locals aren't observable).
    vi.stubEnv("AGENCY_IPC", "1");
    const originalSend = process.send;
    const sent: any[] = [];
    process.send = ((m: any) => { sent.push(m); return true; }) as any;
    try {
      const fired: any[] = [];
      const stack = new StateStack();
      const ctx: any = { callbacks: { onNodeStart: (d: any) => fired.push(d) }, topLevelCallbacks: [], stateStack: stack };
      const session = makeSession({ ctx, stateStack: stack, limits: { wallClock: 1000, memory: 1, ipcPayload: 1e9, stdout: 1 } });

      handleCallbackMessage(session, { type: "callback", name: "onNodeStart", data: { nodeName: "grandNode" } });
      await flush();

      expect(fired).toEqual([{ nodeName: "grandNode" }]); // mid-tier's own callback fired
      expect(sent).toEqual([{ type: "callback", name: "onNodeStart", data: { nodeName: "grandNode" } }]); // and re-forwarded upward
    } finally {
      process.send = originalSend;
    }
  });

  it("does not fire a denylisted callback name even if the parent registered it", async () => {
    // onStream/onOAuthRequired are non-forwardable (function/Promise fields). The
    // parent guard must reject them too — not just the child sender — else a
    // version-skewed child could fire a broken (function-stripped) callback.
    const fired: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: { onStream: (d: any) => fired.push(d) }, topLevelCallbacks: [], stateStack: stack };
    const session = makeSession({ ctx, stateStack: stack });

    handleCallbackMessage(session, { type: "callback", name: "onStream" as any, data: { type: "text", text: "x" } });
    await flush();

    expect(fired).toEqual([]);
  });
});

describe("handleChildMessage oversize handling", () => {
  it("drops an oversize callback message instead of killing the run", async () => {
    const rejections: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: {}, topLevelCallbacks: [], stateStack: stack };
    // makeSession default ipcPayload is 1 byte, so any callback payload is oversize.
    const session = makeSession({ ctx, stateStack: stack, rejectPromise: (e: any) => rejections.push(e) });

    await handleChildMessage(session, { type: "callback", name: "onNodeStart", data: { nodeName: "big" } });

    expect(session.settled).toBe(false);
    expect(rejections).toEqual([]);
  });

  it("still kills the run for an oversize non-callback message", async () => {
    const stack = new StateStack();
    const ctx: any = { lockReleasers: {}, stateStack: stack };
    const session = makeSession({ ctx, stateStack: stack });

    await handleChildMessage(session, { type: "result", value: { big: "x".repeat(50) } } as any);

    expect(session.settled).toBe(true); // settleWithLimitFailure fired
  });

  it("does not throw on a malformed (undefined) child message; settles instead of hanging", async () => {
    // Regression for the null-safety fix: undefined -> serializedByteLength !ok
    // -> isObservationalMessage(undefined) must NOT throw (a throw would escape
    // the void-invoked handler, leaving the session unsettled = a hung run).
    const rejections: any[] = [];
    const stack = new StateStack();
    const ctx: any = { lockReleasers: {}, stateStack: stack };
    const session = makeSession({ ctx, stateStack: stack, rejectPromise: (e: any) => rejections.push(e) });

    await expect(handleChildMessage(session, undefined as any)).resolves.toBeUndefined();

    expect(session.settled).toBe(true); // settled via the serialize-error path, not a throw
    expect(rejections).toHaveLength(1);
  });

  it("drops an UNSERIALIZABLE callback message instead of killing the run", async () => {
    // Covers the `!serialized.ok` observational branch (separate from oversize).
    const rejections: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: {}, topLevelCallbacks: [], stateStack: stack };
    const session = makeSession({
      ctx, stateStack: stack,
      limits: { wallClock: 1000, memory: 1, ipcPayload: 1e9, stdout: 1 }, // large, so oversize is NOT the cause
      rejectPromise: (e: any) => rejections.push(e),
    });
    const circular: any = { type: "callback", name: "onNodeStart", data: {} };
    circular.data.self = circular; // JSON.stringify throws -> serialized.ok === false

    await handleChildMessage(session, circular);

    expect(session.settled).toBe(false);
    expect(rejections).toEqual([]);
  });

  it("routes a within-limit callback through the dispatch case to the parent callback", async () => {
    // Directly exercises Task 3(d) — the `msg.type === "callback"` dispatch case
    // in handleChildMessage. The other handleCallbackMessage tests call it
    // directly, and the oversize test drops BEFORE dispatch, so without this the
    // dispatch wiring is only covered by the slow E2E (Task 5). A missing/typo'd
    // dispatch case would leave `fired` empty here.
    const fired: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: { onNodeStart: (d: any) => fired.push(d) }, topLevelCallbacks: [], stateStack: stack };
    const session = makeSession({
      ctx, stateStack: stack,
      limits: { wallClock: 1000, memory: 1, ipcPayload: 1e9, stdout: 1 },
    });

    await handleChildMessage(session, { type: "callback", name: "onNodeStart", data: { nodeName: "routed" } });
    await flush(); // handleCallbackMessage void-invokes invokeCallbacks; let the microtask chain drain

    expect(fired).toEqual([{ nodeName: "routed" }]);
  });
});
