import {
  retrySucceeds,
  retriesExhausted,
  retryDisabled,
  branchDefault,
  hookReasons,
  __setLLMClient,
} from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

let callCount = 0;
const client = {
  async text(config) {
    callCount += 1;
    const msgs = config.messages ?? [];
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const firstUser = msgs.find((m) => m.role === "user");
    const prompt = String(lastUser?.content ?? "");
    const original = String(firstUser?.content ?? "");
    // Default: prose that fails validation. Valid JSON only when
    // answering the feedback message in the "give me a person" flow —
    // the "always prose" flows must keep failing through their retries.
    // COUPLING: the trigger literal must match buildValidationRetryMessage
    // (lib/runtime/llmRetry.ts).
    let output = "I am sorry, I cannot produce structured data.";
    if (
      prompt.includes("did not match the required output format") &&
      original.includes("give me a person")
    ) {
      output = JSON.stringify({ name: "Ada", age: 36 });
    }
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

callCount = 0;
const succeeded = await retrySucceeds();
const succeededCalls = callCount;

callCount = 0;
const exhausted = await retriesExhausted();
const exhaustedCalls = callCount;

callCount = 0;
const disabled = await retryDisabled();
const disabledCalls = callCount;

callCount = 0;
const branch = await branchDefault();
const branchCalls = callCount;

const hook = await hookReasons();

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
      retrySucceeds: succeeded.data,
      retrySucceedsCalls: succeededCalls,
      retriesExhausted: exhausted.data,
      retriesExhaustedCalls: exhaustedCalls,
      retryDisabled: disabled.data,
      retryDisabledCalls: disabledCalls,
      branchDefault: branch.data,
      branchDefaultCalls: branchCalls,
      hookReasons: hook.data,
      validationErrorEvents: validationErrors,
    },
    null,
    2,
  ),
);
