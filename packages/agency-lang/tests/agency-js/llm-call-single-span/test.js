import { main, __setLLMClient } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { ToolCall } from "smoltalk";

// Two-round tool loop driven by a deterministic client: round 1 returns
// a getArea tool call, round 2 returns the final answer. Both rounds are
// one logical llm() call and must share ONE llmCall span.
//
// Spans aren't labeled in the wire format; the viewer infers an
// `llmCall` span from a promptCompletion event's span_id. So the number
// of distinct span_ids carrying a promptCompletion event == the number
// of llmCall spans. getArea is a leaf tool (no nested llm()), so the
// only promptCompletions come from main()'s two rounds: pre-fix that's
// two distinct span_ids, post-fix one.

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
          toolCalls: [new ToolCall("call-1", "getArea", { country: "France" })],
          model: "test",
          usage: USAGE,
          cost: COST,
        },
      };
    }
    return {
      success: true,
      value: { output: "ok", toolCalls: [], model: "test", usage: USAGE, cost: COST },
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

const result = await main();

const events = readFileSync("statelog.log", "utf-8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l));

const llmSpanIds = new Set(
  events
    .filter((e) => e.data?.type === "promptCompletion")
    .map((e) => e.span_id),
);

writeFileSync(
  "__result.json",
  JSON.stringify(
    { finalData: result.data, llmCallSpanCount: llmSpanIds.size },
    null,
    2,
  ),
);
