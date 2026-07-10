import { main, __setLLMClient } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

let callIndex = 0;
const client = {
  async text(config) {
    const idx = callIndex++;
    if (idx === 0) {
      return {
        success: true,
        value: { output: "fast", toolCalls: [], model: "test", usage: USAGE, cost: COST },
      };
    }
    // The loser: park until the race abort fires, then reject the way a
    // real provider SDK does when its request is aborted.
    return new Promise((resolve, reject) => {
      const signal = config?.abortSignal;
      if (!signal) {
        reject(new Error("expected an abortSignal on the loser branch"));
        return;
      }
      if (signal.aborted) {
        reject(Object.assign(new Error("Request was aborted."), { name: "AbortError" }));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("Request was aborted."), { name: "AbortError" }));
      });
    });
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

const startCount = events.filter((e) => e.data?.type === "promptStart").length;
const completionCount = events.filter((e) => e.data?.type === "promptCompletion").length;
const cancelledCount = events.filter((e) => e.data?.type === "promptCancelled").length;
const llmErrorCount = events.filter(
  (e) => e.data?.type === "error" && e.data?.errorType === "llmError",
).length;

writeFileSync(
  "__result.json",
  JSON.stringify(
    { finalData: result.data, startCount, completionCount, cancelledCount, llmErrorCount },
    null,
    2,
  ),
);
