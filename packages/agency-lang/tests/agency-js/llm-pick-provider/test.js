import { main } from "./agent.js";
import { writeFileSync } from "node:fs";

// Control which keys are "set": GEMINI + OPENAI set, ANTHROPIC unset.
delete process.env.ANTHROPIC_API_KEY;
process.env.GEMINI_API_KEY = "test-google-key";
process.env.OPENAI_API_KEY = "test-openai-key";

const result = await main({});
writeFileSync(
  new URL("./__result.json", import.meta.url),
  JSON.stringify(result.data, null, 2),
);
