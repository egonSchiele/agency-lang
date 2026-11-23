import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

// What `agency run --scratch` sets before the run starts.
process.env.AGENCY_SCRATCH = "1";

const paused = await main();
if (!hasInterrupts(paused.data)) {
  throw new Error(`expected the run to pause, got ${JSON.stringify(paused.data)}`);
}
const final = await respondToInterrupts(paused.data, [approve()]);
writeFileSync("__result.json", JSON.stringify(final.data, null, 2));
