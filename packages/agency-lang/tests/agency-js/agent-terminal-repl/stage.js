// Runs `agency agent` as a person at a terminal would, with a scripted
// model. test.js types into its stdin. stdin and stdout are pipes, so they
// are made to look like a terminal: the agent runs its REPL only at one.
import { main } from "../../../dist/lib/agents/agency-agent/agent.js";
import { __setLLMClient } from "../../../dist/lib/agents/agency-agent/program.js";

process.stdin.isTTY = true;
process.stdin.setRawMode = function setRawMode() {
  return this;
};
process.stdout.isTTY = true;
process.stdout.columns = 100;
process.stdout.rows = 40;
process.argv = [process.argv[0], "agent", "--brain", "simple"];

const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, totalTokens: 15 };
const cost = { inputCost: 0.001, outputCost: 0, totalCost: 0.001, currency: "USD" };

__setLLMClient({
  // Every call gets the same reply, the title's included.
  async text() {
    return {
      success: true,
      value: { output: "stub reply", toolCalls: [], model: "test", usage, cost },
    };
  },
  async *textStream(config) {
    const response = await this.text(config);
    yield { type: "done", result: response.value };
  },
  async embed() {
    throw new Error("Unexpected embedding request");
  },
});

await main();
process.exit(0);
