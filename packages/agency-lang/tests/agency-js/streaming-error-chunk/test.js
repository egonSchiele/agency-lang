import { main, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";

// Stream terminates on an `error` chunk with no `done`. The onStream callback
// should still see the "error" event, and the llm() call should fail with the
// PROVIDER's error surfaced — not a generic "No completion returned".
const client = {
  async text() {
    return { success: false, error: "provider exploded" };
  },
  async *textStream() {
    yield { type: "error", error: "provider exploded" };
  },
  async embed() {
    return { success: false, error: "embed not implemented" };
  },
};

__setLLMClient(client);

const result = await main();

writeFileSync(
  "__result.json",
  JSON.stringify({ data: result.data }, null, 2),
);
