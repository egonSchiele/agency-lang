import { main, hasInterrupts, approve, respondToInterrupts, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";
import { ToolCall } from "smoltalk";

// A scripted client kept in module state, so its place in the script
// survives the resume: the deterministic mocks the runner installs are
// re-read from the environment on a resume, which would replay the first
// reply. Round 0 fetches the page, round 1 asks for the same page again
// in another spelling, round 2 answers.
const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const cost = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
const rounds = [
  [new ToolCall("c1", "fetchMarkdown", { url: "https://example.com/about" })],
  [new ToolCall("c2", "fetchMarkdown", { url: "https://example.com/about/#top" })],
  [],
];
let callIndex = 0;
const client = {
  async text() {
    const toolCalls = rounds[Math.min(callIndex, rounds.length - 1)];
    callIndex += 1;
    const output = toolCalls.length === 0 ? "done" : null;
    return { success: true, value: { output, toolCalls, model: "test", usage, cost } };
  },
  async *textStream(config) {
    const result = await this.text(config);
    yield { type: "done", result: result.value };
  },
  async embed() {
    return { success: false, error: "not supported" };
  },
};
__setLLMClient(client);

const initial = await main();
if (!hasInterrupts(initial.data)) {
  throw new Error(`expected the first fetch to pause on its interrupt, got ${JSON.stringify(initial.data)}`);
}
const final = await respondToInterrupts(initial.data, [approve()]);
writeFileSync("__result.json", JSON.stringify({ kinds: final.data, llmCalls: callIndex }, null, 2));
