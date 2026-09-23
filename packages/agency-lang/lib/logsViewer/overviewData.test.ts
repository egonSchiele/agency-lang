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
  it("uses individual request durations rather than the surrounding invocation", () => {
    const data = overviewData(fixture());
    expect(data.rounds.map((round) => round.durationMs)).toEqual([100, 800, 200]);
    expect(data.rounds.map((round) => round.id)).toEqual(["round:L:0", "round:L:1", "round:L:2"]);
    expect(data.costUsd).toBeCloseTo(0.045);
  });

  it("uses trace-root rounds for elapsed time", () => {
    const data = overviewData(trace([leaf("promptCompletion", 1_000, { timeTaken: 100 })]));
    expect(data.elapsedMs).toBe(100);
  });

  it("reports a pending root prompt after an earlier completed prompt", () => {
    const jsonl = [
      event("promptStart", 0),
      event("promptCompletion", 100, { timeTaken: 100 }),
      event("promptStart", 200),
    ].join("\n");
    const roots = buildForest(parseStatelogJsonl(jsonl).events);
    expect(overviewData(roots[0]).running).toBe(true);
  });

  it("does not let another span's completion close a pending prompt", () => {
    const jsonl = [
      event("promptStart", 0, {}, "A"),
      event("promptStart", 50, {}, "B"),
      event("promptCompletion", 100, { timeTaken: 100 }, "A"),
    ].join("\n");
    const roots = buildForest(parseStatelogJsonl(jsonl).events);
    expect(overviewData(roots[0]).running).toBe(true);
  });
});

function event(
  type: string,
  at: number,
  extra: Record<string, unknown> = {},
  spanId: string | null = null,
): string {
  return JSON.stringify({
    format_version: 1,
    trace_id: "T",
    project_id: "p",
    span_id: spanId,
    parent_span_id: null,
    data: { type, timestamp: new Date(at).toISOString(), ...extra },
  });
}

it("omits missing models from mixed named and unnamed rounds", () => {
  const root = trace([
    leaf("promptCompletion", 100),
    leaf("promptCompletion", 200, { model: '"m1"' }),
  ]);
  expect(overviewData(root).models).toEqual(["m1"]);
});
it.each(["runtimeError", "validationError", "limitExceeded", "structuredOutput", "finalizeError"])(
  "keeps a tool running after an unrelated %s",
  (errorType) => {
    const root = trace([
      span("toolExecution", [leaf("toolCallStart", 100), leaf("error", 200, { errorType })], {
        id: "tool",
      }),
    ]);
    expect(overviewData(root).running).toBe(true);
  },
);
it("ends a tool on a toolError", () => {
  const root = trace([
    span(
      "toolExecution",
      [leaf("toolCallStart", 100), leaf("error", 200, { errorType: "toolError" })],
      { id: "tool" },
    ),
  ]);
  expect(overviewData(root).running).toBe(false);
});
