import { describe, it, expect } from "vitest";
import { buildForest } from "./tree.js";
import { findNode } from "./forest.js";
import { outlineRows } from "./story.js";
import { payloadFor } from "./payload.js";
import type { EventEnvelope } from "./types.js";
const envelope = (
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

const timestamp = (sec: string) => `2026-06-21T00:00:0${sec}Z`;
const TOOLCALL = { id: "c1", name: "fibonacciNumbers", arguments: { num: 2 } };

const events: EventEnvelope[] = [
  envelope("A", null, { type: "agentStart", timestamp: timestamp("0.000"), entryNode: "main" }),
  envelope("N", "A", { type: "enterNode", timestamp: timestamp("0.100"), nodeId: "agent" }),
  // Round 1: the model asks for the tool.
  envelope("L", "N", {
    type: "promptCompletion",
    timestamp: timestamp("1.000"),
    timeTaken: 1000,
    model: '"gpt-4o-mini"',
    messages: [{ role: "user", content: "Use the fibonacciNumbers tool" }],
    completion: { output: null, toolCalls: [TOOLCALL] },
  }),
  // The tool execution: forks two parallel llm() calls.
  envelope("T", "L", {
    type: "toolCallStart",
    timestamp: timestamp("1.000"),
    toolName: "fibonacciNumbers",
  }),
  envelope("F", "T", {
    type: "forkStart",
    timestamp: timestamp("1.100"),
    mode: "all",
    branchCount: 2,
  }),
  envelope("B1", "F", {
    type: "promptCompletion",
    timestamp: timestamp("4.000"),
    timeTaken: 2800,
    model: '"gpt-4o-mini"',
    messages: [{ role: "user", content: "Calculate the 0th Fibonacci number" }],
    completion: { output: '{"response":0}' },
  }),
  envelope("B2", "F", {
    type: "promptCompletion",
    timestamp: timestamp("4.000"),
    timeTaken: 2900,
    model: '"gpt-4o-mini"',
    messages: [{ role: "user", content: "Calculate the 1th Fibonacci number" }],
    completion: { output: '{"response":1}' },
  }),
  envelope("F", "T", {
    type: "forkBranchEnd",
    timestamp: timestamp("4.000"),
    branchIndex: 0,
    outcome: "success",
    timeTaken: 2800,
    value: 0,
  }),
  envelope("F", "T", {
    type: "forkBranchEnd",
    timestamp: timestamp("4.000"),
    branchIndex: 1,
    outcome: "success",
    timeTaken: 2900,
    value: 1,
  }),
  envelope("F", "T", {
    type: "forkEnd",
    timestamp: timestamp("4.100"),
    mode: "all",
    timeTaken: 3000,
  }),
  envelope("T", "L", {
    type: "toolCall",
    timestamp: timestamp("4.100"),
    toolName: "fibonacciNumbers",
    output: [0, 1],
    timeTaken: 3000,
  }),
  // Round 2: the final answer. The tool message content is the RAW array.
  envelope("L", "N", {
    type: "promptCompletion",
    timestamp: timestamp("5.000"),
    timeTaken: 1000,
    model: '"gpt-4o-mini"',
    messages: [
      { role: "user", content: "Use the fibonacciNumbers tool" },
      { role: "assistant", content: null, toolCalls: [TOOLCALL] },
      { role: "tool", name: "fibonacciNumbers", content: [0, 1], tool_call_id: "c1" },
    ],
    completion: { output: '{"response":[0,1]}' },
  }),
  envelope("N", "A", { type: "exitNode", timestamp: timestamp("5.100"), nodeId: "agent" }),
  envelope("A", null, { type: "agentEnd", timestamp: timestamp("5.500"), timeTaken: 5500 }),
];

describe("parallel trace story", () => {
  const roots = buildForest(events);
  const rows = outlineRows(roots[0], { machinery: false, admin: false });
  it("keeps the requested tool between its round and the following answer", () => {
    const roundAt = rows.findIndex((row) => row.id === "round:L:0");
    const toolAt = rows.findIndex((row) => row.id === "T");
    expect(toolAt).toBeGreaterThan(roundAt);
    expect(rows.findIndex((row) => row.id === "round:L:1")).toBeGreaterThan(toolAt);
  });
  it("preserves array results and fork return values in payloads", () => {
    const tool = rows.find((row) => row.id === "T")!;
    expect(
      payloadFor(tool, { raw: true })
        .map((line) => ("text" in line ? line.text : ""))
        .join("\n"),
    ).toContain('"output"');
    const raw = outlineRows(roots[0], { machinery: true, admin: true });
    const text = raw.map((row) => (row.kind === "machinery" ? row.text : "")).join("\n");
    expect(text).toMatch(/forkBranchEnd #0.*→ 0/);
    expect(text).toMatch(/forkBranchEnd #1.*→ 1/);
    expect(text).toContain('nodeExecution "agent"');
    expect(text).toContain("forkAll 2 branches");
  });
  it("distinguishes parallel nested LLM rounds and preserves wall-clock envelopes", () => {
    expect(rows.filter((row) => row.kind === "llmGroup")).toHaveLength(2);
    expect(rows.filter((row) => row.kind === "round")).toHaveLength(4);
    const node = findNode(roots, "N")!;
    const outer = findNode(roots, "L")!;
    const tool = findNode(roots, "T")!;
    const fork = findNode(roots, "F")!;
    const branch = findNode(roots, "B1")!;
    expect(outer.duration).toBe(5000);
    expect(outer.duration!).toBeLessThanOrEqual(node.duration!);
    expect(tool.duration!).toBeLessThanOrEqual(outer.duration!);
    expect(fork.duration!).toBeLessThanOrEqual(tool.duration!);
    expect(branch.duration!).toBeLessThanOrEqual(fork.duration!);
  });
});
