import { describe, expect, it } from "vitest";

import { leaf, span, trace } from "./fixture.js";
import { roundsOf } from "./rounds.js";
import { drawsRoundRows, rowIdFor, timelineRows } from "./rows.js";
import { timelineSpans } from "./spans.js";

function completion(at: number) {
  return leaf("promptCompletion", at, { model: '"m"', threadId: "1", timeTaken: 100 });
}
function tool(id: string, start: number, end: number) {
  return span(
    "toolExecution",
    [
      leaf("toolCallStart", start, { toolName: id }),
      leaf("toolCall", end, { toolName: id, timeTaken: end - start }),
    ],
    { id },
  );
}
function describeRows(root: ReturnType<typeof trace>) {
  const spans = timelineSpans(root, { hideKinds: [] });
  const rounds = roundsOf(root);
  return { rows: timelineRows(spans, rounds), rounds };
}

describe("timelineRows", () => {
  it("nests tools beneath the completed call that requested them", () => {
    const loop = span(
      "llmCall",
      [
        completion(1000),
        tool("grep", 1100, 1500),
        completion(2000),
        tool("read", 2100, 2400),
        completion(3000),
      ],
      { id: "L" },
    );
    const { rows } = describeRows(trace([loop]));
    expect(rows.map((row) => `${row.depth}:${row.id}`)).toEqual([
      "0:L",
      "1:round:L:0",
      "2:grep",
      "1:round:L:1",
      "2:read",
      "1:round:L:2",
    ]);
  });

  it("draws no round row for a call with one round", () => {
    const { rows, rounds } = describeRows(
      trace([span("llmCall", [completion(1000)], { id: "L" })]),
    );
    expect(rows.map((row) => row.id)).toEqual(["L"]);
    expect(drawsRoundRows(rounds)).toBe(false);
  });

  it("keeps a tool's own subtree together", () => {
    const sub = span("llmCall", [completion(1300)], { id: "S" });
    const agentTool = span(
      "toolExecution",
      [
        leaf("toolCallStart", 1100, { toolName: "agent" }),
        sub,
        leaf("toolCall", 1500, { toolName: "agent" }),
      ],
      { id: "agent" },
    );
    const loop = span("llmCall", [completion(1000), agentTool, completion(2000)], { id: "L" });
    const { rows } = describeRows(trace([loop]));
    expect(rows.map((row) => `${row.depth}:${row.id}`)).toEqual([
      "0:L",
      "1:round:L:0",
      "2:agent",
      "3:S",
      "1:round:L:1",
    ]);
  });

  it("draws a lone call when it owns tools, keeping parallel tools together and their timings intact", () => {
    const root = trace([
      span("llmCall", [completion(1000), tool("first", 1000, 3000), tool("second", 1100, 1500)], {
        id: "L",
      }),
    ]);
    const spans = timelineSpans(root, { hideKinds: [] });
    const rows = timelineRows(spans, roundsOf(root));
    expect(rows.map((row) => `${row.depth}:${row.id}`)).toEqual([
      "0:L",
      "1:round:L:0",
      "2:first",
      "2:second",
    ]);
    expect(rows.flatMap((row) => (row.kind === "span" ? [row.span] : []))).toEqual(spans);
  });

  it("does not put earlier tools or unrelated span kinds under a later completion", () => {
    const root = trace([
      span(
        "llmCall",
        [
          tool("before", 500, 800),
          completion(1000),
          span("nodeExecution", [leaf("nodeEnd", 1200)], { id: "node" }),
          tool("after", 1300, 3000),
          completion(2000),
        ],
        { id: "L" },
      ),
    ]);
    expect(describeRows(root).rows.map((row) => `${row.depth}:${row.id}`)).toEqual([
      "0:L",
      "1:before",
      "1:round:L:0",
      "2:after",
      "1:node",
      "1:round:L:1",
    ]);
  });

  it("uses the recorded tool start when the inferred bar begins before its requesting call ends", () => {
    const root = trace([
      span(
        "llmCall",
        [
          completion(1000),
          span(
            "toolExecution",
            [leaf("toolCallStart", 1007), leaf("toolCall", 2000, { timeTaken: 1015 })],
            { id: "tool" },
          ),
        ],
        { id: "L" },
      ),
    ]);
    const { rows } = describeRows(root);
    expect(rows.map((row) => `${row.depth}:${row.id}`)).toEqual(["0:L", "1:round:L:0", "2:tool"]);
    const toolRow = rows.find((row) => row.id === "tool");
    expect(toolRow?.kind === "span" && toolRow.span.extent.start).toBe(985);
  });

  it("handles many sibling spans without deep recursion", () => {
    const many = Array.from({ length: 20000 }, (_unused, position) =>
      tool(`t${position}`, position * 10, position * 10 + 5),
    );
    const { rows } = describeRows(trace(many));
    expect(rows).toHaveLength(20000);
  });
});

describe("rowIdFor", () => {
  it("lands a lone round on its span", () => {
    const { rows, rounds } = describeRows(
      trace([span("llmCall", [completion(1000)], { id: "L" })]),
    );
    expect(rowIdFor("round:L:0", rows, rounds)).toBe("L");
  });
  it("draws a round that is not inside any span at the top level", () => {
    const root = trace([completion(1000), completion(2000), tool("grep", 1100, 1500)]);
    const spans = timelineSpans(root, { hideKinds: [] });
    const rounds = roundsOf(root);
    const rows = timelineRows(spans, rounds, root.id);
    expect(rows.map((row) => `${row.depth}:${row.id}`)).toEqual([
      `0:round:${root.id}:0`,
      "1:grep",
      `0:round:${root.id}:1`,
    ]);
  });

  it("keeps a single root round visible and focusable", () => {
    const root = trace([completion(1000)]);
    const rounds = roundsOf(root);
    const rows = timelineRows(timelineSpans(root, { hideKinds: [] }), rounds, root.id);
    expect(rows.map((row) => row.id)).toEqual([rounds[0].id]);
    expect(rowIdFor(rounds[0].id, rows, rounds)).toBe(rounds[0].id);
  });

  it("lands a drawn id on itself, and an unknown id nowhere", () => {
    const loop = span("llmCall", [completion(1000), completion(2000)], { id: "L" });
    const { rows, rounds } = describeRows(trace([loop]));
    expect(rowIdFor("round:L:1", rows, rounds)).toBe("round:L:1");
    expect(rowIdFor("nope", rows, rounds)).toBeUndefined();
  });
});
