import { ask } from "./agent.js";
import { writeFileSync } from "fs";

let messagesAtStart = null;
let messagesAtEnd = null;
let injectedSystemMessage = false;

const callbacks = {
  onLLMCallStart: ({ messages }) => {
    messagesAtStart = messages.length;
    // Inject a system message before the LLM call
    return [
      { role: "system", content: "You must respond with exactly one word, no punctuation." },
      ...messages,
    ];
  },
  onLLMCallEnd: ({ messages }) => {
    messagesAtEnd = messages.length;
    // Check that our injected system message is present
    injectedSystemMessage = messages.some(
      (m) => m.role === "system" && m.content.includes("one word"),
    );
  },
};

const result = await ask({ callbacks });

writeFileSync(
  "__result.json",
  JSON.stringify({
    messagesAtStart,
    messagesAtEnd,
    injectedSystemMessage,
    hasData: typeof result.data === "string" && result.data.length > 0,
  }, null, 2),
);
