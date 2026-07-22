import { midRound, preQueued, scoped, ordered, respondToInterrupts, approve, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";
import { ToolCall } from "smoltalk";

// Each scenario gets a fresh recording client: it captures the messages
// array of every request the model actually sees, which is the only
// honest way to assert WHERE a queued message was delivered.

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
// Non-zero cost so guard(cost: $0.000001) actually trips in scenario 4.
const COST = { inputCost: 0.000001, outputCost: 0.000001, totalCost: 0.000002, currency: "USD" };

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

// Scenario 4 (order + resume across the boundary): attachment, queued
// message, and guard feedback co-occur in one round. The cost guard trips
// at the round gate (a REAL pause), the approve carries a message, and
// the resumed second request must contain all three in order: tool
// result, then attachment, then queued, then feedback. Delivery across
// the pause also proves exactly-once: each appears a single time.
{
  writeFileSync("/tmp/qm-order-chart.png",
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));
  const { captured, client } = makeClient([
    { toolCalls: [new ToolCall("c1", "chartTool", {})] },
    { output: "done" },
  ]);
  __setLLMClient(client);
  const paused = await ordered({});
  const isPaused = Array.isArray(paused.data);
  out.orderedTripsAtGate = isPaused;
  const resumed = isPaused
    ? await respondToInterrupts(paused.data, [approve({ maxCost: 0.0001, message: "feedback last" })])
    : paused;
  // ordered() returns the guard Result envelope on success.
  out.orderedResumedToDone = resumed.data?.value === "done";

  const second = captured[captured.length - 1];
  const idxOf = (pred) => second.findIndex(pred);
  const toolIdx = idxOf((m) => m.role === "tool");
  const attIdx = idxOf((m) => JSON.stringify(m.content ?? "").includes("chartTool"));
  const queuedIdx = idxOf((m) => typeof m.content === "string" && m.content.includes("queued middle"));
  const fbIdx = idxOf((m) => typeof m.content === "string" && m.content.includes("feedback last"));
  out.orderedAllThreePresent = attIdx !== -1 && queuedIdx !== -1 && fbIdx !== -1;
  out.orderedSequence = toolIdx < attIdx && attIdx < queuedIdx && queuedIdx < fbIdx;
  const countIn = (needle) =>
    second.filter((m) => JSON.stringify(m.content ?? "").includes(needle)).length;
  out.orderedExactlyOnce =
    countIn("queued middle") === 1 && countIn("feedback last") === 1;
}

for (const [k, v] of Object.entries(out)) {
  if (v !== true) throw new Error(`assertion failed: ${k} = ${v}`);
}
writeFileSync("__result.json", JSON.stringify(out, null, 2));
