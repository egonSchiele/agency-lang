// Runs `agency agent -p` with a scripted model. The model asks to write a
// file, which no rule covers, and then replies with what the write tool
// told it, so the test can read the reason the model was sent.
import { ToolCall } from "smoltalk";
import { main } from "../../../dist/lib/agents/agency-agent/agent.js";
import { __setLLMClient } from "../../../dist/lib/agents/agency-agent/program.js";

const project = process.env.ONE_SHOT_PROJECT;
process.argv = [process.argv[0], "agent", "-p", "--brain", "minimal", "write the note"];

const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const cost = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
const reply = (output, toolCalls = []) => ({
  success: true,
  value: { output, toolCalls, model: "test", usage, cost },
});

__setLLMClient({
  async text(config) {
    const tools = (config.tools ?? []).map((tool) => tool.name);
    process.env.TOOLS_OFFERED = JSON.stringify(tools);
    const toolResult = config.messages.find((message) => message.role === "tool");
    if (toolResult === undefined) {
      const write = new ToolCall("call-write", "write", {
        filename: "note.txt",
        content: "hello",
        dir: project,
      });
      return reply(null, [write]);
    }
    const text =
      typeof toolResult.content === "string"
        ? toolResult.content
        : JSON.stringify(toolResult.content);
    return reply(`REPLY: ${text.split("\n")[0]}`);
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
process.stderr.write(`TOOLS_OFFERED=${process.env.TOOLS_OFFERED}\n`);
process.exit(0);
