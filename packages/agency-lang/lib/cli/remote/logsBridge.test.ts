import { describe, it, expect } from "vitest";
import { normalizeTraceLogs, traceLogsToEvents } from "./logsBridge.js";

describe("traceLogsToEvents", () => {
  it("gives the viewer every record as an event", () => {
    const logs = [
      {
        traceId: "t1",
        spanId: "s1",
        parentSpanId: null,
        data: { type: "enterNode", nodeId: "main" },
      },
      {
        traceId: "t1",
        spanId: "s2",
        parentSpanId: "s1",
        data: { type: "toolCall", toolName: "x", args: {}, output: 1 },
      },
    ];
    const parsed = traceLogsToEvents(logs);
    expect(parsed.errors).toEqual([]);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[1]).toMatchObject({
      trace_id: "t1",
      span_id: "s2",
      parent_span_id: "s1",
      data: { type: "toolCall" },
    });
  });

  it("checks each record the way a line from a file is checked", () => {
    const parsed = traceLogsToEvents([
      { traceId: "t1", spanId: null, parentSpanId: null, data: { type: "debug", message: "x" } },
      { traceId: "", spanId: null, parentSpanId: null, data: { type: "debug", message: "y" } },
    ]);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.errors).toEqual([
      { line: 2, kind: "missing_fields", detail: "missing trace_id or data.type" },
    ]);
  });

  it("JSON normalization and the viewer use the same records", () => {
    const logs = [
      { traceId: "t1", spanId: "s1", parentSpanId: null, data: { type: "debug", message: "x" } },
    ];
    const [record] = normalizeTraceLogs(logs);
    expect(traceLogsToEvents(logs).events[0]).toMatchObject(record);
  });
});
