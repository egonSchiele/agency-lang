import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StatelogClient, StatelogConfig, getStatelogClient } from "./statelogClient.js";

/** Make a unique temp file path for a logFile-based test. The file is NOT
 *  created — the client should create the parent dir and append on first
 *  event. */
function tmpLogFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `statelog-test-${name}-`));
  return path.join(dir, "events.jsonl");
}

/** Read every JSON line from a logFile and parse it. Returns [] if the
 *  file doesn't exist. */
function readEvents(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
}

/** Standard config helper — observability ON, file sink, deterministic
 *  traceId for assertions. */
function fileClient(file: string, overrides: Partial<StatelogConfig> = {}): StatelogClient {
  return new StatelogClient({
    host: "",
    apiKey: "",
    projectId: "test-project",
    traceId: "test-trace",
    debugMode: false,
    observability: true,
    logFile: file,
    ...overrides,
  });
}

describe("StatelogClient", () => {
  let tmpDirs: string[] = [];

  beforeEach(() => {
    tmpDirs = [];
  });

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    vi.restoreAllMocks();
  });

  function newLogFile(name: string): string {
    const file = tmpLogFile(name);
    tmpDirs.push(path.dirname(file));
    return file;
  }

  describe("observability gate", () => {
    it("is a complete no-op when observability is false", async () => {
      const file = newLogFile("disabled");
      const client = fileClient(file, { observability: false });

      // Every event method should be safe to call and produce no I/O.
      await client.debug("hi", {});
      await client.agentStart({ entryNode: "main" });
      await client.enterNode({ nodeId: "main", data: {} });
      client.startSpan("agentRun");
      client.endSpan();

      expect(fs.existsSync(file)).toBe(false);
    });

    it("startSpan returns undefined when disabled", () => {
      const client = fileClient(newLogFile("disabled-span"), { observability: false });
      expect(client.startSpan("agentRun")).toBeUndefined();
      expect(client.currentSpan).toBeUndefined();
    });

    it("snapshotStack and runInBranchContext short-circuit when disabled", async () => {
      // The runner calls `snapshotStack()` and wraps every branch in
      // `runInBranchContext()` unconditionally. When the client is a
      // no-op, neither call should allocate a fresh stack copy or set
      // up an AsyncLocalStorage context. We verify behavior — same
      // empty array reference, no ALS plumbing — to keep the no-op
      // mode genuinely free of per-fork overhead.
      const client = fileClient(newLogFile("disabled-fork"), { observability: false });
      const snap1 = client.snapshotStack();
      const snap2 = client.snapshotStack();
      expect(snap1).toHaveLength(0);
      // Same shared empty stack returned every call — no per-fork allocation.
      expect(snap1).toBe(snap2);

      // runInBranchContext just calls fn() directly when disabled, so
      // we observe no ALS context inside it.
      const inside = await client.runInBranchContext(snap1, async () => {
        // currentSpan stays undefined (no rootStack pushes, no ALS store).
        return client.currentSpan;
      });
      expect(inside).toBeUndefined();
    });

    it("activates the file sink when observability is true", async () => {
      const file = newLogFile("enabled");
      const client = fileClient(file);
      await client.debug("hello", { x: 1 });
      const events = readEvents(file);
      expect(events).toHaveLength(1);
      expect(events[0].data.type).toBe("debug");
      expect(events[0].data.message).toBe("hello");
      expect(events[0].trace_id).toBe("test-trace");
      expect(events[0].project_id).toBe("test-project");
    });
  });

  describe("sinks", () => {
    it("file sink writes one JSONL line per event", async () => {
      const file = newLogFile("jsonl");
      const client = fileClient(file);

      await client.debug("a", {});
      await client.enterNode({ nodeId: "n1", data: { x: 1 } });
      await client.exitNode({ nodeId: "n1", data: { x: 2 }, timeTaken: 1.5 });

      const events = readEvents(file);
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.data.type)).toEqual([
        "debug",
        "enterNode",
        "exitNode",
      ]);
    });

    it("auto-creates the logFile's parent directory", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "statelog-mkdir-"));
      tmpDirs.push(root);
      const file = path.join(root, "deeply", "nested", "events.jsonl");
      const client = fileClient(file);
      await client.debug("hi", {});
      expect(fs.existsSync(file)).toBe(true);
    });

    it("stdout sink writes to console.log without requiring an apiKey", async () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const client = new StatelogClient({
        host: "stdout",
        apiKey: "",
        projectId: "p",
        traceId: "t",
        debugMode: false,
        observability: true,
      });
      await client.debug("ping", {});
      expect(spy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(spy.mock.calls[0][0]);
      expect(payload.data.type).toBe("debug");
      expect(payload.trace_id).toBe("t");
    });

    it("file sink and remote host both receive events", async () => {
      const file = newLogFile("dual");
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("", { status: 200 }));
      const client = new StatelogClient({
        host: "https://example.invalid",
        apiKey: "secret",
        projectId: "p",
        traceId: "t",
        debugMode: false,
        observability: true,
        logFile: file,
      });
      await client.debug("hi", {});
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(readEvents(file)).toHaveLength(1);
    });
  });

  describe("apiKey requirement", () => {
    it("remote host with no apiKey disables the client", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const client = new StatelogClient({
        host: "https://example.invalid",
        apiKey: "",
        projectId: "p",
        traceId: "t",
        debugMode: false,
        observability: true,
      });
      await client.debug("hi", {});
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("stdout sink does not require an apiKey", async () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const client = new StatelogClient({
        host: "stdout",
        apiKey: "",
        projectId: "p",
        traceId: "t",
        debugMode: false,
        observability: true,
      });
      await client.debug("ok", {});
      expect(spy).toHaveBeenCalled();
    });

    it("logFile-only sink does not require an apiKey", async () => {
      const file = newLogFile("nokey");
      const client = new StatelogClient({
        host: "",
        apiKey: "",
        projectId: "p",
        traceId: "t",
        debugMode: false,
        observability: true,
        logFile: file,
      });
      await client.debug("ok", {});
      expect(readEvents(file)).toHaveLength(1);
    });
  });

  describe("span management", () => {
    it("startSpan / endSpan maintains a LIFO stack", () => {
      const client = fileClient(newLogFile("span-lifo"));
      const agentId = client.startSpan("agentRun")!;
      const nodeId = client.startSpan("nodeExecution")!;
      const llmId = client.startSpan("llmCall")!;
      expect(client.currentSpan?.spanType).toBe("llmCall");
      const popped = client.endSpan(llmId);
      expect(popped?.spanType).toBe("llmCall");
      expect(client.currentSpan?.spanType).toBe("nodeExecution");
      client.endSpan(nodeId);
      expect(client.currentSpan?.spanType).toBe("agentRun");
      client.endSpan(agentId);
      expect(client.currentSpan).toBeUndefined();
    });

    it("attaches span_id and parent_span_id to emitted events", async () => {
      const file = newLogFile("span-payload");
      const client = fileClient(file);
      const outer = client.startSpan("agentRun")!;
      const inner = client.startSpan("nodeExecution")!;
      await client.enterNode({ nodeId: "n1", data: {} });
      client.endSpan(inner);
      client.endSpan(outer);
      const events = readEvents(file);
      expect(events).toHaveLength(1);
      expect(events[0].span_id).toBe(inner);
      expect(events[0].parent_span_id).toBe(outer);
    });

    it("root-level events have null parent_span_id", async () => {
      const file = newLogFile("root-span");
      const client = fileClient(file);
      const id = client.startSpan("agentRun")!;
      await client.debug("hi", {});
      client.endSpan(id);
      const events = readEvents(file);
      expect(events[0].parent_span_id).toBeNull();
      expect(events[0].span_id).toBeTruthy();
    });
  });

  describe("branch span isolation (AsyncLocalStorage)", () => {
    it("snapshotStack copies the active stack and decouples it from later pushes", () => {
      const client = fileClient(newLogFile("snapshot"));
      const a = client.startSpan("agentRun")!;
      const snap = client.snapshotStack();
      const b = client.startSpan("nodeExecution")!;
      // Snapshot was taken before `b` was pushed, so it must NOT contain b.
      expect(snap.map((s) => s.spanId)).toEqual([a]);
      // And mutating the live stack must not retroactively alter the snapshot.
      expect(snap.length).toBe(1);
      client.endSpan(b);
      client.endSpan(a);
    });

    it("spans pushed inside runInBranchContext are invisible outside it", async () => {
      const client = fileClient(newLogFile("branch-iso"));
      const outer = client.startSpan("agentRun")!;
      const parent = client.snapshotStack();
      let innerIdInsideBranch: string | undefined;
      let currentInsideBranch: string | undefined;
      await client.runInBranchContext(parent, async () => {
        innerIdInsideBranch = client.startSpan("nodeExecution");
        currentInsideBranch = client.currentSpan?.spanId;
        // Inside the branch, currentSpan is the branch-local push.
        expect(currentInsideBranch).toBe(innerIdInsideBranch);
      });
      // Back outside the branch, the outer stack must be unaffected.
      expect(client.currentSpan?.spanId).toBe(outer);
      client.endSpan(outer);
    });

    it("concurrent branches each see their own stack — no interleaving", async () => {
      const client = fileClient(newLogFile("branch-concurrent"));
      const outer = client.startSpan("agentRun")!;
      const parent = client.snapshotStack();

      // Two branches run concurrently. Each pushes a different span and
      // yields control multiple times via `await`. If the two branches
      // shared a stack, they would observe each other's pushes.
      const branch0 = client.runInBranchContext(parent, async () => {
        const id = client.startSpan("nodeExecution")!;
        await new Promise((r) => setImmediate(r));
        const top0 = client.currentSpan?.spanId;
        await new Promise((r) => setImmediate(r));
        const top1 = client.currentSpan?.spanId;
        client.endSpan(id);
        return { id, top0, top1, parentSpan: id && client.currentSpan?.spanId };
      });
      const branch1 = client.runInBranchContext(parent, async () => {
        const id = client.startSpan("llmCall")!;
        await new Promise((r) => setImmediate(r));
        const top0 = client.currentSpan?.spanId;
        await new Promise((r) => setImmediate(r));
        const top1 = client.currentSpan?.spanId;
        client.endSpan(id);
        return { id, top0, top1 };
      });

      const [b0, b1] = await Promise.all([branch0, branch1]);
      // Each branch's "currentSpan" across awaits is its own push, never
      // the sibling's push.
      expect(b0.top0).toBe(b0.id);
      expect(b0.top1).toBe(b0.id);
      expect(b1.top0).toBe(b1.id);
      expect(b1.top1).toBe(b1.id);
      expect(b0.id).not.toBe(b1.id);

      // The outer stack still has only the agentRun span.
      expect(client.currentSpan?.spanId).toBe(outer);
      client.endSpan(outer);
    });

    it("events emitted inside a branch attribute to the branch's span", async () => {
      const file = newLogFile("branch-attribution");
      const client = fileClient(file);
      const outer = client.startSpan("agentRun")!;
      const parent = client.snapshotStack();
      await client.runInBranchContext(parent, async () => {
        const inner = client.startSpan("nodeExecution")!;
        await client.debug("inside-branch", {});
        client.endSpan(inner);
      });
      client.endSpan(outer);
      const events = readEvents(file);
      expect(events).toHaveLength(1);
      // The debug event must be attributed to the branch's nodeExecution
      // span (not to the outer agentRun span).
      expect(events[0].parent_span_id).toBe(outer);
      // And its span_id must be the branch-local span — which means the
      // branch saw a fresh push.
      expect(events[0].span_id).toBeTruthy();
      expect(events[0].span_id).not.toBe(outer);
    });

    it("a branch ending a span it never opened is a no-op on the parent stack", async () => {
      const client = fileClient(newLogFile("branch-no-parent-pop"));
      const outer = client.startSpan("agentRun")!;
      const parent = client.snapshotStack();
      await client.runInBranchContext(parent, async () => {
        // Try to pop the parent's outer span from inside the branch. The
        // branch's snapshot includes `outer`, but ending it pops only the
        // branch's *local* copy — it must not pop the real outer stack.
        client.endSpan(outer);
      });
      // The parent's outer span is still active.
      expect(client.currentSpan?.spanId).toBe(outer);
      client.endSpan(outer);
      expect(client.currentSpan).toBeUndefined();
    });
  });

  describe("event method shapes", () => {
    it("agentStart emits the right type and entryNode", async () => {
      const file = newLogFile("agent-start");
      const client = fileClient(file);
      await client.agentStart({ entryNode: "main", args: { x: 1 } });
      const [evt] = readEvents(file);
      expect(evt.data.type).toBe("agentStart");
      expect(evt.data.entryNode).toBe("main");
      expect(evt.data.args).toEqual({ x: 1 });
    });

    it("agentEnd includes timeTaken and tokenStats", async () => {
      const file = newLogFile("agent-end");
      const client = fileClient(file);
      await client.agentEnd({
        entryNode: "main",
        result: { ok: true },
        timeTaken: 42,
        tokenStats: {
          usage: { totalTokens: 100 },
          cost: { totalCost: 0.01 },
        },
      });
      const [evt] = readEvents(file);
      expect(evt.data.type).toBe("agentEnd");
      expect(evt.data.timeTaken).toBe(42);
      expect(evt.data.tokenStats.usage.totalTokens).toBe(100);
      expect(evt.data.tokenStats.cost.totalCost).toBe(0.01);
    });

    it("promptCompletion includes usage, cost, stream", async () => {
      const file = newLogFile("prompt");
      const client = fileClient(file);
      await client.promptCompletion({
        messages: [],
        completion: {},
        usage: { inputTokens: 10, outputTokens: 20 },
        cost: { totalCost: 0.005 },
        stream: false,
      });
      const [evt] = readEvents(file);
      expect(evt.data.type).toBe("promptCompletion");
      expect(evt.data.usage.inputTokens).toBe(10);
      expect(evt.data.cost.totalCost).toBe(0.005);
      expect(evt.data.stream).toBe(false);
    });

    it("interruptThrown emits only interruptId + interruptData", async () => {
      const file = newLogFile("intr-thrown");
      const client = fileClient(file);
      await client.interruptThrown({
        interruptId: "i1",
        interruptData: { foo: "bar" },
      });
      const [evt] = readEvents(file);
      expect(evt.data.type).toBe("interruptThrown");
      expect(evt.data.interruptId).toBe("i1");
      expect(evt.data.interruptData).toEqual({ foo: "bar" });
      // Dropped fields should not be present.
      expect(evt.data).not.toHaveProperty("functionName");
      expect(evt.data).not.toHaveProperty("sourceLocation");
    });

    it("handlerDecision emits decision + value", async () => {
      const file = newLogFile("handler");
      const client = fileClient(file);
      await client.handlerDecision({
        interruptId: "i1",
        handlerIndex: 0,
        decision: "approve",
        value: 42,
      });
      const [evt] = readEvents(file);
      expect(evt.data.type).toBe("handlerDecision");
      expect(evt.data.decision).toBe("approve");
      expect(evt.data.value).toBe(42);
    });

    it("interruptResolved emits outcome + resolvedBy", async () => {
      const file = newLogFile("intr-resolved");
      const client = fileClient(file);
      await client.interruptResolved({
        interruptId: "i1",
        outcome: "approved",
        resolvedBy: "handler",
      });
      const [evt] = readEvents(file);
      expect(evt.data.type).toBe("interruptResolved");
      expect(evt.data.outcome).toBe("approved");
      expect(evt.data.resolvedBy).toBe("handler");
    });

    it("checkpointCreated emits reason + sourceLocation", async () => {
      const file = newLogFile("cp-created");
      const client = fileClient(file);
      await client.checkpointCreated({
        checkpointId: 1,
        reason: "interrupt",
        sourceLocation: { moduleId: "m", scopeName: "s", stepPath: "p" },
      });
      const [evt] = readEvents(file);
      expect(evt.data.type).toBe("checkpointCreated");
      expect(evt.data.reason).toBe("interrupt");
      expect(evt.data.sourceLocation.moduleId).toBe("m");
    });

    it("checkpointRestored emits restoreCount + overrides", async () => {
      const file = newLogFile("cp-restored");
      const client = fileClient(file);
      await client.checkpointRestored({
        checkpointId: 1,
        restoreCount: 3,
        maxRestores: 100,
        overrides: { args: true, globals: false },
      });
      const [evt] = readEvents(file);
      expect(evt.data.type).toBe("checkpointRestored");
      expect(evt.data.restoreCount).toBe(3);
      expect(evt.data.overrides.args).toBe(true);
    });

    it("forkStart, forkBranchEnd, forkEnd carry forkId + mode", async () => {
      const file = newLogFile("fork-events");
      const client = fileClient(file);
      await client.forkStart({ forkId: "f1", mode: "all", branchCount: 2 });
      await client.forkBranchEnd({
        forkId: "f1",
        branchIndex: 0,
        outcome: "success",
        timeTaken: 1,
      });
      await client.forkBranchEnd({
        forkId: "f1",
        branchIndex: 1,
        outcome: "failure",
        timeTaken: 2,
      });
      await client.forkEnd({ forkId: "f1", mode: "all", timeTaken: 3 });
      const events = readEvents(file).map((e) => e.data);
      expect(events.map((e) => e.type)).toEqual([
        "forkStart",
        "forkBranchEnd",
        "forkBranchEnd",
        "forkEnd",
      ]);
      expect(events[1].outcome).toBe("success");
      expect(events[2].outcome).toBe("failure");
    });

    it("threadCreated emits threadType + parentThreadId", async () => {
      const file = newLogFile("thread");
      const client = fileClient(file);
      await client.threadCreated({ threadId: "0", threadType: "thread" });
      await client.threadCreated({
        threadId: "1",
        threadType: "subthread",
        parentThreadId: "0",
      });
      const events = readEvents(file).map((e) => e.data);
      expect(events[0].threadType).toBe("thread");
      expect(events[1].threadType).toBe("subthread");
      expect(events[1].parentThreadId).toBe("0");
    });

    it("error emits errorType + retryable", async () => {
      const file = newLogFile("error");
      const client = fileClient(file);
      await client.error({
        errorType: "toolError",
        message: "boom",
        functionName: "doStuff",
        retryable: true,
      });
      const [evt] = readEvents(file);
      expect(evt.data.type).toBe("error");
      expect(evt.data.errorType).toBe("toolError");
      expect(evt.data.functionName).toBe("doStuff");
      expect(evt.data.retryable).toBe(true);
    });
  });

  describe("runMetadata follow-up on agentStart", () => {
    it("agentStart triggers a runMetadata event when metadata is configured", async () => {
      const file = newLogFile("metadata");
      const client = fileClient(file, {
        metadata: {
          environment: "test",
          tags: ["x", "y"],
        },
      });
      await client.agentStart({ entryNode: "main" });
      const events = readEvents(file).map((e) => e.data);
      expect(events[0].type).toBe("agentStart");
      expect(events[1].type).toBe("runMetadata");
      expect(events[1].environment).toBe("test");
      expect(events[1].tags).toEqual(["x", "y"]);
    });

    it("agentStart does NOT emit runMetadata when metadata is absent", async () => {
      const file = newLogFile("no-metadata");
      const client = fileClient(file);
      await client.agentStart({ entryNode: "main" });
      const events = readEvents(file).map((e) => e.data);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("agentStart");
    });
  });

  describe("zero-overhead invariant (white-box)", () => {
    it("post() short-circuits before serialization when disabled", async () => {
      const file = newLogFile("zero");
      const stringifySpy = vi.spyOn(JSON, "stringify");
      const client = fileClient(file, { observability: false });

      // Reset the spy counter — fileClient construction may stringify config.
      stringifySpy.mockClear();

      await client.debug("a", {});
      await client.agentStart({ entryNode: "main" });
      await client.promptCompletion({ messages: [], completion: {} });
      client.startSpan("agentRun");
      client.endSpan();

      expect(stringifySpy).not.toHaveBeenCalled();
      expect(fs.existsSync(file)).toBe(false);
    });
  });
});

describe("getStatelogClient", () => {
  it("plumbs logFile through to the client", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statelog-getter-"));
    try {
      const file = path.join(dir, "events.jsonl");
      const client = getStatelogClient({
        host: "",
        projectId: "p",
        observability: true,
        logFile: file,
      });
      await client.debug("hi", {});
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
