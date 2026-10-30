import { main, respondToInterrupts, approve } from "./agent.js";
import { writeFileSync } from "fs";

// Record every request the model sees, in order.
const requests = [];
const callbacks = {
  onLLMCallStart: ({ messages }) => {
    requests.push(messages);
  },
};

const text = (message) =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);
const count = (messages, needle) =>
  messages.filter((message) => text(message).includes(needle)).length;
const hasToolCalls = (message) => Array.isArray(message.toolCalls) && message.toolCalls.length > 0;

// Would a real provider accept this request? Every assistant message with
// N tool calls is followed by exactly N tool messages, tool messages appear
// nowhere else, and a request never ends on an assistant message.
const wellFormed = (messages) => {
  let owed = 0;
  for (const message of messages) {
    if (message.role === "tool") {
      if (owed === 0) {
        return false;
      }
      owed -= 1;
      continue;
    }
    if (owed > 0) {
      return false;
    }
    if (message.role === "assistant" && hasToolCalls(message)) {
      owed = message.toolCalls.length;
    }
  }
  return owed === 0 && messages[messages.length - 1]?.role !== "assistant";
};

const FIRST = "tool rounds for this request";
const FINAL = "last tool round";

const paused = await main({ callbacks });
const resumed = await respondToInterrupts(paused.data, [approve()], {
  metadata: { callbacks },
});

// The first call's last request holds every warning the call sent; the
// second call's request shows the thread after the first call returned.
const lastOfFirstCall = requests[requests.length - 2];
const secondCall = requests[requests.length - 1];
writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      result: resumed.data,
      requestCount: requests.length,
      allWellFormed: requests.every(wellFormed),
      firstWarningsSent: count(lastOfFirstCall, FIRST),
      finalWarningsSent: count(lastOfFirstCall, FINAL),
      secondCallSawWarning: count(secondCall, FIRST) + count(secondCall, FINAL),
    },
    null,
    2,
  ),
);
