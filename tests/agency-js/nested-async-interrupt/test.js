import { main, isInterruptBatch, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

if (!isInterruptBatch(result.data)) {
  throw new Error("Expected InterruptBatch, got: " + JSON.stringify(result));
}

const batch = result.data;
if (batch.interrupts.length !== 2) {
  throw new Error("Expected 2 interrupts, got " + batch.interrupts.length);
}

// Find the interrupts by their data
const ageInterrupt = batch.interrupts.find(i => i.data === "How old are you?");
const nameInterrupt = batch.interrupts.find(i => i.data === "What's your name?");

if (!ageInterrupt || !nameInterrupt) {
  throw new Error("Could not find expected interrupts. Got: " + JSON.stringify(batch.interrupts.map(i => i.data)));
}

// Resolve both with values
const responses = {
  [ageInterrupt.interrupt_id]: { type: "resolve", value: "25" },
  [nameInterrupt.interrupt_id]: { type: "resolve", value: "Alice" },
};

const finalResult = await respondToInterrupts(batch, responses);

writeFileSync(
  "__result.json",
  JSON.stringify(finalResult.data, null, 2),
);
