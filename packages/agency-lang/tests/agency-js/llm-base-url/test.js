import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { main, __setLLMClient } from "./agent.js";

const urls = [];
const client = {
  async text(config) {
    urls.push(config.metadata.baseUrl.openAiCompat);
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
    assert.equal(config.baseUrl.typesafe, "https://decision.example");
    assert.equal(config.apiKey.typesafe, "unused");
    assert.equal(questions.answer.type, "noul");
    return {
      success: true,
      value: {
        answers: { answer: { type: "noul", noul: 0.9 } },
        model: config.model,
        usage: { inputTokens: 1, outputTokens: 0 },
      },
    };
  },
};

__setLLMClient(client);
const result = await main();
assert.equal(urls.length, 3);
assert.deepEqual(urls.slice(0, 2), ["https://first.example/v1", "https://second.example/v1"]);
assert.notEqual(urls[2], urls[0]);
assert.notEqual(urls[2], urls[1]);
writeFileSync("__result.json", JSON.stringify(result.data, null, 2));
