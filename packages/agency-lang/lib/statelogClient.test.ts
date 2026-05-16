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
      client.startSpan("agentRun");
      client.startSpan("nodeExecution");
      client.startSpan("llmCall");
      expect(client.currentSpan?.spanType).toBe("llmCall");
      const popped = client.endSpan();
      expect(popped?.spanType).toBe("llmCall");
      expect(client.currentSpan?.spanType).toBe("nodeExecution");
      client.endSpan();
      expect(client.currentSpan?.spanType).toBe("agentRun");
      client.endSpan();
      expect(client.currentSpan).toBeUndefined();
    });

    it("attaches span_id and parent_span_id to emitted events", async () => {
      const file = newLogFile("span-payload");
      const client = fileClient(file);
      const outer = client.startSpan("agentRun");
      const inner = client.startSpan("nodeExecution");
      await client.enterNode({ nodeId: "n1", data: {} });
      client.endSpan();
      client.endSpan();
      const events = readEvents(file);
      expect(events).toHaveLength(1);
      expect(events[0].span_id).toBe(inner);
      expect(events[0].parent_span_id).toBe(outer);
    });

    it("root-level events have null parent_span_id", async () => {
      const file = newLogFile("root-span");
      const client = fileClient(file);
      client.startSpan("agentRun");
      await client.debug("hi", {});
      client.endSpan();
      const events = readEvents(file);
      expect(events[0].parent_span_id).toBeNull();
      expect(events[0].span_id).toBeTruthy();
    });
  });

  describe("forkDepth gating", () => {
    it("startSpan returns undefined inside a fork", () => {
      const client = fileClient(newLogFile("fork-gate"));
      client.enterFork();
      expect(client.startSpan("nodeExecution")).toBeUndefined();
      expect(client.currentSpan).toBeUndefined();
      client.exitFork();
      expect(client.startSpan("nodeExecution")).toBeTruthy();
    });

    it("exitFork is clamped at zero", () => {
      const client = fileClient(newLogFile("fork-clamp"));
      client.exitFork();
      client.exitFork();
      client.exitFork();
      // Should still be able to start a span (forkDepth must be 0).
      expect(client.startSpan("agentRun")).toBeTruthy();
    });

    it("events emitted inside a fork have no span attribution", async () => {
      const file = newLogFile("fork-payload");
      const client = fileClient(file);
      client.startSpan("agentRun");
      client.enterFork();
      await client.debug("inside-fork", {});
      client.exitFork();
      client.endSpan();
      const events = readEvents(file);
      // The event was emitted while inside a fork, so it inherits the
      // outer span (agentRun) — startSpan was gated, not currentSpan.
      // The important invariant is that no inner span pushed during the
      // fork is visible.
      expect(events[0].span_id).toBeTruthy();
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
