import { main, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";

// Record the model of every LLM call. Branch calls run concurrently
// (order nondeterministic); the parent call runs after the fork joins,
// so it is the LAST call.
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

await main();

const parentModel = models[models.length - 1]; // parent call, after join
const branchModels = models.slice(0, -1).sort(); // the two branch calls
writeFileSync(
  "__result.json",
  JSON.stringify({ parentModel, branchModels, callCount: models.length }, null, 2),
);
