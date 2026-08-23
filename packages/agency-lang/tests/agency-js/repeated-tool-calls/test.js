import { main, disabled, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";
import { ToolCall } from "smoltalk";

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

// A client that replays a script of tool-call rounds, then finishes, and
// keeps the messages of its last call so the tool messages can be read.
function scriptedClient(script) {
  let round = 0;
  const client = {
    lastMessages: [],
    async text(config) {
      client.lastMessages = config.messages.map((m) => {
        const j = typeof m.toJSON === "function" ? m.toJSON() : m;
        return { role: j.role, content: j.content ?? null };
      });
      const calls = script[round++];
      if (calls === undefined) {
        return {
          success: true,
          value: { output: "done", toolCalls: [], model: "test", usage: USAGE, cost: COST },
        };
      }
      return {
        success: true,
        value: {
          output: null,
          toolCalls: calls.map((args, i) => new ToolCall(`call-${round}-${i}`, "probe", args)),
          model: "test",
          usage: USAGE,
          cost: COST,
        },
      };
    },
    async *textStream(config) {
      const r = await this.text(config);
      yield { type: "done", result: r.value };
    },
    async embed() {
      return { success: false, error: "not implemented" };
    },
  };
  return client;
}

function toolMessages(client) {
  return client.lastMessages
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}

// Five identical calls (argument order varies once), then one garbled call.
// With the default of 3: calls 1-3 run, call 4 is refused (which restarts
// the count), call 5 runs again.
const same = { query: "x" };
const script = [
  [same],
  [same],
  [{ query: "x" }],
  [same],
  [same],
  [{ query: "y", flags: '</antml name="flags">\n<parameter name="maxResults">50' }],
];

const guarded = scriptedClient(script);
__setLLMClient(guarded);
await main();
const guardedMsgs = toolMessages(guarded);

const unguarded = scriptedClient(script.slice(0, 5));
__setLLMClient(unguarded);
await disabled();
const unguardedMsgs = toolMessages(unguarded);

const out = {
  guardedRan: guardedMsgs.filter((m) => m === "ok:x").length,
  guardedRefused: guardedMsgs.filter((m) => m.includes("It was not run")).length,
  refusalNamesCall: guardedMsgs.some((m) => m.includes("call 4 to probe")),
  markupRefused: guardedMsgs.some((m) => m.includes("tool-call markup") && m.includes("`flags`")),
  markupNeverRan: !guardedMsgs.includes("ok:y"),
  unguardedRan: unguardedMsgs.filter((m) => m === "ok:x").length,
};

writeFileSync("__result.json", JSON.stringify(out, null, 2));
