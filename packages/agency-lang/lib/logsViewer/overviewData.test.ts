import { describe, expect, it } from "vitest";

import { overviewData } from "./overviewData.js";
import { parseStatelogJsonl } from "./parse.js";
import { buildForest } from "./tree.js";
import { leaf, span, trace } from "./timeline/fixture.js";

function fixture() {
  const rounds = [
    leaf("promptCompletion", 1_000, {
      model: '"m1"',
      timeTaken: 100,
      usage: { inputTokens: 20, cachedInputTokens: 100, outputTokens: 5 },
      cost: { totalCost: 0.01 },
    }),
    leaf("promptCompletion", 2_000, {
      model: '"m1"',
      timeTaken: 800,
      usage: { inputTokens: 30, cachedInputTokens: 200, outputTokens: 6 },
      cost: { totalCost: 0.02 },
    }),
    leaf("promptCompletion", 3_000, {
      model: '"m1"',
      timeTaken: 200,
      usage: { inputTokens: 40, cachedInputTokens: 2_000, outputTokens: 7 },
      cost: { totalCost: 0.015 },
    }),
  ];
  return trace([
    span("llmCall", rounds, { id: "L" }),
    span("toolExecution", [leaf("toolCallStart", 100), leaf("toolCall", 200)], { id: "t1" }),
    span("toolExecution", [leaf("toolCallStart", 300), leaf("toolCall", 400)], { id: "t2" }),
    leaf("interruptResolved", 500, { outcome: "approved" }),
    leaf("interruptResolved", 600, { outcome: "rejected" }),
    leaf("error", 700),
  ]);
}

describe("overviewData", () => {
  it("selects the slowest, priciest and biggest rounds", () => {
    const data = overviewData(fixture(), () => 4_000);
    expect(data.callouts.map((callout) => [callout.label, callout.round.id])).toEqual([
      ["slowest", "round:L:1"],
      ["priciest", "round:L:1"],
      ["biggest", "round:L:2"],
    ]);
  });

  it("counts tools, approvals, rejections and errors independently", () => {
    expect(overviewData(fixture(), () => undefined).counts).toEqual({
      toolCalls: 2,
      approved: 1,
      rejected: 1,
      errors: 1,
    });
  });

  it("combines groups after the sixth into other", () => {
    const tools = Array.from({ length: 8 }, (_unused, position) =>
      span(
        "toolExecution",
        [
          leaf("toolCallStart", position * 100, { toolName: `tool${position}` }),
          leaf("toolCall", position * 100 + 50, { toolName: `tool${position}` }),
        ],
        { id: `tool-${position}` },
      ),
    );
    const data = overviewData(trace(tools), () => undefined);
    expect(data.timeBars).toHaveLength(7);
    expect(data.timeBars.at(-1)?.label).toBe("other");
    expect(data.timeBars.at(-1)?.calls).toBe(2);
  });

  it("uses trace-root rounds for elapsed time", () => {
    const data = overviewData(
      trace([leaf("promptCompletion", 1_000, { timeTaken: 100 })]),
      () => undefined,
    );
    expect(data.elapsedMs).toBe(100);
  });

  it("reports a pending root prompt after an earlier completed prompt", () => {
    const jsonl = [
      event("promptStart", 0),
      event("promptCompletion", 100, { timeTaken: 100 }),
      event("promptStart", 200),
    ].join("\n");
    const roots = buildForest(parseStatelogJsonl(jsonl).events);
    expect(overviewData(roots[0], () => undefined).running).toBe(true);
  });
});

function event(type: string, at: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format_version: 1,
    trace_id: "T",
    project_id: "p",
    span_id: null,
    parent_span_id: null,
    data: { type, timestamp: new Date(at).toISOString(), ...extra },
  });
}
