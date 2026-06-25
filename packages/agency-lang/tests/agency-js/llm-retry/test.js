import { main, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

// Count the transient failures the client injects. The runtime retries past
// them, so `failures` is also the number of retries that fired.
let failures = 0;
const client = {
  async text() {
    if (failures < 2) {
      failures += 1;
      throw new Error("ECONNRESET");
    }
    return {
      success: true,
      value: { output: "pong", toolCalls: [], model: "test", usage: USAGE, cost: COST },
    };
  },
  async *textStream(config) {
    const r = await this.text(config);
    yield { type: "done", result: r.value };
  },
  async embed() {
    return { success: false, error: "embed not implemented" };
  },
};

__setLLMClient(client);

const result = await main();

writeFileSync(
  "__result.json",
  JSON.stringify({ data: result.data, retryCount: failures }, null, 2),
);
