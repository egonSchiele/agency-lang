import {
  main,
  hasInterrupts,
  approve,
  reject,
  respondToInterrupts,
  __setLLMClient,
} from "./agent.js";
import { readFileSync, writeFileSync } from "fs";
import { ToolCall } from "smoltalk";

const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const cost = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
let callIndex = 0;
const client = {
  async text() {
    const index = callIndex++;
    const names = ["worker", "askTool"];
    return {
      success: true,
      value: {
        output: index < 2 ? null : "answer",
        toolCalls: index < 2 ? [new ToolCall(`call-${index}`, names[index], {})] : [],
        model: "test",
        usage,
        cost,
      },
    };
  },
  async *textStream(config) {
    const response = await this.text(config);
    yield { type: "done", result: response.value };
  },
  async embed() {
    throw new Error("unexpected embed");
  },
};
__setLLMClient(client);

const results = [];
for (const response of [approve(), reject("declined")]) {
  callIndex = 0;
  writeFileSync("statelog.log", "");
  const initial = await main();
  if (!hasInterrupts(initial.data)) {
    throw new Error("expected interrupt inside nested tool conversation");
  }
  const interrupts = JSON.parse(JSON.stringify(initial.data));
  const final = await respondToInterrupts(interrupts, [response]);
  const completions = readFileSync("statelog.log", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).data)
    .filter((event) => event.type === "promptCompletion");
  const identities = completions.map((event) => event.threadIdentity);
  results.push({
    finalData: final.data,
    completions: completions.length,
    identitiesPresent: identities.every((id) => typeof id === "string" && id.length > 0),
    outerPreserved: identities[0] === identities[3],
    innerPreserved: identities[1] === identities[2],
    conversationsSeparate: identities[0] !== identities[1],
  });
}
writeFileSync("__result.json", JSON.stringify(results, null, 2));
