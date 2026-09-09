import { main, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
const calls = [];

const client = {
  async text(config) {
    calls.push(config);
    return {
      success: true,
      value: {
        output: "HELLO AGENCY\nOCR TEST",
        toolCalls: [],
        model: "test",
        usage: USAGE,
        cost: COST,
      },
    };
  },
  async *textStream(config) {
    const r = await this.text(config);
    if (r.success) yield { type: "done", result: r.value };
    else yield { type: "error", error: r.error };
  },
  async embed() {
    return { success: false, error: "stub does not implement embed" };
  },
};

__setLLMClient(client);
const result = await main();

// The one call must carry an image part; the model must be the one asked for.
const serialized = JSON.stringify(calls[0] ?? {});
const hasImagePart = serialized.includes('"image"');
writeFileSync(
  "__result.json",
  JSON.stringify(
    { result: result.data, callCount: calls.length, model: calls[0]?.model ?? null, hasImagePart },
    null,
    2,
  ),
);
