import { tenFailuresRemove, successResets } from "./agent.js";
import { writeFileSync } from "fs";

// Capture every tool-role message the model sees, via onLLMCallStart:
// each round's request carries the tool results of the previous round.
const makeCapture = () => {
  const state = { toolMessages: [], toolStarts: 0 };
  const callbacks = {
    onLLMCallStart: ({ messages }) => {
      for (const m of messages) {
        if (m.role === "tool") {
          const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          if (!state.toolMessages.includes(text)) state.toolMessages.push(text);
        }
      }
    },
    onToolCallStart: () => {
      state.toolStarts += 1;
    },
  };
  return { state, callbacks };
};

const seen = (state, substring) => state.toolMessages.some((m) => m.includes(substring));

const results = {};

// Ten failures in a row: the tenth says the tool is gone, and the
// eleventh scripted call never starts.
{
  const { state, callbacks } = makeCapture();
  const result = await tenFailuresRemove({ callbacks });
  results.tenFailuresRemove = {
    result: result.data,
    toolStarts: state.toolStarts,
    removalSeen: seen(state, "failed too many times"),
  };
}

// Nine failures, a success, nine failures, a success: twenty calls, all
// run. Without the reset the tenth failure would remove the tool and the
// last nine calls would never start.
{
  const { state, callbacks } = makeCapture();
  const result = await successResets({ callbacks });
  results.successResets = {
    result: result.data,
    toolStarts: state.toolStarts,
    removalSeen: seen(state, "can no longer be called"),
  };
}

writeFileSync("__result.json", JSON.stringify(results, null, 2));
