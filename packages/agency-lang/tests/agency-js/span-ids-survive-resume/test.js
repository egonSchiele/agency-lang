import {
  toolInterrupt,
  handoffInterrupt,
  twoInterrupts,
  loopInterrupt,
  retry,
  forRewind,
  hasInterrupts,
  approve,
  respondToInterrupts,
  rewindFrom,
  __setLLMClient,
} from "./agent.js";
import { reset } from "./counter.js";
import { spanProblems } from "../../helpers/spanInvariants.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { ToolCall } from "smoltalk";

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

// What the model calls, by the last user message it sees and how many
// tool results have come back since. Anything not listed gets "done".
const SCRIPT = {
  pause: [["pauseMe", "a"]],
  "pause twice": [
    ["pauseMe", "a"],
    ["pauseMe", "b"],
  ],
  ask: [["subagent", "q"]],
  "brief: q": [["pauseMe", "h"]],
  "step 1": [["quick", "1"]],
  "step 2": [["pauseMe", "2"]],
  "step 3": [["quick", "3"]],
  checkpoint: [["takeCheckpoint", "t"]],
  grab: [["grabCheckpoint", "g"]],
};

const text = (message) =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

let callCount = 0;
let lastRequest = [];
const client = {
  async text(config) {
    lastRequest = config.messages;
    const lastUser = config.messages
      .map((m) => m)
      .reverse()
      .findIndex((m) => m.role === "user");
    const sinceUser =
      lastUser === -1 ? [] : config.messages.slice(config.messages.length - lastUser);
    const userText =
      lastUser === -1 ? "" : text(config.messages[config.messages.length - 1 - lastUser]);
    const round = sinceUser.filter((m) => m.role === "tool").length;
    const step = SCRIPT[userText]?.[round];
    callCount += 1;
    if (step === undefined) {
      return {
        success: true,
        value: { output: "done", toolCalls: [], model: "test", usage: USAGE, cost: COST },
      };
    }
    const [name, id] = step;
    return {
      success: true,
      value: {
        output: null,
        toolCalls: [
          new ToolCall(`c${callCount}`, name, name === "subagent" ? { question: id } : { id }),
        ],
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

const readEvents = () =>
  readFileSync("statelog.log", "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

// The events one scenario wrote: the file holds every scenario's log.
let seen = 0;
const newEvents = () => {
  const all = readEvents();
  const fresh = all.slice(seen);
  seen = all.length;
  return fresh;
};

const type = (e) => e.data?.type;
const count = (events, t) => events.filter((e) => type(e) === t).length;
const distinct = (values) => Object.keys(Object.fromEntries(values.map((v) => [v, true])));
const llmSpans = (events) =>
  distinct(events.filter((e) => type(e) === "promptCompletion").map((e) => e.span_id));

// Run a node, approving every interrupt until it returns a value.
async function runApproving(node) {
  let result = await node();
  let resumes = 0;
  while (hasInterrupts(result.data)) {
    resumes += 1;
    result = await respondToInterrupts(
      result.data,
      result.data.map(() => approve()),
    );
  }
  return { result, resumes };
}

const summary = (events) => ({
  problems: spanProblems(events),
  agentStarts: count(events, "agentStart"),
  toolStarts: count(events, "toolCallStart"),
  toolEnds: count(events, "toolCall"),
  llmCallSpans: llmSpans(events).length,
});

const results = {};

{
  const { result, resumes } = await runApproving(toolInterrupt);
  results.toolInterrupt = { result: result.data, resumes, ...summary(newEvents()) };
}

{
  const { result, resumes } = await runApproving(handoffInterrupt);
  const events = newEvents();
  // The pausing tool's end event sits under the handoff body's llmCall,
  // which sits under the subagent's own tool span: the resumed work nests
  // under the original call and not beside it.
  const pauseEnd = events.find((e) => type(e) === "toolCall" && e.data.toolName === "pauseMe");
  const bodyLlm = events.find((e) => e.span_id === pauseEnd?.parent_span_id);
  const subagentSpan = events.find((e) => e.span_id === bodyLlm?.parent_span_id);
  results.handoffInterrupt = {
    result: result.data,
    resumes,
    ...summary(events),
    pauseEndNestsUnderSubagent: subagentSpan?.data.toolName === "subagent",
  };
}

{
  const { result, resumes } = await runApproving(twoInterrupts);
  results.twoInterrupts = { result: result.data, resumes, ...summary(newEvents()) };
}

{
  const { result, resumes } = await runApproving(loopInterrupt);
  results.loopInterrupt = { result: result.data, resumes, ...summary(newEvents()) };
}

// A restore in the same trace continues the same spans. The completed
// steps before the checkpoint are skipped on replay, so the tool logs its
// toolCallStart once and its toolCall once per attempt, all in one span.
{
  reset();
  const { result, resumes } = await runApproving(retry);
  const events = newEvents();
  results.retry = {
    result: result.data,
    resumes,
    restores: count(events, "checkpointRestored"),
    ...summary(events),
  };
}

{
  const first = await runApproving(forRewind);
  const firstEvents = newEvents();
  const firstSpans = distinct(firstEvents.map((e) => e.span_id).filter(Boolean));
  // The tool handed its checkpoint to the model; it is the one tool
  // message of the final request.
  const toolMessage = lastRequest.find((m) => m.role === "tool");
  const checkpoint = JSON.parse(text(toolMessage));
  const rewound = await rewindFrom(checkpoint, {});
  const rewoundEvents = newEvents();
  const rewoundTraces = distinct(rewoundEvents.map((e) => e.trace_id));
  const firstTraces = distinct(firstEvents.map((e) => e.trace_id));
  results.forRewind = {
    first: first.result.data,
    rewound: rewound.data,
    newTrace: rewoundTraces.length === 1 && !firstTraces.includes(rewoundTraces[0]),
    reusedSpans: rewoundEvents.filter((e) => firstSpans.includes(e.span_id)).map(type),
    rewoundProblems: spanProblems(rewoundEvents),
  };
}

writeFileSync("__result.json", JSON.stringify(results, null, 2));
