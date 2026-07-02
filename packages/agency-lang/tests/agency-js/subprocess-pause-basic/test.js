import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

const first = await main();

// The child's std::bash interrupt has no handler anywhere → it must
// SURFACE as an interrupt on the parent result (not a rejection).
if (!hasInterrupts(first.data)) {
  writeFileSync("__result.json", JSON.stringify({
    error: "expected surfaced interrupt, got: " + JSON.stringify(first.data),
  }));
  process.exit(0);
}

const surfaced = first.data;
const resumed = await respondToInterrupts(surfaced, surfaced.map(() => approve()));

writeFileSync("__result.json", JSON.stringify({
  surfacedEffects: surfaced.map((i) => i.effect),
  finalData: resumed.data,
}, null, 2));
