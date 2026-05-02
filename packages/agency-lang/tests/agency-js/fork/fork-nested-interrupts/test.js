import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

if (!hasInterrupts(result.data)) {
  throw new Error("Expected interrupt array, got: " + JSON.stringify(result.data));
}

const interrupts = result.data;

// 2 outer threads × 2 inner threads = 4 interrupts, all flattened into one batch
if (interrupts.length !== 4) {
  throw new Error("Expected 4 interrupts from nested forks, got " + interrupts.length);
}

// All interruptIds should be unique
const ids = interrupts.map(i => i.interruptId);
if (new Set(ids).size !== ids.length) {
  throw new Error("Duplicate interruptIds: " + JSON.stringify(ids));
}

// Verify expected messages (order may vary due to parallel execution)
const messages = interrupts.map(i => i.message).sort();
const expected = ["approve x-1?", "approve x-2?", "approve y-1?", "approve y-2?"];
if (JSON.stringify(messages) !== JSON.stringify(expected)) {
  throw new Error("Unexpected interrupt messages: " + JSON.stringify(messages));
}

// Approve all
const responses = interrupts.map(() => approve());
const finalResult = await respondToInterrupts(interrupts, responses);

if (hasInterrupts(finalResult.data)) {
  throw new Error("Expected final result, got more interrupts");
}

// Results: outer fork returns array of inner fork results
// [[confirmed: x-1, confirmed: x-2], [confirmed: y-1, confirmed: y-2]]
const data = finalResult.data;
if (!Array.isArray(data) || data.length !== 2) {
  throw new Error("Expected 2 outer results, got: " + JSON.stringify(data));
}

for (const inner of data) {
  if (!Array.isArray(inner) || inner.length !== 2) {
    throw new Error("Expected 2 inner results per outer thread, got: " + JSON.stringify(inner));
  }
}

writeFileSync("__result.json", JSON.stringify(data, null, 2));
