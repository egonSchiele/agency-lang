import {
  main,
  hasInterrupts,
  approve,
  respondToInterrupts,
  __setLLMClient,
} from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { ToolCall } from "smoltalk";

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

let callIndex = 0;
const client = {
  async text() {
    const idx = callIndex++;
    if (idx === 0) {
      return {
        success: true,
        value: {
          output: null,
          toolCalls: [new ToolCall("c1", "interruptTool", {})],
          model: "test",
          usage: USAGE,
          cost: COST,
        },
      };
    }
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
    return { success: false, error: "embed not implemented" };
  },
};

__setLLMClient(client);

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

const initial = await main();
if (!hasInterrupts(initial.data)) {
  throw new Error(`Expected interrupts, got: ${JSON.stringify(initial.data)}`);
}
const final = await respondToInterrupts(initial.data, [approve()]);

const events = readFileSync("statelog.log", "utf-8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));

const startCount = events.filter((e) => e.data?.type === "promptStart").length;
const completionCount = events.filter(
  (e) => e.data?.type === "promptCompletion",
).length;

writeFileSync(
  "__result.json",
  JSON.stringify(
    { finalData: final.data, llmCalls: callIndex, startCount, completionCount },
    null,
    2,
  ),
);
