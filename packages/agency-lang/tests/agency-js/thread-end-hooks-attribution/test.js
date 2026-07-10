import { main, __setLLMClient } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

// Call 1 = the user's llm(); call 2 = the summarizer's structured-output
// call (returns {summary} JSON).
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

let callIndex = 0;
const client = {
  async text() {
    const idx = callIndex++;
    const output = idx === 0 ? "hello there" : JSON.stringify({ summary: "a greeting" });
    return {
      success: true,
      value: { output, toolCalls: [], model: "test", usage: USAGE, cost: COST },
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
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));

const hookStarts = events.filter((e) => e.data?.type === "threadEndHooksStart");
const hookEnds = events.filter((e) => e.data?.type === "threadEndHooksEnd");
// The summarizer's promptStart: its own span_id is its llmCall span; its
// envelope parent_span_id is the enclosing threadEndHooks span.
const hookSpanIds = new Set(hookStarts.map((e) => e.span_id));
const attributedStarts = events.filter(
  (e) => e.data?.type === "promptStart" && hookSpanIds.has(e.parent_span_id),
);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      finalData: result.data,
      llmCalls: callIndex,
      hookStartCount: hookStarts.length,
      hookEndCount: hookEnds.length,
      eagerSummarizeFlags: hookStarts.map((e) => e.data.eagerSummarize),
      attributedSummarizerStarts: attributedStarts.length,
    },
    null,
    2,
  ),
);
