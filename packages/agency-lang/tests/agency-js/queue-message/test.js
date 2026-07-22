import { midRound, preQueued, scoped, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";
import { ToolCall } from "smoltalk";

// Each scenario gets a fresh recording client: it captures the messages
// array of every request the model actually sees, which is the only
// honest way to assert WHERE a queued message was delivered.

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

function makeClient(script) {
  const captured = [];
  let i = 0;
  return {
    captured,
    client: {
      async text(config) {
        captured.push(
          config.messages.map((m) => {
            const j = typeof m.toJSON === "function" ? m.toJSON() : m;
            return { role: j.role, content: j.content ?? null };
          }),
        );
        const turn = script[Math.min(i, script.length - 1)];
        i++;
        return {
          success: true,
          value: {
            output: turn.output ?? null,
            toolCalls: turn.toolCalls ?? [],
            model: "test",
            usage: USAGE,
            cost: COST,
          },
        };
      },
    },
  };
}

const flat = (reqs) =>
  reqs.map((req) => req.map((m) => `${m.role}:${JSON.stringify(m.content)}`).join("|"));
const contains = (reqStr, text) => reqStr.includes(text);

const out = {};

// Scenario 1: queued mid-round -> delivered after the tool result,
// before the next request; absent from the first request.
{
  const { captured, client } = makeClient([
    { toolCalls: [new ToolCall("c1", "lookup", {})] },
    { output: "done" },
  ]);
  __setLLMClient(client);
  await midRound({});
  const reqs = flat(captured);
  out.midRoundTwoRequests = captured.length === 2;
  out.midRoundAbsentFromFirstRequest = !contains(reqs[0], "queued mid-round");
  const second = captured[1];
  const toolIdx = second.findIndex((m) => m.role === "tool");
  const queuedIdx = second.findIndex(
    (m) => typeof m.content === "string" && m.content.includes("queued mid-round"),
  );
  out.midRoundDeliveredInSecondRequest = queuedIdx !== -1;
  out.midRoundAfterToolResult = toolIdx !== -1 && queuedIdx > toolIdx;
}

// Scenario 2: queued before a NO-tool llm() -> delivered in that call's
// FIRST request, ahead of the prompt.
{
  const { captured, client } = makeClient([{ output: "ok" }]);
  __setLLMClient(client);
  await preQueued({});
  const first = captured[0];
  const queuedIdx = first.findIndex(
    (m) => typeof m.content === "string" && m.content.includes("queued before the call"),
  );
  const promptIdx = first.findIndex(
    (m) => typeof m.content === "string" && m.content.includes("answer briefly"),
  );
  out.preQueuedDelivered = queuedIdx !== -1;
  out.preQueuedBeforePrompt = queuedIdx !== -1 && promptIdx !== -1 && queuedIdx < promptIdx;
}

// Scenario 3: queued onto a different thread -> never delivered to the
// main conversation.
{
  const { captured, client } = makeClient([{ output: "ok" }]);
  __setLLMClient(client);
  await scoped({});
  const all = flat(captured).join("||");
  out.scopedNotDeliveredToMainThread = !contains(all, "for the side thread");
}

for (const [k, v] of Object.entries(out)) {
  if (v !== true) throw new Error(`assertion failed: ${k} = ${v}`);
}
writeFileSync("__result.json", JSON.stringify(out, null, 2));
