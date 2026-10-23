import { decorated } from "./agent.js";
import { writeFileSync } from "fs";

// Record every request the model sees and every tool start, so the test can
// read back the caller's final thread and the tool schema the model was given.
const state = { requests: [], toolStarts: [], toolSchemas: [] };
const callbacks = {
  onLLMCallStart: ({ messages, tools }) => {
    state.requests.push(messages);
    state.toolSchemas.push((tools ?? []).map((tool) => tool.name));
  },
  onToolCallStart: ({ toolName }) => {
    state.toolStarts.push(toolName);
  },
};

const text = (message) =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);
const count = (messages, needle) =>
  messages.filter((message) => text(message).includes(needle)).length;

const result = await decorated({ callbacks });
const final = state.requests[state.requests.length - 1];

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      result: result.data,
      requestCount: state.requests.length,
      toolStarts: state.toolStarts,
      // The caller's first request offers the decorated handoff as a tool
      // under the def's own name; nothing about the decorator is visible.
      toolsOfferedFirst: state.toolSchemas[0],
      roles: final.map((message) => message.role),
      resumeCarriesResult: count(final, "[subagent finished. inner answer]"),
    },
    null,
    2,
  ),
);
