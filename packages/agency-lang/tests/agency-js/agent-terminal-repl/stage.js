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
// STAGE_FLAGS adds flags, such as `--policy minimal`.
const extraFlags = (process.env.STAGE_FLAGS ?? "").split(" ").filter((flag) => flag !== "");
process.argv = [process.argv[0], "agent", "--brain", "simple", ...extraFlags];

const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, totalTokens: 15 };
const cost = { inputCost: 0.001, outputCost: 0, totalCost: 0.001, currency: "USD" };

function lastUserText(config) {
  const users = config.messages.filter((message) => message.role === "user");
  const content = users.at(-1)?.content ?? "";
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

const reply = (output) => ({
  success: true,
  value: { output, toolCalls: [], model: "test", usage, cost },
});

__setLLMClient({
  // "take your time" is slow enough for the test to press Esc. A message
  // that carries the note about a cancelled request gets a reply that says
  // so. Every other call, the title's included, gets the same reply.
  async text(config) {
    const said = lastUserText(config);
    if (said.includes("take your time")) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
    if (said.includes("The user cancelled their previous request")) {
      return reply("noted the cancel");
    }
    return reply("stub reply");
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
