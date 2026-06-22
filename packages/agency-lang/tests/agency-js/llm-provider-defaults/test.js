import { main } from "./agent.js";
import { writeFileSync } from "node:fs";

// Control which keys are "set": ANTHROPIC + OPENAI set, GEMINI unset.
// This reproduces the user's situation (an ANTHROPIC key present that
// would otherwise win auto-detection) so the `--provider openai` path
// can be shown to bypass it.
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
delete process.env.GEMINI_API_KEY;
process.env.OPENAI_API_KEY = "test-openai-key";

const result = await main({});
writeFileSync(
  new URL("./__result.json", import.meta.url),
  JSON.stringify(result.data, null, 2),
);
