import { describe, it, expect } from "vitest";
import { parseStatelogJsonl } from "@/statelog/parse.js";
import { normalizeTraceLogs, traceLogsToJsonl } from "./logsBridge.js";

describe("traceLogsToJsonl", () => {
  it("emits lines the real viewer parser accepts", () => {
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
    const parsed = parseStatelogJsonl(traceLogsToJsonl(logs));
    expect(parsed.errors).toEqual([]);
    expect(parsed.events).toHaveLength(2);
  });

  it("carries trace_id on every line", () => {
    const out = traceLogsToJsonl([
      { traceId: "t1", spanId: null, parentSpanId: null, data: { type: "debug", message: "x" } },
    ]);
    expect(JSON.parse(out).trace_id).toBe("t1");
  });

  it("JSON normalization and JSONL use the same records", () => {
    const logs = [
      { traceId: "t1", spanId: "s1", parentSpanId: null, data: { type: "debug", message: "x" } },
    ];
    expect(
      traceLogsToJsonl(logs)
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(normalizeTraceLogs(logs));
  });
});
