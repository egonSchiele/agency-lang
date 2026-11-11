import { main, hasInterrupts, approve, respondToInterrupts, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";
import { ToolCall } from "smoltalk";

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
const RECORD = { provider: "openrouter", model: "test-model", text: "plan", format: "reasoning" };

const requests = [];
let callIndex = 0;
const client = {
  async text(config) {
    requests.push(config.messages.map((m) => (typeof m.toJSON === "function" ? m.toJSON() : m)));
    const idx = callIndex++;
    const value =
      idx === 0
        ? {
            output: null,
            toolCalls: [new ToolCall("c1", "interruptTool", {})],
            reasoning: "plan",
            reasoningRecord: RECORD,
          }
        : { output: "done", toolCalls: [] };
    return { success: true, value: { ...value, model: "test-model", usage: USAGE, cost: COST } };
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

const paused = await main();
const final = hasInterrupts(paused.data)
  ? await respondToInterrupts(paused.data, [approve()])
  : paused;
const resumedRequest = requests[1] ?? [];
const toolReply = resumedRequest.find((m) => m.role === "assistant");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      paused: hasInterrupts(paused.data),
      result: final.data,
      requests: requests.length,
      recordAfterResume: toolReply?.reasoning ?? null,
    },
    null,
    2,
  ),
);
