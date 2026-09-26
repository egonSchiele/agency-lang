import { main, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";

// A client whose text() answers by prompt and attaches thinking, usage, and
// per-token logprobs, so lastReply() has real extras to read back. It also
// records the logprobs option it received, so the test can pin that the
// option reached the client.
const byPrompt = {
  "Say A": {
    output: "A",
    thinking: "thinking about A",
    inputTokens: 11,
    logprobs: [
      {
        token: "A",
        logprob: -0.05,
        top: [
          { token: "A", logprob: -0.05 },
          { token: "B", logprob: -3.0 },
        ],
      },
    ],
  },
  "Say B": { output: "B", thinking: "thinking about B", inputTokens: 22, logprobs: [{ token: "B", logprob: -0.1 }] },
  "Say C": { output: "C", thinking: "thinking about C", inputTokens: 33, logprobs: [{ token: "C", logprob: -0.2 }] },
};

const received = {};

const client = {
  async text(config) {
    const prompt = config.messages[config.messages.length - 1].content;
    const canned = byPrompt[prompt];
    if (canned === undefined) {
      throw new Error(`no answer for prompt: ${prompt}`);
    }
    received[prompt] = config.logprobs;
    return {
      success: true,
      value: {
        output: canned.output,
        toolCalls: [],
        thinkingBlocks: [{ text: canned.thinking, signature: "sig" }],
        logprobs: canned.logprobs,
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

// The one call that passed an option must have reached the client as { top: 2 }.
const sayCOption = JSON.stringify(received["Say C"]);
if (sayCOption !== JSON.stringify({ top: 2 })) {
  throw new Error(`Say C received logprobs option ${sayCOption}, expected {"top":2}`);
}

writeFileSync("__result.json", JSON.stringify(result.data, null, 2));
