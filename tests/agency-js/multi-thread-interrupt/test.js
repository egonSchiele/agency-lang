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

// Build responses — approve both
const responses = {};
for (const interrupt of batch.interrupts) {
  responses[interrupt.interrupt_id] = { type: "approve" };
}

// Resume with all responses
const finalResult = await respondToInterrupts(batch, responses);

writeFileSync(
  "__result.json",
  JSON.stringify(finalResult.data, null, 2),
);
