import { failing, retried, __setLLMClient } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

// Phase 1 (failing): every call throws. Phase 2 (retried): first call
// throws, second succeeds. test.js flips the phase between nodes.
let phase = "always-fail";
let phaseCallIndex = 0;
const client = {
  async text() {
    const idx = phaseCallIndex++;
    if (phase === "always-fail") {
      return { success: false, error: "synthetic provider failure" };
    }
    if (idx === 0) {
      // "fetch failed" message-matches the retry classifier's transport-
      // drop list (connectionLost, retryable); an arbitrary message would
      // classify terminal and never retry.
      return { success: false, error: "fetch failed" };
    }
    return {
      success: true,
      value: { output: "recovered", toolCalls: [], model: "test", usage: USAGE, cost: COST },
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

const failResult = await failing();

const midEvents = readFileSync("statelog.log", "utf-8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));
const failStarts = midEvents.filter((e) => e.data?.type === "promptStart");
const failCompletions = midEvents.filter((e) => e.data?.type === "promptCompletion");
// The REAL llmError shape the viewer pairs on: data.type === "error"
// with data.errorType === "llmError", sharing the start's span.
const failErrors = midEvents.filter(
  (e) => e.data?.type === "error" && e.data?.errorType === "llmError",
);

phase = "fail-once";
phaseCallIndex = 0;
const retryResult = await retried();

const allEvents = readFileSync("statelog.log", "utf-8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));
const totalStarts = allEvents.filter((e) => e.data?.type === "promptStart").length;
const totalErrors = allEvents.filter(
  (e) => e.data?.type === "error" && e.data?.errorType === "llmError",
).length;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      failData: failResult.data,
      retryData: retryResult.data,
      failPhase: {
        startCount: failStarts.length,
        completionCount: failCompletions.length,
        llmErrorCount: failErrors.length,
        errorSharesStartSpan:
          failStarts[0]?.span_id != null &&
          failStarts[0]?.span_id === failErrors[0]?.span_id,
      },
      retryPhase: {
        startsAdded: totalStarts - failStarts.length,
        llmErrorsAdded: totalErrors - failErrors.length,
      },
    },
    null,
    2,
  ),
);
