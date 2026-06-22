import { describe, it, expect } from "vitest";
import { buildForest } from "./tree.js";
import { flattenVisibleRows, renderRowText } from "./render.js";
import { EventEnvelope, TreeNode, ViewerState } from "./types.js";

// End-to-end: feed a realistic statelog through the WHOLE viewer
// pipeline (buildForest → flattenVisibleRows → renderRowText) and assert
// the composed behavior of every recent change at once:
//   - the grouped/flattened llmCall view with the tool execution
//     spliced inline,
//   - a non-string (array) tool result rendered as JSON,
//   - identifying detail in span summaries (node/tool names, branch
//     count, model + prompt + outcome),
//   - forkBranchEnd values,
//   - wall-clock envelope durations with parent ⊇ child.
//
// Scenario (mirrors bar.agency, shrunk to 2 fork branches):
//   agent → llm("use fibonacciNumbers") → tool forks 2 parallel llms.

const E = (
  spanId: string | null,
  parentSpanId: string | null,
  data: any,
): EventEnvelope => ({
  format_version: 1,
  trace_id: "t1",
  project_id: "p",
  span_id: spanId,
  parent_span_id: parentSpanId,
  data,
});

const TS = (sec: string) => `2026-06-21T00:00:0${sec}Z`;
const TOOLCALL = { id: "c1", name: "fibonacciNumbers", arguments: { num: 2 } };

const events: EventEnvelope[] = [
  E("A", null, { type: "agentStart", timestamp: TS("0.000"), entryNode: "main" }),
  E("N", "A", { type: "enterNode", timestamp: TS("0.100"), nodeId: "agent" }),
  // Round 1: the model asks for the tool.
  E("L", "N", {
    type: "promptCompletion",
    timestamp: TS("1.000"),
    timeTaken: 1000,
    model: '"gpt-4o-mini"',
    messages: [{ role: "user", content: "Use the fibonacciNumbers tool" }],
    completion: { output: null, toolCalls: [TOOLCALL] },
  }),
  // The tool execution: forks two parallel llm() calls.
  E("T", "L", { type: "toolCallStart", timestamp: TS("1.000"), toolName: "fibonacciNumbers" }),
  E("F", "T", { type: "forkStart", timestamp: TS("1.100"), mode: "all", branchCount: 2 }),
  E("B1", "F", {
    type: "promptCompletion",
    timestamp: TS("4.000"),
    timeTaken: 2800,
    model: '"gpt-4o-mini"',
    messages: [{ role: "user", content: "Calculate the 0th Fibonacci number" }],
    completion: { output: '{"response":0}' },
  }),
  E("B2", "F", {
    type: "promptCompletion",
    timestamp: TS("4.000"),
    timeTaken: 2900,
    model: '"gpt-4o-mini"',
    messages: [{ role: "user", content: "Calculate the 1th Fibonacci number" }],
    completion: { output: '{"response":1}' },
  }),
  E("F", "T", { type: "forkBranchEnd", timestamp: TS("4.000"), branchIndex: 0, outcome: "success", timeTaken: 2800, value: 0 }),
  E("F", "T", { type: "forkBranchEnd", timestamp: TS("4.000"), branchIndex: 1, outcome: "success", timeTaken: 2900, value: 1 }),
  E("F", "T", { type: "forkEnd", timestamp: TS("4.100"), mode: "all", timeTaken: 3000 }),
  E("T", "L", { type: "toolCall", timestamp: TS("4.100"), toolName: "fibonacciNumbers", output: [0, 1], timeTaken: 3000 }),
  // Round 2: the final answer. The tool message content is the RAW array.
  E("L", "N", {
    type: "promptCompletion",
    timestamp: TS("5.000"),
    timeTaken: 1000,
    model: '"gpt-4o-mini"',
    messages: [
      { role: "user", content: "Use the fibonacciNumbers tool" },
      { role: "assistant", content: null, toolCalls: [TOOLCALL] },
      { role: "tool", name: "fibonacciNumbers", content: [0, 1], tool_call_id: "c1" },
    ],
    completion: { output: '{"response":[0,1]}' },
  }),
  E("N", "A", { type: "exitNode", timestamp: TS("5.100"), nodeId: "agent" }),
  E("A", null, { type: "agentEnd", timestamp: TS("5.500"), timeTaken: 5500 }),
];

function buildState(): { roots: TreeNode[]; state: ViewerState } {
  const roots = buildForest(events);
  const expanded = new Set<string>();
  const walk = (n: TreeNode): void => {
    expanded.add(n.id);
    for (const c of n.children) walk(c);
  };
  roots.forEach(walk);
  return {
    roots,
    state: { roots, expanded, cursorId: roots[0].id, scrollTop: 0, quit: false, viewportCols: 200 },
  };
}

function findNode(roots: TreeNode[], id: string): TreeNode {
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.id === id) return n;
    stack.push(...n.children);
  }
  throw new Error(`node ${id} not found`);
}

// Strip ANSI color escapes and {…-fg} style tags so substring asserts
// match the visible text.
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b?\[[0-9;]*m/g, "").replace(/\{\/?[a-z-]+\}/g, "");
}

describe("logs viewer — end-to-end render", () => {
  const { roots, state } = buildState();
  const text = clean(
    flattenVisibleRows(state)
      .map((r) => renderRowText(r, false, state.expanded.has(r.node.id), {}))
      .join("\n"),
  );

  it("groups the outer llm() into one flattened conversation with the tool spliced inline", () => {
    // Conversation appears once, in order, with the tool execution between
    // the assistant tool-call line and the tool-result line.
    const lines = text.split("\n").map((l) => l.trim());
    const idxAsstCall = lines.findIndex((l) => l.includes("tool call: fibonacciNumbers"));
    const idxToolExec = lines.findIndex((l) => l.startsWith("▼ toolExecution") || l.startsWith("▶ toolExecution"));
    const idxToolResult = lines.findIndex((l) => l.includes("[tool: fibonacciNumbers]"));
    expect(idxAsstCall).toBeGreaterThanOrEqual(0);
    expect(idxToolExec).toBeGreaterThan(idxAsstCall);
    expect(idxToolResult).toBeGreaterThan(idxToolExec);
  });

  it("renders the array tool result as JSON (not blank)", () => {
    expect(text).toContain("[tool: fibonacciNumbers] [0,1]");
  });

  it("shows identifying detail in span summaries", () => {
    expect(text).toContain('nodeExecution "agent"');
    expect(text).toContain("toolExecution fibonacciNumbers");
    expect(text).toContain("forkAll 2 branches");
    expect(text).toContain("agentRun \"main\"");
  });

  it("makes the parallel branch llmCalls distinguishable by prompt and outcome", () => {
    expect(text).toContain('· "Calculate the 0th Fibonacci');
    expect(text).toContain('· "Calculate the 1th Fibonacci');
    expect(text).toContain("gpt-4o-mini");
  });

  it("shows forkBranchEnd return values", () => {
    expect(text).toMatch(/forkBranchEnd #0 \(success.*\) → 0/);
    expect(text).toMatch(/forkBranchEnd #1 \(success.*\) → 1/);
  });

  it("computes wall-clock durations with parent ⊇ child (no parallel summing)", () => {
    const node = findNode(roots, "N"); // nodeExecution
    const outer = findNode(roots, "L"); // outer llmCall
    const tool = findNode(roots, "T"); // toolExecution
    const fork = findNode(roots, "F"); // forkAll
    const branch = findNode(roots, "B1"); // a branch llmCall
    // The outer call ran ~5s wall-clock, NOT the ~8.7s sum of its rounds
    // plus the two parallel branches.
    expect(outer.duration).toBe(5000);
    expect(outer.duration!).toBeLessThanOrEqual(node.duration!);
    expect(tool.duration!).toBeLessThanOrEqual(outer.duration!);
    expect(fork.duration!).toBeLessThanOrEqual(tool.duration!);
    expect(branch.duration!).toBeLessThanOrEqual(fork.duration!);
  });
});
