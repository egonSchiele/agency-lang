import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "@/statelog/wireTypes.js";

import { describeAvailableTraces, scanStatelog } from "./statelogScan.js";
import { IngestSourceError } from "./types.js";

let ts = 0;
function nextTs(): string {
  ts += 100;
  return new Date(1_700_000_000_000 + ts).toISOString();
}

function ev(traceId: string, type: string, data: Record<string, unknown> = {}): EventEnvelope {
  return {
    format_version: 1,
    trace_id: traceId,
    project_id: "p",
    span_id: null,
    parent_span_id: null,
    data: { type, timestamp: nextTs(), ...data },
  };
}

function jsonl(events: EventEnvelope[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("scanStatelog", () => {
  it("groups two interleaved traces in first-seen order", () => {
    const text = jsonl([
      ev("A", "agentStart"),
      ev("B", "agentStart"),
      ev("A", "exitNode"),
    ]);
    const scan = scanStatelog(text);
    expect(scan.traces.map((t) => t.traceId)).toEqual(["A", "B"]);
    expect(scan.eventsByTrace["A"]).toHaveLength(2);
    expect(scan.eventsByTrace["B"]).toHaveLength(1);
  });

  it("summarizes agent name, first user message, and summed cost", () => {
    const text = jsonl([
      ev("A", "agentName", { name: "coder" }),
      ev("A", "promptCompletion", {
        messages: [{ role: "user", content: "do the thing" }],
        cost: { totalCost: 0.01 },
      }),
      ev("A", "promptCompletion", {
        messages: [{ role: "user", content: "again" }],
        cost: { totalCost: 0.02 },
      }),
    ]);
    const [trace] = scanStatelog(text).traces;
    expect(trace.agentName).toBe("coder");
    expect(trace.firstUserMessage).toBe("do the thing");
    expect(trace.costUsd).toBeCloseTo(0.03);
  });

  it("fails on any unparseable line rather than dropping it", () => {
    const text = '{"format_version":1,"trace_id":"A","data":{"type":"agentStart"}}\nnot json\n';
    expect(() => scanStatelog(text)).toThrow(IngestSourceError);
    expect(() => scanStatelog(text)).toThrow(/unparseable line/);
  });

  it("fails on an unsupported future format version", () => {
    const text = '{"format_version":999,"trace_id":"A","data":{"type":"agentStart"}}\n';
    expect(() => scanStatelog(text)).toThrow(IngestSourceError);
  });

  it("fails on an empty source", () => {
    expect(() => scanStatelog("")).toThrow(/No statelog events/);
    expect(() => scanStatelog("\n\n")).toThrow(/No statelog events/);
  });
});

describe("describeAvailableTraces", () => {
  it("lists each trace with its label and cost", () => {
    const text = jsonl([
      ev("A", "agentName", { name: "coder" }),
      ev("A", "promptCompletion", { messages: [{ role: "user", content: "hi" }], cost: { totalCost: 0.5 } }),
      ev("B", "agentStart"),
    ]);
    const description = describeAvailableTraces(scanStatelog(text));
    expect(description).toContain("A");
    expect(description).toContain("[coder]");
    expect(description).toContain("$0.5000");
    expect(description).toContain("[(unnamed)]");
  });
});
