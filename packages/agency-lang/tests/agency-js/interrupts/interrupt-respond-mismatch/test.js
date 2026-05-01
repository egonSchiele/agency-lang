import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

if (!hasInterrupts(result.data)) {
  throw new Error("Expected an interrupt array");
}

const interrupts = result.data;
if (interrupts.length !== 2) {
  throw new Error("Expected 2 interrupts, got " + interrupts.length);
}

// Pass too few responses — must throw
let tooFewError = null;
try {
  await respondToInterrupts(interrupts, [approve()]);
} catch (e) {
  tooFewError = e.message;
}

// Pass too many responses — must also throw
let tooManyError = null;
try {
  await respondToInterrupts(interrupts, [approve(), approve(), approve()]);
} catch (e) {
  tooManyError = e.message;
}

// Empty responses — must throw too
let emptyError = null;
try {
  await respondToInterrupts(interrupts, []);
} catch (e) {
  emptyError = e.message;
}

// Verify both errors mention the count mismatch
function summarize(msg) {
  if (!msg) return null;
  return {
    mentionsExpected: msg.includes("expected 2 responses"),
    mentionsCount: /got [013]/.test(msg),
  };
}

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      tooFew: summarize(tooFewError),
      tooMany: summarize(tooManyError),
      empty: summarize(emptyError),
    },
    null,
    2,
  ),
);
