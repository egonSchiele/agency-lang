import { foo, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

// Call 1: sleep 10s, don't mutate globalVar
// Call 2: sleep 5s, set globalVar to "mutated" before the interrupt
// Both calls hit an interrupt after mutating (or not) the global.
// We then approve both and check that globals are still isolated.

const result1 = await foo(3000, null);
const result2 = await foo(1000, "mutated");

if (!hasInterrupts(result1.data))
  throw new Error("Expected interrupt from call 1");
if (!hasInterrupts(result2.data))
  throw new Error("Expected interrupt from call 2");

// Approve both interrupts concurrently.
// Call 2 finishes first (5s sleep), call 1 finishes second (10s sleep).
// If isolation works, call 1 still returns "unchanged".
const [final1, final2] = await Promise.all([
  respondToInterrupts(result1.data, [approve()]),
  respondToInterrupts(result2.data, [approve()]),
]);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      call1: final1.data,
      call2: final2.data,
    },
    null,
    2,
  ),
);
