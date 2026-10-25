import { main, freshConversation, failedBatches, failedLearningTurn, __setLLMClient } from "./agent.js";
import { writeFileSync } from "node:fs";
import { ToolCall } from "smoltalk";

const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const cost = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
const source = {
  kind: "source",
  source: 'export def seriesInfo(seriesId | id: string): string { return "series:${seriesId}" }',
};
const script = [
  { name: "learnTools", args: { source, names: ["seriesInfo"] } },
  { name: "session_seriesInfo", args: { id: "UNRATE" } },
  "same-turn answer",
  { name: "session_seriesInfo", args: { seriesId: "GDP" } },
  "next-turn answer",
  { name: "learnTools", args: { source, names: ["missing"] } },
  "learning failed; conversation continues",
];
const requests = [];
const client = {
  async text(config) {
    requests.push({
      tools: config.tools.map((tool) => ({ name: tool.name, schema: tool.schema.toJSONSchema() })),
      messages: config.messages.map((message) => message.toJSON()),
    });
    const step = script[requests.length - 1];
    if (step === undefined) {
      throw new Error("Coordinator made an unexpected model request.");
    }
    return {
      success: true,
      value: {
        output: typeof step === "string" ? step : null,
        toolCalls: typeof step === "string" ? [] : [new ToolCall(`call-${requests.length}`, step.name, step.args)],
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
const result = await main();
const fresh = await freshConversation();
const failed = await failedBatches();
const failedTurn = await failedLearningTurn();
const toolIn = (index) => requests[index]?.tools.find((tool) => tool.name === "session_seriesInfo");
const contains = (index, text) => JSON.stringify(requests[index]?.messages).includes(text);
writeFileSync("__result.json", JSON.stringify({
  data: result.data,
  requestCount: requests.length,
  absentBeforeLearning: toolIn(0) === undefined,
  internalClockIsBound: requests[0].tools.find((tool) => tool.name === "learnTools").schema.properties.turnStart === undefined,
  sameTurnOffered: toolIn(1)?.schema.properties.seriesId.type === "string",
  handoffKeepsRequest: contains(1, "ORIGINAL-REQUEST-MARKER"),
  handoffKeepsGrounding: contains(1, "SESSION-TOOLS-GROUNDING"),
  aliasCallRan: contains(2, "series:UNRATE"),
  nextTurnOffered: toolIn(3) !== undefined,
  nextTurnCallRan: contains(4, "series:GDP"),
  freshCount: fresh.data,
  failedBatches: failed.data,
  failedLearningReply: failedTurn.data,
  failedLearningStayedInCaller: contains(6, "learnTools stopped before finishing") && contains(6, "missing"),
}, null, 2));
