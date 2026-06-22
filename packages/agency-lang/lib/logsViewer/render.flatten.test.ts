import { describe, it, expect } from "vitest";
import { buildForest } from "./tree.js";
import { flattenVisibleRows } from "./render.js";
import { EventEnvelope, TreeNode, ViewerState } from "./types.js";

// Build an envelope with sane defaults.
const evt = (over: Partial<EventEnvelope>): EventEnvelope => ({
  format_version: 1,
  trace_id: "t1",
  project_id: "p",
  span_id: null,
  parent_span_id: null,
  data: { type: "debug", timestamp: "2026-06-21T00:00:00Z" },
  ...over,
});

// Expand every span/trace node so the flattened conversation rows are
// produced. Leaves/synthetic rows don't need expanding for the span
// flatten, but expanding spans (incl. toolExecution + nested llmCall)
// exercises recursion.
function expandAll(roots: TreeNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (n: TreeNode): void => {
    if (n.nodeKind !== "event") ids.add(n.id);
    // Also expand event leaves so any non-flattened paths still open.
    if (n.nodeKind === "event") ids.add(n.id);
    for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);
  return ids;
}

function stateFor(events: EventEnvelope[]): ViewerState {
  const roots = buildForest(events);
  return {
    roots,
    expanded: expandAll(roots),
    cursorId: roots[0].id,
    scrollTop: 0,
    quit: false,
  };
}

// Summaries of the convoLine rows, in order, with ANSI color stripped
// so assertions are readable.
function convoSummaries(rows: { node: TreeNode }[]): string[] {
  return rows
    .filter((r) => r.node.nodeKind === "convoLine")
    .map((r) => stripAnsi(r.node.summary));
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "");
}

describe("llmCall span flatten", () => {
  it("single-round call → flattened user/assistant, no tool splice", () => {
    const rows = flattenVisibleRows(
      stateFor([
        evt({ span_id: "a", data: { type: "agentStart", timestamp: "2026-06-21T00:00:00Z" } }),
        evt({
          span_id: "L",
          parent_span_id: "a",
          data: {
            type: "promptCompletion",
            timestamp: "2026-06-21T00:00:01Z",
            messages: [{ role: "user", content: "hello" }],
            completion: { output: "hi there", toolCalls: [] },
          },
        }),
      ]),
    );
    const convos = convoSummaries(rows);
    expect(convos).toEqual(['[user] "hello"', '[assistant] "hi there"']);
    // No toolExecution row, but a raw-data toggle should be present.
    expect(rows.some((r) => r.node.nodeKind === "rawDataToggle")).toBe(true);
    // The intermediate promptCompletion leaf is absorbed (not shown).
    expect(rows.some((r) => r.node.label === "promptCompletion")).toBe(false);
  });

  it("multi-round tool call → one llmCall node with the tool execution spliced inline", () => {
    const rows = flattenVisibleRows(
      stateFor([
        evt({ span_id: "a", data: { type: "agentStart", timestamp: "2026-06-21T00:00:00Z" } }),
        // Round 1: assistant asks for getArea.
        evt({
          span_id: "L",
          parent_span_id: "a",
          data: {
            type: "promptCompletion",
            timestamp: "2026-06-21T00:00:01Z",
            messages: [{ role: "user", content: "Get the area of France" }],
            completion: {
              output: null,
              toolCalls: [{ id: "c1", name: "getArea", arguments: { country: "France" } }],
            },
          },
        }),
        // The tool execution (nested under the same llmCall span).
        evt({
          span_id: "T",
          parent_span_id: "L",
          data: { type: "toolCallStart", timestamp: "2026-06-21T00:00:02Z", toolName: "getArea" },
        }),
        evt({
          span_id: "T",
          parent_span_id: "L",
          data: { type: "toolCall", timestamp: "2026-06-21T00:00:03Z", toolName: "getArea", output: "551695" },
        }),
        // Round 2: final answer (holds the full transcript).
        evt({
          span_id: "L",
          parent_span_id: "a",
          data: {
            type: "promptCompletion",
            timestamp: "2026-06-21T00:00:04Z",
            messages: [
              { role: "user", content: "Get the area of France" },
              { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "getArea", arguments: { country: "France" } }] },
              { role: "tool", name: "getArea", content: "551695", tool_call_id: "c1" },
            ],
            completion: { output: "The area of France is 551,695 km²", toolCalls: [] },
          },
        }),
      ]),
    );

    // Conversation appears once, in order, with no duplication.
    const convos = convoSummaries(rows);
    expect(convos).toEqual([
      '[user] "Get the area of France"',
      '[assistant] tool call: getArea({"country":"France"})',
      '[tool: getArea] "551695"',
      '[assistant] "The area of France is 551,695 km²"',
    ]);

    // The toolExecution span is spliced between the assistant tool-call
    // line and the tool-result line.
    const kinds = rows
      .filter(
        (r) =>
          r.node.nodeKind === "convoLine" ||
          (r.node.nodeKind === "span" && r.node.label === "toolExecution"),
      )
      .map((r) =>
        r.node.nodeKind === "span" ? "toolExecution" : stripAnsi(r.node.summary),
      );
    expect(kinds).toEqual([
      '[user] "Get the area of France"',
      '[assistant] tool call: getArea({"country":"France"})',
      "toolExecution",
      '[tool: getArea] "551695"',
      '[assistant] "The area of France is 551,695 km²"',
    ]);

    // Exactly one llmCall span node at the top level (no sibling rounds).
    const llmNodes = rows.filter(
      (r) => r.node.nodeKind === "span" && r.node.label === "llmCall",
    );
    expect(llmNodes).toHaveLength(1);
  });

  it("parallel tool calls in one round → both executions spliced after the assistant message", () => {
    const rows = flattenVisibleRows(
      stateFor([
        evt({ span_id: "a", data: { type: "agentStart", timestamp: "2026-06-21T00:00:00Z" } }),
        evt({
          span_id: "L",
          parent_span_id: "a",
          data: {
            type: "promptCompletion",
            timestamp: "2026-06-21T00:00:01Z",
            messages: [{ role: "user", content: "do both" }],
            completion: {
              output: null,
              toolCalls: [
                { id: "c1", name: "toolA", arguments: {} },
                { id: "c2", name: "toolB", arguments: {} },
              ],
            },
          },
        }),
        evt({ span_id: "TA", parent_span_id: "L", data: { type: "toolCall", timestamp: "2026-06-21T00:00:02Z", toolName: "toolA", output: "a" } }),
        evt({ span_id: "TB", parent_span_id: "L", data: { type: "toolCall", timestamp: "2026-06-21T00:00:03Z", toolName: "toolB", output: "b" } }),
        evt({
          span_id: "L",
          parent_span_id: "a",
          data: {
            type: "promptCompletion",
            timestamp: "2026-06-21T00:00:04Z",
            messages: [
              { role: "user", content: "do both" },
              { role: "assistant", content: null, toolCalls: [
                { id: "c1", name: "toolA", arguments: {} },
                { id: "c2", name: "toolB", arguments: {} },
              ] },
              { role: "tool", name: "toolA", content: "a", tool_call_id: "c1" },
              { role: "tool", name: "toolB", content: "b", tool_call_id: "c2" },
            ],
            completion: { output: "done", toolCalls: [] },
          },
        }),
      ]),
    );
    // The assistant turn produces one "tool call" line per call (2),
    // then both tool executions are spliced after, in order.
    const seq = rows
      .filter(
        (r) =>
          (r.node.nodeKind === "span" && r.node.label === "toolExecution") ||
          (r.node.nodeKind === "convoLine" && r.node.summary.includes("tool call")),
      )
      .map((r) => (r.node.nodeKind === "span" ? "exec" : "tool-call-line"));
    expect(seq).toEqual(["tool-call-line", "tool-call-line", "exec", "exec"]);
  });

  it("nested llm() inside a tool flattens recursively", () => {
    const rows = flattenVisibleRows(
      stateFor([
        evt({ span_id: "a", data: { type: "agentStart", timestamp: "2026-06-21T00:00:00Z" } }),
        evt({
          span_id: "L",
          parent_span_id: "a",
          data: {
            type: "promptCompletion",
            timestamp: "2026-06-21T00:00:01Z",
            messages: [{ role: "user", content: "outer" }],
            completion: { output: null, toolCalls: [{ id: "c1", name: "getArea", arguments: {} }] },
          },
        }),
        evt({ span_id: "T", parent_span_id: "L", data: { type: "toolCall", timestamp: "2026-06-21T00:00:05Z", toolName: "getArea", output: "x" } }),
        // getArea's own llm() — a nested llmCall span under the tool.
        evt({
          span_id: "L2",
          parent_span_id: "T",
          data: {
            type: "promptCompletion",
            timestamp: "2026-06-21T00:00:03Z",
            messages: [{ role: "user", content: "What is the area?" }],
            completion: { output: "about 551,695", toolCalls: [] },
          },
        }),
        evt({
          span_id: "L",
          parent_span_id: "a",
          data: {
            type: "promptCompletion",
            timestamp: "2026-06-21T00:00:06Z",
            messages: [
              { role: "user", content: "outer" },
              { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "getArea", arguments: {} }] },
              { role: "tool", name: "getArea", content: "about 551,695", tool_call_id: "c1" },
            ],
            completion: { output: "final", toolCalls: [] },
          },
        }),
      ]),
    );
    const convos = convoSummaries(rows);
    // Outer conversation + the nested call's own conversation both show.
    expect(convos).toContain('[user] "outer"');
    expect(convos).toContain('[user] "What is the area?"');
    expect(convos).toContain('[assistant] "about 551,695"');
    expect(convos).toContain('[assistant] "final"');
  });
});
