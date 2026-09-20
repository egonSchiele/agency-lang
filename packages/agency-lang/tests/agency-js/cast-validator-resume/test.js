import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

const first = await main();

// The validator's interrupt has no handler anywhere, so it must SURFACE
// with a checkpoint rather than be rejected.
if (!hasInterrupts(first.data)) {
  writeFileSync("__result.json", JSON.stringify({
    error: "expected a surfaced interrupt, got: " + JSON.stringify(first.data),
  }));
  process.exit(0);
}

const surfaced = first.data;
const resumed = await respondToInterrupts(surfaced, surfaced.map(() => approve()));

writeFileSync("__result.json", JSON.stringify({
  surfacedEffects: surfaced.map((i) => i.effect),
  finalData: resumed.data,
}, null, 2));
