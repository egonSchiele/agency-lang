// Runs `agency agent` as a person at a terminal would, with a scripted
// model. test.js types into its stdin. stdin and stdout are pipes, so they
// are made to look like a terminal: the agent runs its REPL only at one.
import { ToolCall } from "smoltalk";
import { __setLLMClient, main } from "../../../dist/lib/agents/agency-agent/agent.js";

process.stdin.isTTY = true;
process.stdin.setRawMode = function setRawMode() {
  return this;
};
process.stdout.isTTY = true;
process.stdout.columns = 100;
process.stdout.rows = 40;
// STAGE_FLAGS adds flags, such as `--policy minimal`.
const extraFlags = (process.env.STAGE_FLAGS ?? "").split(" ").filter((flag) => flag !== "");
process.argv = [process.argv[0], "agent", "--brain", "minimal", ...extraFlags];

const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, totalTokens: 15 };
const cost = { inputCost: 0.001, outputCost: 0, totalCost: 0.001, currency: "USD" };

function lastUserText(config) {
  const users = config.messages.filter((message) => message.role === "user");
  const content = users.at(-1)?.content ?? "";
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

const reply = (output, toolCalls = []) => ({
  success: true,
  value: { output, toolCalls, model: "test", usage, cost },
});

/** Waits, and stops with the signal's reason when the call is cancelled,
 *  as a real model call does. */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

__setLLMClient({
  // "take your time" is slow enough for the test to press Esc. "write the
  // note" asks to write a file no rule covers, and then says whether it
  // was written or refused. Every other call, the title's included, gets
  // the same reply.
  async text(config) {
    const said = lastUserText(config);
    if (said.includes("take your time")) {
      await wait(4000, config.abortSignal);
    }
    if (said.includes("write the note")) {
      const last = config.messages.at(-1);
      if (last?.role === "tool") {
        // What the write tool told the model: done, or refused.
        const told = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
        return reply(/reject/i.test(told) ? "the write was refused" : "wrote the note");
      }
      const write = new ToolCall("call-write", "write", {
        filename: "note.txt",
        content: said,
        dir: process.env.NOTE_DIR,
      });
      return reply(null, [write]);
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
