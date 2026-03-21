import { main } from "./agent.js";
import { writeFileSync } from "fs";

const entries = [];
const result = await main({
  callbacks: {
    onAuditLog: (entry) => {
      const { timestamp, ...rest } = entry;
      // Strip non-deterministic fields: durations, token counts, model name, prompt,
      // and message threads (which contain non-deterministic tool call IDs)
      if (rest.type === "llmCall") {
        const { duration, tokens, model, prompt, ...llmRest } = rest;
        entries.push(llmRest);
      } else if (rest.type === "toolCall") {
        const { duration, ...toolRest } = rest;
        entries.push(toolRest);
      } else if (rest.type === "return" && rest.value?.messages) {
        entries.push({ type: "return", value: { data: rest.value.data } });
      } else {
        entries.push(rest);
      }
    },
  },
});

writeFileSync(
  "__result.json",
  JSON.stringify({ data: result.data, entries }, null, 2),
);
