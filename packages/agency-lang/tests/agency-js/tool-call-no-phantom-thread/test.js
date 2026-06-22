import { main, __setLLMClient } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { ToolCall } from "smoltalk";

// Drive one tool round: round 1 the model calls getArea, round 2 it
// finishes. getArea is a leaf tool (no nested llm()), so the run's only
// thread is the root thread — exactly one `threadCreated` should appear
// in the statelog. A spurious per-tool-call thread (from eagerly
// seeding the fresh tool ThreadStore via `withDefaultActive`) would
// push the count to 2.

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

// statelog.log is appended to (never truncated), and the harness does
// not clear it between runs — so remove it first to count only this
// run's events.
try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

const result = await main();

const lines = readFileSync("statelog.log", "utf-8")
  .split("\n")
  .filter((l) => l.trim() !== "");
const events = lines.map((l) => JSON.parse(l));
const threadCreatedCount = events.filter(
  (e) => e.data?.type === "threadCreated",
).length;

writeFileSync(
  "__result.json",
  JSON.stringify({ finalData: result.data, threadCreatedCount }, null, 2),
);
