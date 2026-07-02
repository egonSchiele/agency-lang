import { describe, it, expect } from "vitest";
import {
  summarize,
  summarizeSpan,
  summarizeTrace,
  summarizeSpanStyled,
} from "./summary.js";
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

  it("forkBranchEnd shows the returned value on success", () => {
    const s = summarize({
      format_version: 1,
      trace_id: "",
      project_id: "",
      span_id: null,
      parent_span_id: null,
      data: {
        type: "forkBranchEnd",
        timestamp: "",
        branchIndex: 0,
        outcome: "success",
        timeTaken: 653,
        value: 3,
      },
    });
    expect(s).toContain("forkBranchEnd #0");
    expect(s).toContain("success");
    expect(s).toContain("→ 3");
  });

  it("forkBranchEnd omits the value arrow when there is none (non-success)", () => {
    const s = summarize({
      format_version: 1,
      trace_id: "",
      project_id: "",
      span_id: null,
      parent_span_id: null,
      data: {
        type: "forkBranchEnd",
        timestamp: "",
        branchIndex: 1,
        outcome: "aborted",
        timeTaken: 10,
      },
    });
    expect(s).toContain("forkBranchEnd #1");
    expect(s).not.toContain("→");
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

  it("renders an empty short id (not 'undefi') when the id is missing", () => {
    // shortId previously did `(String(id) ?? "").slice(0,6)`, which for
    // a missing id produced "undefi" (the head of "undefined").
    const s = summarize({
      format_version: 1,
      trace_id: "",
      project_id: "",
      span_id: null,
      parent_span_id: null,
      // checkpointId omitted on purpose.
      data: { type: "checkpointCreated", timestamp: "", reason: "fork" },
    });
    expect(s).toBe("checkpointCreated # (fork)");
    expect(s).not.toContain("undefi");
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

describe("summarizeSpan — identifying detail", () => {
  const leaf = (data: any): TreeNode => ({
    id: `e-${data.type}`,
    traceId: "",
    parentId: null,
    children: [],
    nodeKind: "event",
    label: data.type,
    summary: data.type,
    event: {
      format_version: 1,
      trace_id: "",
      project_id: "",
      span_id: null,
      parent_span_id: null,
      data: { timestamp: "", ...data },
    },
  });

  const spanNode = (
    label: string,
    children: TreeNode[],
    extra: Partial<TreeNode> = {},
  ): TreeNode => ({
    id: "s",
    traceId: "",
    parentId: null,
    children,
    nodeKind: "span",
    label,
    summary: "",
    ...extra,
  });

  it("nodeExecution shows the node name", () => {
    const node = spanNode("nodeExecution", [leaf({ type: "enterNode", nodeId: "agent" })], { duration: 5600 });
    expect(summarizeSpan(node)).toBe('nodeExecution "agent" (5.6s)');
  });

  it("agentRun shows the entry node", () => {
    const node = spanNode("agentRun", [leaf({ type: "agentStart", entryNode: "main" })]);
    expect(summarizeSpan(node)).toBe('agentRun "main"');
  });

  it("toolExecution shows the tool name", () => {
    const node = spanNode("toolExecution", [leaf({ type: "toolCallStart", toolName: "fib" }), leaf({ type: "toolCall", toolName: "fib" })], { duration: 3000 });
    expect(summarizeSpan(node)).toBe("toolExecution fib (3.0s)");
  });

  it("forkAll shows the branch count", () => {
    const node = spanNode("forkAll", [leaf({ type: "forkStart", mode: "all", branchCount: 5 })], { duration: 3000 });
    expect(summarizeSpan(node)).toBe("forkAll 5 branches (3.0s)");
  });

  it("subprocessRun shows the node name (and resume mode)", () => {
    const fresh = spanNode(
      "subprocessRun",
      [leaf({ type: "subprocessStarted", moduleId: "m", node: "main", subprocessSessionId: "s1", mode: "run", depth: 1 })],
      { duration: 3000 },
    );
    expect(summarizeSpan(fresh)).toBe('subprocessRun "main" (3.0s)');

    const resumed = spanNode(
      "subprocessRun",
      [leaf({ type: "subprocessStarted", moduleId: "m", node: "main", subprocessSessionId: "s1", mode: "resume", depth: 1 })],
      { duration: 3000 },
    );
    expect(summarizeSpan(resumed)).toBe('subprocessRun "main" · resume (3.0s)');
  });

  it("llmCall shows model, prompt preview, and outcome", () => {
    const node = spanNode(
      "llmCall",
      [
        leaf({
          type: "promptCompletion",
          model: '"gpt-4o-mini"',
          messages: [{ role: "user", content: "Calculate the 2th Fibonacci number." }],
          completion: { output: '{"response":1}' },
        }),
      ],
      { duration: 2900, tokens: 62 },
    );
    const s = summarizeSpan(node);
    expect(s).toContain("llmCall gpt-4o-mini");
    expect(s).toContain('· "Calculate the 2th Fibonacci');
    expect(s).toContain('→ {"response":1}');
    expect(s).toContain("(2.9s, 62 tok)");
  });

  it("llmCall outcome names the tool when the completion is a tool call", () => {
    const node = spanNode("llmCall", [
      leaf({
        type: "promptCompletion",
        model: '"gpt-4o-mini"',
        messages: [{ role: "user", content: "Use the getArea tool" }],
        completion: { output: null, toolCalls: [{ id: "c", name: "getArea", arguments: {} }] },
      }),
    ]);
    expect(summarizeSpan(node)).toContain("→ tool: getArea");
  });

  it("llmCall uses the first round's prompt and the last round's outcome", () => {
    const node = spanNode("llmCall", [
      leaf({
        type: "promptCompletion",
        model: '"gpt-4o-mini"',
        messages: [{ role: "user", content: "outer request" }],
        completion: { output: null, toolCalls: [{ id: "c", name: "tool", arguments: {} }] },
      }),
      leaf({
        type: "promptCompletion",
        model: '"gpt-4o-mini"',
        messages: [{ role: "user", content: "outer request" }, { role: "tool", content: "x" }],
        completion: { output: "final answer" },
      }),
    ]);
    const s = summarizeSpan(node);
    expect(s).toContain('· "outer request"');
    expect(s).toContain("→ final answer");
  });

  it("falls back to the bare label when no detail event is present", () => {
    const node = spanNode("nodeExecution", [], { duration: 100 });
    expect(summarizeSpan(node)).toBe("nodeExecution (100ms)");
  });

  it("styled variant includes the detail too", () => {
    const node = spanNode("toolExecution", [leaf({ type: "toolCall", toolName: "fib" })], { duration: 3000 });
    expect(summarizeSpanStyled(node)).toContain("toolExecution fib");
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
    // Friendly format: "May 16, h:mmam|pm". The hour depends on the
    // test machine's timezone, so we don't pin it.
    expect(s).toMatch(/May 16, \d{1,2}:\d{2}(am|pm)/);
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

describe("summarizeSpanStyled", () => {
  const makeNode = (duration?: number, cost?: number): TreeNode => ({
    id: "s",
    traceId: "",
    parentId: null,
    children: [],
    nodeKind: "span",
    label: "llmCall",
    summary: "",
    duration,
    cost,
  });

  it("wraps slow durations in bright-red tags", () => {
    const s = summarizeSpanStyled(makeNode(10_000));
    expect(s).toMatch(/\{bright-red-fg\}10\.0s\{\/bright-red-fg\}/);
  });

  it("wraps fast durations in gray tags", () => {
    const s = summarizeSpanStyled(makeNode(50));
    expect(s).toMatch(/\{gray-fg\}50ms\{\/gray-fg\}/);
  });

  it("leaves normal-range durations untagged", () => {
    const s = summarizeSpanStyled(makeNode(500));
    expect(s).toContain("500ms");
    expect(s).not.toMatch(/\{[a-z-]+-fg\}500ms/);
  });

  it("wraps expensive costs in bright-red tags", () => {
    const s = summarizeSpanStyled(makeNode(undefined, 0.05));
    expect(s).toMatch(/\{bright-red-fg\}\$0\.050\{\/bright-red-fg\}/);
  });

  it("does not color token counts", () => {
    const n = makeNode();
    n.tokens = 1500;
    const s = summarizeSpanStyled(n);
    expect(s).toContain("1500 tok");
    expect(s).not.toMatch(/\{[a-z-]+-fg\}1500 tok/);
  });
});
