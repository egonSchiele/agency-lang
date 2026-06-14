import { describe, it, expect } from "vitest";
import { summarizeEvent, summarizeSpanText, summarizeTraceText } from "./summarize.js";
import type { EventEnvelope } from "./wireTypes.js";

const evt = (data: Record<string, unknown>): EventEnvelope => ({
  format_version: 1,
  trace_id: "",
  project_id: "",
  span_id: null,
  parent_span_id: null,
  data: { timestamp: "", ...data } as EventEnvelope["data"],
});

describe("summarizeEvent (leaf events)", () => {
  it("promptCompletion shows model and duration", () => {
    const s = summarizeEvent(evt({ type: "promptCompletion", model: '"gpt-4o"', timeTaken: 1234 }));
    expect(s).toMatch(/gpt-4o/);
    expect(s).toMatch(/1\.2s|1234ms/);
  });

  it("error shows errorType and message prefix", () => {
    const s = summarizeEvent(evt({
      type: "error",
      errorType: "ToolFailure",
      message: "tool blew up because the API rate-limited us",
    }));
    expect(s).toContain("ToolFailure");
    expect(s).toContain("tool blew up");
  });

  it("toolCall shows the tool name", () => {
    const s = summarizeEvent(evt({ type: "toolCall", toolName: "searchDB" }));
    expect(s).toContain("searchDB");
  });

  it("falls back to event type when no specific format applies", () => {
    expect(summarizeEvent(evt({ type: "unknownEvent" }))).toBe("unknownEvent");
  });

  it("uses a '?' placeholder for a missing id instead of 'undefi'", () => {
    const s = summarizeEvent(evt({ type: "checkpointCreated", reason: "retry" }));
    expect(s).toContain("#?");
    expect(s).not.toContain("undefi");
  });
});

describe("summarizeSpanText", () => {
  it("llmCall shows duration + tokens + cost", () => {
    const s = summarizeSpanText("llmCall", { durationMs: 1200, tokens: 1500, cost: 0.007 });
    expect(s).toMatch(/llmCall/);
    expect(s).toMatch(/1\.2s/);
    expect(s).toMatch(/1500\s*tok/);
    expect(s).toMatch(/\$0\.007/);
  });

  it("is just the label when there are no metrics", () => {
    expect(summarizeSpanText("agentRun", {})).toBe("agentRun");
  });
});

describe("summarizeTraceText", () => {
  it("leads with local timestamp when firstTs is set, ends with short id", () => {
    const s = summarizeTraceText("abc123def456", Date.parse("2026-05-16T17:42:31Z"), {
      durationMs: 4200, tokens: 2300, cost: 0.01,
    });
    // Friendly format "May 16, h:mmam|pm"; the hour depends on the test
    // machine's timezone, so we don't pin it.
    expect(s).toMatch(/May 16, \d{1,2}:\d{2}(am|pm)/);
    expect(s).toMatch(/4\.2s/);
    expect(s).toMatch(/2300\s*tok/);
    expect(s).toMatch(/\$0\.010/);
    expect(s).toMatch(/\[abc123\]$/);
  });

  it("falls back to literal 'trace' header when firstTs is missing", () => {
    expect(summarizeTraceText("abc123", undefined, {})).toBe("trace  [abc123]");
  });
});
