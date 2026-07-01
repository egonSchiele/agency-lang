import { main } from "./agent.js";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Write each model-data file to a temp path (not the test dir) and hand the
// absolute path to the agency program via env — no cwd assumptions.
function writeModelFile(suffix, modelName) {
  const p = join(tmpdir(), `agency-models-load-${process.pid}-${suffix}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "test",
      models: [
        { type: "text", modelName, provider: "acme", inputTokenCost: 1, outputTokenCost: 2, maxInputTokens: 4096, family: "acme" },
      ],
      hostedTools: [],
    }),
  );
  return p;
}
process.env.MODELS_FIXTURE_A = writeModelFile("a", "custom-load-a");
process.env.MODELS_FIXTURE_B = writeModelFile("b", "custom-load-b");

const result = await main({});
writeFileSync(
  new URL("./__result.json", import.meta.url),
  JSON.stringify(result.data, null, 2),
);
