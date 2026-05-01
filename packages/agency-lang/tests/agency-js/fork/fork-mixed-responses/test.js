import { main, hasInterrupts, approve, reject, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

if (!hasInterrupts(result.data)) {
  throw new Error("Expected interrupt array");
}

const interrupts = result.data;
if (interrupts.length !== 2) {
  throw new Error("Expected 2 interrupts, got " + interrupts.length);
}

// Find which interrupt is for "a" and which is for "b"
const interruptA = interrupts.find(i => i.data === "approve a?");
const interruptB = interrupts.find(i => i.data === "approve b?");

if (!interruptA || !interruptB) {
  throw new Error("Could not find expected interrupts: " + JSON.stringify(interrupts.map(i => i.data)));
}

// Approve "a", reject "b" — responses must be in same order as interrupts array
const responses = interrupts.map(intr => {
  if (intr.data === "approve a?") return approve();
  return reject();
});

const finalResult = await respondToInterrupts(interrupts, responses);

if (hasInterrupts(finalResult.data)) {
  throw new Error("Expected final result, got more interrupts");
}

// "a" should be confirmed, "b" should be a failure
const data = finalResult.data;

// data[0] should be "confirmed: a"
if (data[0] !== "confirmed: a") {
  throw new Error("Expected 'confirmed: a', got: " + JSON.stringify(data[0]));
}

// data[1] should be a failure result (from the rejected interrupt)
if (!data[1] || data[1].success !== false) {
  throw new Error("Expected failure for rejected item, got: " + JSON.stringify(data[1]));
}

if (!data[1].error.includes("interrupt rejected")) {
  throw new Error("Expected 'interrupt rejected' error, got: " + data[1].error);
}

writeFileSync("__result.json", JSON.stringify({
  approved: data[0],
  rejected: { success: data[1].success, error: data[1].error }
}, null, 2));
