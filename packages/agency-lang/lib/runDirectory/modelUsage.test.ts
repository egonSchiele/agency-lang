import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@/statelog/wireTypes.js";
import { modelUsageOf, sumModelUsage, type ModelUsage } from "./modelUsage.js";
import { statelogLine } from "./testFixtures.js";

function event(type: string, extra: Record<string, unknown> = {}): EventEnvelope {
  return JSON.parse(statelogLine("t", type, extra)) as EventEnvelope;
}

function completion({
  model,
  reasoningEffort,
  input = 0,
  cached = 0,
  cacheWrite = 0,
  output = 0,
  cost = 0,
}: {
  model: string;
  reasoningEffort?: string | null;
  input?: number;
  cached?: number;
  cacheWrite?: number;
  output?: number;
  cost?: number;
}): EventEnvelope {
  return event("promptCompletion", {
    model: JSON.stringify(model),
    reasoningEffort: reasoningEffort ?? null,
    usage: {
      inputTokens: input,
      cachedInputTokens: cached,
      cacheCreationInputTokens: cacheWrite,
      outputTokens: output,
    },
    cost: { totalCost: cost },
  });
}

function entry(fields: Partial<ModelUsage> & { name: string }): ModelUsage {
  return {
    reasoning: null,
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    ...fields,
  };
}

const mixedRun = [
  completion({
    model: "opus",
    reasoningEffort: "high",
    input: 100,
    cached: 1000,
    cacheWrite: 5,
    output: 10,
    cost: 0.25,
  }),
  completion({
    model: "opus",
    reasoningEffort: "high",
    input: 200,
    cached: 2000,
    cacheWrite: 0,
    output: 20,
    cost: 0.5,
  }),
  completion({ model: "opus", reasoningEffort: "low", input: 50, output: 5, cost: 0.125 }),
  completion({ model: "jev", input: 30, output: 3, cost: 0.0625 }),
];

describe("modelUsageOf", () => {
  it("one entry per model and level, summed", () => {
    expect(modelUsageOf({ events: mixedRun, fallbackReasoning: null })).toEqual([
      entry({ name: "jev", calls: 1, inputTokens: 30, outputTokens: 3, costUsd: 0.0625 }),
      entry({
        name: "opus",
        reasoning: "high",
        calls: 2,
        inputTokens: 300,
        cachedInputTokens: 3000,
        cacheCreationInputTokens: 5,
        outputTokens: 30,
        costUsd: 0.75,
      }),
      entry({
        name: "opus",
        reasoning: "low",
        calls: 1,
        inputTokens: 50,
        outputTokens: 5,
        costUsd: 0.125,
      }),
    ]);
  });

  it("a call with no level takes the fallback", () => {
    const usage = modelUsageOf({ events: mixedRun, fallbackReasoning: "high" });
    expect(usage.find((item) => item.name === "jev")?.reasoning).toBe("high");
    expect(usage.filter((item) => item.name === "opus").map((item) => item.reasoning)).toEqual([
      "high",
      "low",
    ]);
  });

  it("a call with no usage or cost counts as a call with zeros", () => {
    const cutOff = event("promptCompletion", { model: JSON.stringify("opus") });
    expect(modelUsageOf({ events: [cutOff], fallbackReasoning: null })).toEqual([
      entry({ name: "opus", calls: 1 }),
    ]);
  });

  it("an empty model name is counted as unknown", () => {
    const noModel = event("promptCompletion", { usage: { inputTokens: 7 } });
    expect(modelUsageOf({ events: [noModel], fallbackReasoning: null })).toEqual([
      entry({ name: "unknown", calls: 1, inputTokens: 7 }),
    ]);
  });

  it("only promptCompletion events count", () => {
    const others = [
      event("promptStart", { model: JSON.stringify("opus") }),
      event("toolCall", { model: JSON.stringify("opus"), toolName: "read" }),
    ];
    expect(modelUsageOf({ events: others, fallbackReasoning: null })).toEqual([]);
  });
});

describe("sumModelUsage", () => {
  it("sums entries with the same model and level, and keeps the rest in order", () => {
    const first = [
      entry({ name: "opus", reasoning: "high", calls: 2, inputTokens: 10, costUsd: 0.5 }),
      entry({ name: "zeta", calls: 1 }),
    ];
    const second = [
      entry({ name: "jev", calls: 4 }),
      entry({ name: "opus", reasoning: "high", calls: 1, inputTokens: 5, costUsd: 0.25 }),
    ];
    expect(sumModelUsage([first, second])).toEqual([
      entry({ name: "jev", calls: 4 }),
      entry({ name: "opus", reasoning: "high", calls: 3, inputTokens: 15, costUsd: 0.75 }),
      entry({ name: "zeta", calls: 1 }),
    ]);
  });
});
