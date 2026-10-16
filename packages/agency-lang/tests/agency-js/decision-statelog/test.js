import { main, __setLLMClient } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

const answer = {
  type: "choice",
  choice: "billing",
  confidence: 0.9,
  probabilities: { billing: 0.9, support: 0.1 },
};

const client = {
  async text() {
    return {
      success: true,
      value: { output: "hello", toolCalls: [], model: "test", usage: USAGE, cost: COST },
    };
  },
  async *textStream(config) {
    const r = await this.text(config);
    yield { type: "done", result: r.value };
  },
  async embed() {
    return { success: false, error: "not implemented" };
  },
  async decide(state, questions, config) {
    return {
      success: true,
      value: {
        answers: { answer },
        usage: { inputTokens: 10, outputTokens: 0 },
        cost: COST,
        model: config.model,
      },
    };
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
const ofType = (t) => events.filter((e) => e.data?.type === t);
const [decisionStart, textStart] = ofType("promptStart");
const [decisionDone, textDone] = ofType("promptCompletion");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      data: result.data,
      startKinds: [decisionStart.data.usageKind, textStart.data.usageKind],
      completionKinds: [decisionDone.data.usageKind, textDone.data.usageKind],
      decision: decisionDone.data.decision,
      textHasDecision: "decision" in textDone.data,
    },
    null,
    2,
  ),
);
