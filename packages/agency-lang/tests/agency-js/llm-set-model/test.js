import { main, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";

// Capture the model each LLM call dispatches with, to assert setModel
// flowed through (stack.other.llmDefaults -> runPrompt merge -> client).
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
const models = [];

const client = {
  async text(config) {
    models.push(config.model ?? null);
    return {
      success: true,
      value: { output: "ok", toolCalls: [], model: "test", usage: USAGE, cost: COST },
    };
  },
  async *textStream(config) {
    const r = await this.text(config);
    if (r.success) yield { type: "done", result: r.value };
    else yield { type: "error", error: r.error };
  },
  async embed() {
    return { success: false, error: "captureClient does not implement embed" };
  },
};

__setLLMClient(client);

const result = await main();
writeFileSync(
  "__result.json",
  JSON.stringify({ reply: result.data, modelUsed: models[0] }, null, 2),
);
