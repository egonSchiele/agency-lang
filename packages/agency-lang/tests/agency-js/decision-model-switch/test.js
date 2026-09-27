import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { main, __setLLMClient } from "./agent.js";

const routes = [];
__setLLMClient({
  async text(config) {
    routes.push(["text", config.model, config.provider]);
    return {
      success: true,
      value: {
        output: "reply",
        toolCalls: [],
        model: config.model,
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    };
  },
  async decide(state, questions, config) {
    routes.push(["decision", config.model, config.provider]);
    return {
      success: true,
      value: {
        answers: { answer: { type: "noul", noul: 0.9 } },
        model: config.model,
        usage: { inputTokens: 1, outputTokens: 0 },
      },
    };
  },
});
const result = await main();
assert.deepEqual(routes, [
  ["decision", "jev-1.13", "typesafe"],
  ["text", "gpt-5-mini", "openai"],
  ["decision", "jev-1.13", "typesafe"],
  ["text", "gpt-5-mini", "openai"],
]);
writeFileSync("__result.json", JSON.stringify(result.data, null, 2));
