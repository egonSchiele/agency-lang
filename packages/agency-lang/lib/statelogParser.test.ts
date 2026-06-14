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
