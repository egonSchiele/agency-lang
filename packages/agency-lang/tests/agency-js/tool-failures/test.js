import { exitsNeverRemove, fiveFailuresRemove, successResets } from "./agent.js";
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

// Six non-zero exits in a row: every call runs, the tool is never removed,
// and the model reads the output as the tool wrote it, with no "Error:"
// in front and no advice after.
{
  const { state, callbacks } = makeCapture();
  const result = await exitsNeverRemove({ callbacks });
  results.exitsNeverRemove = {
    result: result.data,
    toolStarts: state.toolStarts,
    removalSeen: seen(state, "can no longer be called"),
    firstMessage: state.toolMessages[0],
  };
}

// Five ordinary failures in a row: the fifth says the tool is gone, and
// the sixth scripted call never starts.
{
  const { state, callbacks } = makeCapture();
  const result = await fiveFailuresRemove({ callbacks });
  results.fiveFailuresRemove = {
    result: result.data,
    toolStarts: state.toolStarts,
    removalSeen: seen(state, "failed too many times"),
    firstMessage: state.toolMessages[0],
  };
}

// Four failures, a success, four failures, a success: ten calls, all
// run. Without the reset the fifth failure would remove the tool and the
// last four calls would never start.
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
