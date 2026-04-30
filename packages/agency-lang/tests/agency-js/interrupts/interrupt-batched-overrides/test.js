import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

if (!hasInterrupts(result.data)) {
  throw new Error("Expected interrupt array");
}
if (result.data.length !== 3) {
  throw new Error("Expected 3 interrupts, got " + result.data.length);
}

// Override `multiplier` to 100 before resuming. The override is applied to
// the parent (main) frame's locals, and all three branches read multiplier
// from the parent scope, so all three computed results should reflect the
// override.
const responses = result.data.map(() => approve());
const final = await respondToInterrupts(result.data, responses, {
  overrides: { multiplier: 100 },
});

if (hasInterrupts(final.data)) {
  throw new Error("Expected final result, got more interrupts");
}

writeFileSync("__result.json", JSON.stringify({ results: final.data }, null, 2));
