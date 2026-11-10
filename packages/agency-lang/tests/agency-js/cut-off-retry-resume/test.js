import {
  toolPause,
  gatePause,
  tripDuringRetry,
  hasInterrupts,
  approve,
  respondToInterrupts,
  __setLLMClient,
} from "./agent.js";
import { writeFileSync } from "fs";
import { ToolCall } from "smoltalk";

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
// Non-zero cost so guard(cost: $0.000001) trips after the first reply.
const COST = { inputCost: 0.000001, outputCost: 0.000001, totalCost: 0.000002, currency: "USD" };
// COUPLING: must match CUT_OFF_NOTE in lib/runtime/llmRetry.ts.
const NOTE = "Your last reply reached the output limit before it contained any text or tool call.";

// Each entry scripts one reply: { output, stopReason, toolCalls, delayMs }.
// A delayed reply waits on the request's abort signal like a real provider.
function makeClient(script) {
  const requests = [];
  let i = 0;
  const client = {
    async text(config) {
      requests.push(config.messages.map((m) => (typeof m.toJSON === "function" ? m.toJSON() : m)));
      const turn = script[Math.min(i, script.length - 1)];
      i++;
      if (turn.delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, turn.delayMs);
          config.abortSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(config.abortSignal.reason);
          });
        });
      }
      return {
        success: true,
        value: {
          output: turn.output ?? null,
          toolCalls: turn.toolCalls ?? [],
          model: "test",
          stopReason: turn.stopReason,
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
  return { client, requests };
}

const notesIn = (request) =>
  request.filter((m) => typeof m.content === "string" && m.content.startsWith(NOTE)).length;
const holdsEmptyReply = (request) =>
  request.some(
    (m) =>
      m.role === "assistant" &&
      String(m.content ?? "").trim() === "" &&
      (m.toolCalls ?? m.tool_calls ?? []).length === 0,
  );

const EMPTY_CUT_OFF = { output: "", stopReason: "length" };
const out = {};

// Test 9: the retried request calls a tool that interrupts.
{
  const { client, requests } = makeClient([
    EMPTY_CUT_OFF,
    { toolCalls: [new ToolCall("c1", "interruptTool", {})] },
    { output: "done" },
  ]);
  __setLLMClient(client);
  const paused = await toolPause();
  out.toolPausePaused = hasInterrupts(paused.data);
  const final = await respondToInterrupts(paused.data, [approve()]);
  out.toolPauseResult = final.data;
  out.toolPauseRequests = requests.length;
  out.toolPauseRetryCarriesNoteOnce = notesIn(requests[1]) === 1;
  out.toolPauseLastRequestClean = notesIn(requests[2]) === 0 && !holdsEmptyReply(requests[2]);
}

// Test 7: a pause at the cut-off gate resumes the same retry.
{
  const { client, requests } = makeClient([EMPTY_CUT_OFF, { output: "done" }, { output: "after" }]);
  __setLLMClient(client);
  const paused = await gatePause();
  out.gatePausePaused = hasInterrupts(paused.data);
  out.gatePauseRequestsBeforeResume = requests.length;
  const final = await respondToInterrupts(paused.data, [approve({ maxCost: 0.0001 })]);
  out.gatePauseResult = final.data;
  out.gatePauseRequests = requests.length;
  out.gatePauseRetryCarriesNoteOnce = notesIn(requests[1]) === 1 && !holdsEmptyReply(requests[1]);
  out.gatePauseThreadClean = notesIn(requests[2]) === 0 && !holdsEmptyReply(requests[2]);
}

// Test 8: a guard trip during the retried request sends the note again.
{
  const { client, requests } = makeClient([
    EMPTY_CUT_OFF,
    { output: "too slow", delayMs: 5000 },
    { output: "done" },
  ]);
  __setLLMClient(client);
  const final = await tripDuringRetry();
  out.tripResult = final.data;
  out.tripRequests = requests.length;
  out.tripEveryAttemptCarriesNoteOnce = notesIn(requests[1]) === 1 && notesIn(requests[2]) === 1;
}

writeFileSync("__result.json", JSON.stringify(out, null, 2));
