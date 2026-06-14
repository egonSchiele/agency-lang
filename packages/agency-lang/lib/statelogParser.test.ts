import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EventEnvelope } from "./statelog/wireTypes.js";
import { extractEvalRecord } from "./eval/extract.js";
import { normalize } from "./eval/normalize.js";
import { StatelogParser } from "./statelogParser.js";

let ts = 0;

function nextTs(): string {
  ts += 100;
  return new Date(1_700_000_000_000 + ts).toISOString();
}

function resetClock(): void {
  ts = 0;
}

function event(
  type: string,
  data: Record<string, unknown> = {},
  traceId = "trace-A",
): EventEnvelope {
  return {
    format_version: 1,
    trace_id: traceId,
    project_id: "project",
    span_id: null,
    parent_span_id: null,
    data: { type, timestamp: nextTs(), ...data },
  };
}

function writeJsonl(dir: string, events: EventEnvelope[]): string {
  const filePath = path.join(dir, "statelog.jsonl");
  fs.writeFileSync(filePath, events.map((ev) => JSON.stringify(ev)).join("\n"));
  return filePath;
}

describe("StatelogParser", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "statelog-parser-"));
    resetClock();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("projects eval values and records through a readable sync API", () => {
    const events = [
      event("threadCreated", { threadId: "0", threadType: "thread", label: "main" }),
      event("evalInputRecorded", { threadId: "0", value: "question" }),
      event("evalOutputRecorded", { threadId: "0", value: "draft" }),
      event("evalOutputRecorded", { threadId: "0", value: "answer" }),
    ];
    const statelogPath = writeJsonl(tmpDir, events);
    const log = StatelogParser.fromFile(statelogPath);
    const expected = extractEvalRecord(events, statelogPath);

    expect(log.evalRecord()).toEqual(expected);
    expect(log.normalized()).toEqual(normalize(events));
    expect(log.evalInputs()).toEqual(expected.evalInputs);
    expect(log.evalOutputs()).toEqual(expected.evalOutputs);
    expect(log.finalEvalOutput()).toEqual(expected.evalOutputs[1]);
    expect(log.threads()).toEqual(expected.threads);
    expect(log.normalizedEvents()).toEqual(expected.events);
    expect(log.interrupts()).toEqual(expected.interrupts);
    expect(log.errors()).toEqual(expected.errors);
    expect(log.incompleteInvocations()).toEqual(expected.incomplete);
    expect(log.metrics()).toEqual(expected.metrics);
    expect(log.warnings()).toEqual(expected.warnings);
  });

  it("returns null when there is no final eval output", () => {
    const statelogPath = writeJsonl(tmpDir, [
      event("threadCreated", { threadId: "0", threadType: "thread", label: "main" }),
    ]);

    expect(StatelogParser.fromFile(statelogPath).finalEvalOutput()).toBeNull();
  });

  it("rejects statelog files with more than one trace", () => {
    const statelogPath = writeJsonl(tmpDir, [
      event("threadCreated", { threadId: "0", threadType: "thread" }, "trace-A"),
      event("threadCreated", { threadId: "1", threadType: "thread" }, "trace-B"),
    ]);
    const log = StatelogParser.fromFile(statelogPath);

    expect(() => log.normalized()).toThrow(/multiple trace_ids/i);
    expect(() => log.evalRecord()).toThrow(/multiple trace_ids/i);
  });
});

describe("StatelogParser tolerant parsing", () => {
  const line = (o: object) => JSON.stringify(o);
  const good = (over: object = {}) =>
    line({
      format_version: 1, trace_id: "t1", project_id: "p", span_id: null,
      parent_span_id: null,
      data: { type: "agentStart", timestamp: "2026-06-14T00:00:00Z" }, ...over,
    });

  it("fromString parses well-formed lines with no errors", () => {
    const p = StatelogParser.fromString([good(), good()].join("\n"));
    expect([...p.events()]).toHaveLength(2);
    expect(p.parseErrors()).toHaveLength(0);
  });

  it("collects malformed-JSON errors instead of throwing", () => {
    const p = StatelogParser.fromString([good(), "{ not json", good()].join("\n"));
    expect([...p.events()]).toHaveLength(2);
    expect(p.parseErrors()).toHaveLength(1);
    expect(p.parseErrors()[0]).toMatchObject({ line: 2, kind: "invalid_json" });
  });

  it("rejects unsupported format_version as an error", () => {
    const p = StatelogParser.fromString(
      line({ format_version: 2, trace_id: "t", project_id: "p", span_id: null,
        parent_span_id: null, data: { type: "x", timestamp: "" } }),
    );
    expect([...p.events()]).toHaveLength(0);
    expect(p.parseErrors()[0]).toMatchObject({ kind: "unsupported_version" });
  });

  it("rejects rows missing trace_id or data.type", () => {
    const p = StatelogParser.fromString(
      line({ format_version: 1, project_id: "p", span_id: null, parent_span_id: null,
        data: { timestamp: "" } }),
    );
    expect(p.parseErrors()[0]).toMatchObject({ kind: "missing_fields" });
  });

  it("treats missing format_version as legacy v1", () => {
    const p = StatelogParser.fromString(
      line({ trace_id: "t", project_id: "p", span_id: null, parent_span_id: null,
        data: { type: "agentStart", timestamp: "" } }),
    );
    expect([...p.events()]).toHaveLength(1);
    expect(p.parseErrors()).toHaveLength(0);
  });

  it("evalRecord throws on malformed input", () => {
    const p = StatelogParser.fromString([good(), "{ not json"].join("\n"));
    expect(() => p.evalRecord()).toThrow(/Malformed statelog on line 2/);
  });
});

describe("StatelogParser hierarchy", () => {
  const env = (over: Partial<EventEnvelope>): EventEnvelope => ({
    format_version: 1, trace_id: "t1", project_id: "p", span_id: null,
    parent_span_id: null,
    data: { type: "debug", timestamp: "2026-06-14T00:00:00Z" }, ...over,
  });
  const toJsonl = (evts: EventEnvelope[]) => evts.map((e) => JSON.stringify(e)).join("\n");

  it("returns one trace per trace_id", () => {
    const p = StatelogParser.fromString(toJsonl([
      env({ trace_id: "a" }), env({ trace_id: "b" }), env({ trace_id: "a" }),
    ]));
    expect(p.traces().map((t) => t.traceId).sort()).toEqual(["a", "b"]);
  });

  it("nests span children under their parent span (order-independent)", () => {
    const p = StatelogParser.fromString(toJsonl([
      env({ span_id: "s2", parent_span_id: "s1", data: { type: "promptCompletion", timestamp: "2026-06-14T00:00:01Z" } }),
      env({ span_id: "s1", parent_span_id: null, data: { type: "agentStart", timestamp: "2026-06-14T00:00:00Z" } }),
    ]));
    const root = p.onlyTrace().root();
    const s1 = root.children.find((c) => c.id === "s1")!;
    expect(s1.kind).toBe("span");
    expect(s1.children.some((c) => c.id === "s2")).toBe(true);
  });

  it("getNodeById finds spans and line-derived event ids", () => {
    const p = StatelogParser.fromString(toJsonl([
      env({ span_id: "s1", data: { type: "toolCall", timestamp: "2026-06-14T00:00:00Z", toolName: "grep", timeTaken: 1200 } }),
    ]));
    expect(p.getNodeById("s1")?.kind).toBe("span");
    const evtNode = p.getNodeById("evt:1");
    expect(evtNode?.kind).toBe("event");
    expect(evtNode?.summary).toContain("grep");
    expect(p.eventOf("evt:1")?.data.type).toBe("toolCall");
  });

  it("rolls tokens/cost up onto spans", () => {
    const p = StatelogParser.fromString(toJsonl([
      env({ span_id: "s1", data: { type: "promptCompletion", timestamp: "2026-06-14T00:00:00Z",
        timeTaken: 1000, usage: { inputTokens: 100, outputTokens: 50 }, cost: { totalCost: 0.01 } } }),
    ]));
    const s1 = p.getNodeById("s1")!;
    expect(s1.metrics?.tokens).toBe(150);
    expect(s1.metrics?.cost).toBeCloseTo(0.01);
  });

  it("onlyTrace throws when multiple traces present", () => {
    const p = StatelogParser.fromString(toJsonl([env({ trace_id: "a" }), env({ trace_id: "b" })]));
    expect(() => p.onlyTrace()).toThrow(/multiple trace/i);
  });
});

describe("StatelogParser typed queries", () => {
  const env = (over: Partial<EventEnvelope>): EventEnvelope => ({
    format_version: 1, trace_id: "t1", project_id: "p", span_id: null,
    parent_span_id: null,
    data: { type: "debug", timestamp: "2026-06-14T00:00:00Z" }, ...over,
  });
  const toJsonl = (e: EventEnvelope[]) => e.map((x) => JSON.stringify(x)).join("\n");

  it("llmCalls returns model/tokens/cost for promptCompletion events", () => {
    const p = StatelogParser.fromString(toJsonl([
      env({ data: { type: "promptCompletion", timestamp: "2026-06-14T00:00:00Z",
        model: '"gpt-x"', usage: { inputTokens: 10, outputTokens: 5 }, cost: { totalCost: 0.002 } } }),
    ]));
    const calls = p.llmCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "gpt-x", tokensIn: 10, tokensOut: 5, cost: 0.002 });
  });

  it("toolCalls returns the tool name", () => {
    const p = StatelogParser.fromString(toJsonl([
      env({ data: { type: "toolCall", timestamp: "2026-06-14T00:00:00Z", toolName: "grep", timeTaken: 30 } }),
    ]));
    expect(p.toolCalls().map((t) => t.toolName)).toEqual(["grep"]);
  });

  it("trace(id).llmCalls() scopes to that trace", () => {
    const p = StatelogParser.fromString(toJsonl([
      env({ trace_id: "a", data: { type: "promptCompletion", timestamp: "2026-06-14T00:00:00Z", model: '"m"' } }),
      env({ trace_id: "b", data: { type: "promptCompletion", timestamp: "2026-06-14T00:00:00Z", model: '"m"' } }),
    ]));
    expect(p.trace("a").llmCalls()).toHaveLength(1);
    expect(p.llmCalls()).toHaveLength(2);
  });

  it("lines() yields each parsed event with its source line number", () => {
    const p = StatelogParser.fromString(toJsonl([env({}), env({})]));
    expect([...p.lines()].map((l) => l.lineNo)).toEqual([1, 2]);
  });
});
