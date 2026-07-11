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
let feedbackCountOnFinalCall = -1;
const client = {
  async text(config) {
    const idx = callIndex++;
    if (idx === 0) {
      // Fails validation → triggers the feedback retry.
      return {
        success: true,
        value: { output: "just prose", toolCalls: [], model: "test", usage: USAGE, cost: COST },
      };
    }
    if (idx === 1) {
      // The retry round calls a tool that interrupts.
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
    // Post-resume: count feedback messages (must be exactly 1 — a resume
    // that re-ran the feedback step would have pushed a second one), then
    // answer with valid JSON.
    // COUPLING: the literal must match buildValidationRetryMessage.
    feedbackCountOnFinalCall = (config.messages ?? []).filter(
      (m) =>
        m.role === "user" &&
        String(m.content ?? "").includes("did not match the required output format"),
    ).length;
    return {
      success: true,
      value: {
        output: JSON.stringify({ name: "Ada", age: 36 }),
        toolCalls: [],
        model: "test",
        usage: USAGE,
        cost: COST,
      },
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
const validationErrors = events.filter(
  (e) => e.data?.type === "error" && e.data?.errorType === "structuredOutput",
).length;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      result: final.data,
      llmCalls: callIndex,
      feedbackMessages: feedbackCountOnFinalCall,
      validationErrorEvents: validationErrors,
    },
    null,
    2,
  ),
);
