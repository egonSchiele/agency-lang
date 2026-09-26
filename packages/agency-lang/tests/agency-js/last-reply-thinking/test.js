import { main, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";

// A client whose text() answers by prompt and attaches thinking and usage,
// so lastReply() has real extras to read back.
const byPrompt = {
  "Say A": { output: "A", thinking: "thinking about A", inputTokens: 11 },
  "Say B": { output: "B", thinking: "thinking about B", inputTokens: 22 },
};

const client = {
  async text(config) {
    const prompt = config.messages[config.messages.length - 1].content;
    const canned = byPrompt[prompt];
    if (canned === undefined) {
      throw new Error(`no answer for prompt: ${prompt}`);
    }
    return {
      success: true,
      value: {
        output: canned.output,
        toolCalls: [],
        thinkingBlocks: [{ text: canned.thinking, signature: "sig" }],
        usage: { inputTokens: canned.inputTokens, outputTokens: 1 },
        cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
        model: "test",
      },
    };
  },
  async *textStream() {
    throw new Error("textStream() must not be called");
  },
  async embed() {
    return { success: false, error: "not implemented" };
  },
};

__setLLMClient(client);
const result = await main();
writeFileSync("__result.json", JSON.stringify(result.data, null, 2));
