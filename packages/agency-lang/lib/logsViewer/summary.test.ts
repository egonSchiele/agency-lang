import { describe, it, expect } from "vitest";
import { summarize, summarizeSpan, summarizeTrace } from "./summary.js";
import { TreeNode } from "./types.js";

describe("summarize (leaf events)", () => {
  it("promptCompletion shows model and duration", () => {
    const s = summarize({
      format_version: 1,
      trace_id: "",
      project_id: "",
      span_id: null,
      parent_span_id: null,
      data: {
        type: "promptCompletion",
        timestamp: "",
        model: '"gpt-4o"',
        timeTaken: 1234,
      },
    });
    expect(s).toMatch(/gpt-4o/);
    expect(s).toMatch(/1\.2s|1234ms/);
  });

  it("error shows errorType and message prefix", () => {
    const s = summarize({
      format_version: 1,
      trace_id: "",
      project_id: "",
      span_id: null,
      parent_span_id: null,
      data: {
        type: "error",
        timestamp: "",
        errorType: "ToolFailure",
        message: "tool blew up because the API rate-limited us",
      },
    });
    expect(s).toContain("ToolFailure");
    expect(s).toContain("tool blew up");
  });

  it("toolCall shows the tool name", () => {
    const s = summarize({
      format_version: 1,
      trace_id: "",
      project_id: "",
      span_id: null,
      parent_span_id: null,
      data: { type: "toolCall", timestamp: "", toolName: "searchDB" },
    });
    expect(s).toContain("searchDB");
  });

  it("falls back to event type when no specific format applies", () => {
    const s = summarize({
      format_version: 1,
      trace_id: "",
      project_id: "",
      span_id: null,
      parent_span_id: null,
      data: { type: "unknownEvent", timestamp: "" },
    });
    expect(s).toBe("unknownEvent");
  });
});

describe("summarizeSpan", () => {
  it("llmCall shows duration + tokens + cost", () => {
    const node: TreeNode = {
      id: "s",
      traceId: "",
      parentId: null,
      children: [],
      nodeKind: "span",
      label: "llmCall",
      summary: "",
      duration: 1200,
      tokens: 1500,
      cost: 0.007,
    };
    const s = summarizeSpan(node);
    expect(s).toMatch(/llmCall/);
    expect(s).toMatch(/1\.2s/);
    expect(s).toMatch(/1500\s*tok/);
    expect(s).toMatch(/\$0\.007/);
  });
});

describe("summarizeTrace", () => {
  it("leads with local timestamp when firstTs is set, ends with short id", () => {
    const node: TreeNode = {
      id: "trace-abc123def456",
      traceId: "abc123def456",
      parentId: null,
      children: [],
      nodeKind: "trace",
      label: "abc123def456",
      summary: "",
      duration: 4200,
      tokens: 2300,
      cost: 0.01,
      firstTs: Date.parse("2026-05-16T17:42:31Z"),
    };
    const s = summarizeTrace(node);
    // Should match a local timestamp like 2026-05-16 HH:MM:SS — we
    // don't pin the HH because the test runs in any timezone.
    expect(s).toMatch(/2026-05-16 \d{2}:\d{2}:\d{2}/);
    expect(s).toMatch(/4\.2s/);
    expect(s).toMatch(/2300\s*tok/);
    expect(s).toMatch(/\$0\.010/);
    expect(s).toMatch(/\[abc123\]$/);
  });

  it("falls back to literal 'trace' header when firstTs is missing", () => {
    const node: TreeNode = {
      id: "trace-abc123",
      traceId: "abc123",
      parentId: null,
      children: [],
      nodeKind: "trace",
      label: "abc123",
      summary: "",
    };
    expect(summarizeTrace(node)).toBe("trace  [abc123]");
  });
});
