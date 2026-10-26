import { main, __setLLMClient, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "node:fs";
import { ToolCall } from "smoltalk";

// One tool call per round, so the records arrive in a fixed order.
const script = [
  { name: "add", args: { a: 2, b: 3 } },
  { name: "outer", args: { text: "hi" } },
  { name: "addTen", args: { b: 5 } },
  { name: "addApproved", args: { a: 1, b: 1 } },
  { name: "stacked", args: { x: 7 } },
  { name: "reexported", args: { text: "exported" } },
  { name: "branched", args: { text: "forked" } },
  { name: "paused", args: { x: 8 } },
  "done",
];
let requests = 0;
const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const cost = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
const client = {
  async text() {
    const step = script[requests++];
    if (step === undefined) {
      throw new Error("Unexpected model request.");
    }
    return {
      success: true,
      value: {
        output: typeof step === "string" ? step : null,
        toolCalls:
          typeof step === "string" ? [] : [new ToolCall(`call-${requests}`, step.name, step.args)],
        model: "test",
        usage,
        cost,
      },
    };
  },
  async *textStream(config) {
    const result = await this.text(config);
    yield { type: "done", result: result.value };
  },
  async embed() {
    return { success: false, error: "not implemented" };
  },
};

__setLLMClient(client);
const initial = await main();
if (!hasInterrupts(initial.data)) {
  throw new Error("Expected the decorated tool to pause.");
}
if (initial.data.length !== 1 || initial.data[0].message !== "Continue the tool call?") {
  throw new Error("Unexpected interrupt from the decorated tool.");
}
const saved = JSON.parse(JSON.stringify(initial.data));
const result = await respondToInterrupts(saved, [approve()]);
if (hasInterrupts(result.data)) {
  throw new Error("Expected the decorated tool to finish after approval.");
}

// Compare identity relationships without depending on the compiler's spelling.
const identities = [];
const seen = result.data.seen.map(({ id, ...entry }) => {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("A decorator received an empty or non-string ID.");
  }
  if (!identities.includes(id)) {
    identities.push(id);
  }
  return { ...entry, identity: identities.indexOf(id) };
});
writeFileSync(
  "__result.json",
  JSON.stringify({ data: { ...result.data, seen }, requests }, null, 2),
);
