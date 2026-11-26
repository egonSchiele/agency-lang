import {
  main,
  stdlibPath,
  failedLearns,
  pausesInsideTheHandoff,
  approve,
  hasInterrupts,
  respondToInterrupts,
  __setLLMClient,
} from "./agent.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ToolCall } from "smoltalk";

const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const cost = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
const series = resolve("tools/series.agency");
const collide = resolve("tools/collide.agency");

// One entry per model request, in order: a tool call, or the text of a reply.
const script = [
  // main
  { name: "learn", args: { file: series, names: ["seriesInfo"] } },
  { name: "seriesInfo", args: { seriesId: "UNRATE" } },
  "same-turn answer",
  { name: "seriesInfo", args: { seriesId: "GDP" } },
  "next-turn answer",
  // stdlibPath
  { name: "learn", args: { file: "math.agency", names: ["add"] } },
  { name: "add", args: { a: 1, b: 2 } },
  "three",
  { name: "learn", args: { file: "math.agency", names: ["add"] } },
  "already learned; conversation continues",
  // failedLearns
  { name: "learn", args: { file: series, names: [] } },
  "no names; conversation continues",
  { name: "learn", args: { file: "nowhere/missing.agency", names: ["anything"] } },
  "missing file; conversation continues",
  { name: "learn", args: { file: collide, names: ["read"] } },
  "name taken; conversation continues",
  // pausesInsideTheHandoff
  { name: "learn", args: { file: series, names: ["seriesInfo"] } },
  { name: "seriesInfo", args: { seriesId: "UNRATE" } },
  "answer after resume",
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
      throw new Error("The brain made an unexpected model request.");
    }
    return {
      success: true,
      value: {
        output: typeof step === "string" ? step : null,
        toolCalls:
          typeof step === "string"
            ? []
            : [new ToolCall(`call-${requests.length}`, step.name, step.args)],
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
const toolIn = (index, name) => requests[index]?.tools.find((tool) => tool.name === name);
const contains = (index, text) => JSON.stringify(requests[index]?.messages).includes(text);

const learned = await main();
const fromStdlib = await stdlibPath();
const failed = await failedLearns();
const paused = await pausesInsideTheHandoff();
const pausedOnce = hasInterrupts(paused.data) && paused.data.length === 1;
const requestsBeforeResume = requests.length;
const resumed = pausedOnce
  ? await respondToInterrupts(paused.data, [approve()])
  : { data: "the run did not pause on one interrupt" };

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      learned: learned.data,
      firstTools: requests[0].tools.map((tool) => tool.name),
      learnParameters: Object.keys(toolIn(0, "learn").schema.properties),
      sameTurnOffered: toolIn(1, "seriesInfo")?.schema.properties.seriesId.type === "string",
      handoffKeepsRequest: contains(1, "ORIGINAL-REQUEST-MARKER"),
      handoffKeepsPrimer: contains(1, "You can gain tools"),
      handoffKeepsContext: contains(1, "CALLER-CONTEXT-MARKER"),
      handoffKeepsLearn: toolIn(1, "learn") !== undefined,
      learnedCallRan: contains(2, "series:UNRATE"),
      nextTurnOffered: toolIn(3, "seriesInfo") !== undefined,
      nextTurnCallRan: contains(4, "series:GDP"),
      fromStdlib: fromStdlib.data,
      failed: failed.data,
      alreadyLearnedMessage: contains(9, "You already learned 'add'. Call it directly."),
      emptyNamesMessage: contains(11, "Name the functions to learn"),
      missingFileMessage: contains(13, "There is no Agency file at"),
      takenNameMessage: contains(
        15,
        "A tool named 'read' is already in your tools, so this function cannot be learned in this conversation.",
      ),
      pausedOnce,
      pausedOn: pausedOnce ? paused.data[0].effect : null,
      requestsBeforeResume,
      resumed: resumed.data,
      resumedCallRan: contains(18, "series:UNRATE"),
      callerToolAfterResume: toolIn(18, "learnedNames") !== undefined,
      requestCount: requests.length,
    },
    null,
    2,
  ),
);
