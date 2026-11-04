// Drives agent.agency with a fake model client that records the messages
// each request carries.
//
// - The run pauses on the main arm's interrupt, and this script approves
//   it.
// - The model is asked exactly twice: the main arm's llm() is not asked
//   again on resume.
// - The second request carries the main arm's prompt and reply before its
//   own prompt. If the main arm had written to a copy of the conversation,
//   or the resume had lost it, the second request would hold only
//   "follow up".
import { writeFileSync } from "fs";
import { main, hasInterrupts, approve, respondToInterrupts, __setLLMClient } from "./agent.js";

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
const replies = ["reply from the main arm", "reply to the follow-up"];
const requests = [];

const client = {
  async text(config) {
    const index = requests.length;
    requests.push(
      (config.messages || []).map((message) => ({
        role: message.role,
        content:
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      })),
    );
    const output = replies[Math.min(index, replies.length - 1)];
    return {
      success: true,
      value: { output, toolCalls: [], model: "test", usage: USAGE, cost: COST },
    };
  },
  async *textStream(config) {
    const result = await this.text(config);
    if (result.success) yield { type: "done", result: result.value };
    else yield { type: "error", error: result.error };
  },
  async embed() {
    return { success: false, error: "embed not implemented" };
  },
};

__setLLMClient(client);

const first = await main();
const paused = hasInterrupts(first.data);
const pausedOn = paused ? first.data.map((intr) => intr.message) : [];
const final = paused ? await respondToInterrupts(first.data, [approve()]) : first;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      pausedOn,
      finalData: final.data,
      requestCount: requests.length,
      followUpRequest: requests[1] ?? null,
    },
    null,
    2,
  ),
);
