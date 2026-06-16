import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

// First pass: each branch enables memory then interrupts.
const result = await main();
if (!hasInterrupts(result.data)) {
  throw new Error("Expected interrupts, got: " + JSON.stringify(result.data));
}
const interrupts = result.data;
if (interrupts.length !== 2) {
  throw new Error("Expected 2 interrupts, got " + interrupts.length);
}

// Approve all and resume. Each branch returns isMemoryActive() AFTER the
// interrupt — it must be true, proving the branch-local memory frame
// survived serialize/restore.
const finalResult = await respondToInterrupts(interrupts, interrupts.map(() => approve()));
if (hasInterrupts(finalResult.data)) {
  throw new Error("Expected final result, got more interrupts");
}
const data = finalResult.data;
if (JSON.stringify(data) !== JSON.stringify([true, true])) {
  throw new Error("Branch memory frame not preserved across resume: " + JSON.stringify(data));
}

writeFileSync("__result.json", JSON.stringify(data, null, 2));
