import { main, hasInterrupts, approve, reject, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

// Test 1: result.data is an array of interrupts
const result = await main();

if (!hasInterrupts(result.data)) {
  throw new Error("Expected interrupt array, got: " + JSON.stringify(result.data));
}

const interrupts = result.data;

// Test 2: correct number of interrupts (one per fork thread)
if (interrupts.length !== 3) {
  throw new Error("Expected 3 interrupts, got " + interrupts.length);
}

// Test 3: each interrupt has an interruptId
for (const intr of interrupts) {
  if (!intr.interruptId) {
    throw new Error("Interrupt missing interruptId: " + JSON.stringify(intr));
  }
}

// Test 4: all interruptIds are unique
const ids = interrupts.map(i => i.interruptId);
if (new Set(ids).size !== ids.length) {
  throw new Error("Duplicate interruptIds: " + JSON.stringify(ids));
}

// Test 5: interrupts have correct data payloads
const messages = interrupts.map(i => i.data).sort();
const expected = ["approve a?", "approve b?", "approve c?"];
if (JSON.stringify(messages) !== JSON.stringify(expected)) {
  throw new Error("Unexpected interrupt messages: " + JSON.stringify(messages));
}

// Test 6: all interrupts share the same checkpoint
const checkpoints = interrupts.map(i => i.checkpoint);
if (!checkpoints.every(cp => cp === checkpoints[0])) {
  throw new Error("Interrupts don't share a checkpoint");
}

// Test 7: approve all, verify results in correct order
const responses = interrupts.map(() => approve());
const finalResult = await respondToInterrupts(interrupts, responses);

if (hasInterrupts(finalResult.data)) {
  throw new Error("Expected final result, got more interrupts");
}

// Results should be in the same order as the fork input items
const data = finalResult.data;
if (JSON.stringify(data) !== JSON.stringify(["confirmed: a", "confirmed: b", "confirmed: c"])) {
  throw new Error("Unexpected result ordering: " + JSON.stringify(data));
}

writeFileSync("__result.json", JSON.stringify(data, null, 2));
