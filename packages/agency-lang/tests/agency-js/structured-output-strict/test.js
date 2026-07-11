import { plainInvalid, bangInvalid, bangValid, primitiveStillWorks, __setLLMClient } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

// The mock answers by prompt content: prose for the invalid cases, valid
// JSON for the others. The "response" wrapper on the primitive matches
// what providers return for wrapped primitive schemas.
const client = {
  async text(config) {
    const lastUser = [...(config.messages ?? [])].reverse().find((m) => m.role === "user");
    const prompt = String(lastUser?.content ?? "");
    let output = "I am sorry, I cannot produce structured data.";
    if (prompt.includes("give me json")) {
      output = JSON.stringify({ name: "Ada", age: 36 });
    }
    if (prompt.includes("give me a number")) {
      output = JSON.stringify({ response: 42 });
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

const plain = await plainInvalid();
const bangBad = await bangInvalid();
const bangGood = await bangValid();
const primitive = await primitiveStillWorks();

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
      plainInvalid: plain.data,
      bangInvalid: bangBad.data,
      bangValid: bangGood.data,
      primitive: primitive.data,
      validationErrorEvents: validationErrors,
    },
    null,
    2,
  ),
);
