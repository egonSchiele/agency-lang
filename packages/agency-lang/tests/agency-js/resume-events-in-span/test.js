import { main, hasInterrupts, approve, respondToInterrupts, __setLLMClient } from "./agent.js";
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

const type = (e) => e.data?.type;

// The resumed run is the second agentStart. Everything it logs at the top
// level must sit in its agentRun span, and agentStart must come first.
const starts = events.filter((e) => type(e) === "agentStart");
const resumedStart = starts[1];
const resumedSpan = resumedStart?.span_id ?? null;
const inResumedSpan = events.filter((e) => e.span_id === resumedSpan);
const firstInResumedSpan = type(inResumedSpan[0]);

const restored = events.filter((e) => type(e) === "checkpointRestored");
const userApprovals = events.filter(
  (e) => type(e) === "interruptResolved" && e.data.resolvedBy === "user",
);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      finalData: final.data,
      agentStarts: starts.length,
      firstInResumedSpan,
      restoredInResumedSpan:
        restored.length > 0 && restored.every((e) => e.span_id === resumedSpan),
      approvalInResumedSpan:
        userApprovals.length > 0 && userApprovals.every((e) => e.span_id === resumedSpan),
      spanlessEvents: events.filter((e) => !e.span_id).map(type),
    },
    null,
    2,
  ),
);
