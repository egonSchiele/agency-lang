import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

let result = await main();
if (!hasInterrupts(result.data)) throw new Error("Expected first interrupt");

// First cycle: override multiplier to 100.
result = await respondToInterrupts(result.data, [approve()], {
  overrides: { multiplier: 100 },
});
if (!hasInterrupts(result.data)) throw new Error("Expected second interrupt");

// Second cycle: override multiplier again, this time to 5. Each cycle's
// override applies to that cycle's checkpoint independently — it should
// NOT undo the first cycle's snapshot, because snapshot1 was already
// captured in a frame local before the second checkpoint was made.
result = await respondToInterrupts(result.data, [approve()], {
  overrides: { multiplier: 5 },
});
if (hasInterrupts(result.data)) throw new Error("Expected final result");

writeFileSync("__result.json", JSON.stringify(result.data, null, 2));
