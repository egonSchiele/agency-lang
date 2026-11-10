import { main, __setLLMClient } from "./agent.js";
import { writeFileSync } from "node:fs";

// The effort each model call was sent, keyed by the call's prompt.
const sent = {};

function lastUserText(config) {
  const users = config.messages.filter((message) => message.role === "user");
  const content = users[users.length - 1].content;
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

__setLLMClient({
  async text(config) {
    sent[lastUserText(config)] = config.reasoningEffort ?? "none";
    return {
      success: true,
      value: {
        output: "ok",
        toolCalls: [],
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 },
        cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
      },
    };
  },
  async *textStream(config) {
    const response = await this.text(config);
    yield { type: "done", result: response.value };
  },
  async embed() {
    throw new Error("Unexpected embedding request in the effort fixture");
  },
});

const realLog = console.log;
console.log = () => {};
let result;
try {
  result = await main();
} finally {
  console.log = realLog;
}

writeFileSync("__result.json", JSON.stringify({ result: result.data, sent }, null, 2));
