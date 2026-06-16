import { main, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";
import { ToolCall } from "smoltalk";

// Inject a client that records the messages array of every text() call,
// so we can inspect the tool message that runPrompt fed back to the LLM
// after bigTool ran — and assert it was truncated to the cap.

const captured = [];
let callIndex = 0;
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

const client = {
  async text(config) {
    captured.push(
      config.messages.map((m) => {
        const j = typeof m.toJSON === "function" ? m.toJSON() : m;
        return { role: j.role, content: j.content ?? null };
      }),
    );
    const idx = callIndex++;
    if (idx === 0) {
      // Round 1: tell the runtime to call bigTool.
      return {
        success: true,
        value: {
          output: null,
          toolCalls: [new ToolCall("call-1", "bigTool", {})],
          model: "test",
          usage: USAGE,
          cost: COST,
        },
      };
    }
    // Round 2 (after the tool ran): finish.
    return {
      success: true,
      value: { output: "done", toolCalls: [], model: "test", usage: USAGE, cost: COST },
    };
  },
  async *textStream(config) {
    const r = await this.text(config);
    if (r.success) yield { type: "done", result: r.value };
    else yield { type: "error", error: r.error };
  },
  async embed() {
    return { success: false, error: "captureClient does not implement embed" };
  },
};

__setLLMClient(client);

const result = await main();

// The last LLM call carries the tool response. Find the tool message.
const lastCall = captured[captured.length - 1];
const toolMsg = lastCall.find((m) => m.role === "tool");
if (!toolMsg) {
  throw new Error("no tool message in final call: " + JSON.stringify(lastCall));
}
const content =
  typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content);

const PREFIX = "01234567890123456789012345678901234567890123456789"; // first 50 chars
const out = {
  finalData: result.data,
  truncated: content.includes("truncated"),
  reportsOriginalLength: content.includes("of 500"),
  preservesPrefix: content.startsWith(PREFIX),
  shorterThanFull: content.length < 500,
};

if (!out.truncated) throw new Error("tool message not truncated: " + content.slice(0, 80));
if (!out.shorterThanFull) throw new Error("tool message not capped, len=" + content.length);

writeFileSync("__result.json", JSON.stringify(out, null, 2));
