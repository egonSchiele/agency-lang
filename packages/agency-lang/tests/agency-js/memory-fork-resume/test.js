import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

// First pass: each branch sets its own memory id then interrupts.
const result = await main();
if (!hasInterrupts(result.data)) {
  throw new Error("Expected interrupts, got: " + JSON.stringify(result.data));
}
const interrupts = result.data;
if (interrupts.length !== 2) {
  throw new Error("Expected 2 interrupts, got " + interrupts.length);
}

// Approve all and resume. Each branch returns getMemoryId() AFTER the
// interrupt — it must be the branch's own id, proving branch-local
// memory survived resume (and was not re-seeded to the parent's "base").
const finalResult = await respondToInterrupts(interrupts, interrupts.map(() => approve()));
if (hasInterrupts(finalResult.data)) {
  throw new Error("Expected final result, got more interrupts");
}
const data = finalResult.data;
if (JSON.stringify(data) !== JSON.stringify(["id-a", "id-b"])) {
  throw new Error("Branch memory id not preserved across resume: " + JSON.stringify(data));
}

writeFileSync("__result.json", JSON.stringify(data, null, 2));
