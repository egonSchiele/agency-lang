import { main, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";

// A streaming client that emits two text chunks then done, so the onStream
// callback should observe "text,text,done,". A custom client is used (rather
// than the deterministic mock, whose textStream only emits "done") so the test
// exercises intermediate chunk delivery, not just the terminal event.
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
const DONE = { output: "New Delhi", toolCalls: [], model: "test", usage: USAGE, cost: COST };

const client = {
  async text() {
    return { success: true, value: DONE };
  },
  async *textStream() {
    yield { type: "text", text: "New " };
    yield { type: "text", text: "Delhi" };
    yield { type: "done", result: DONE };
  },
  async embed() {
    return { success: false, error: "captureClient does not implement embed" };
  },
};

__setLLMClient(client);

const result = await main();

writeFileSync(
  "__result.json",
  JSON.stringify({ chunks: result.data }, null, 2),
);
