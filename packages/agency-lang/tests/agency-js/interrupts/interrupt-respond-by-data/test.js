import { main, hasInterrupts, approve, reject, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

if (!hasInterrupts(result.data)) {
  throw new Error("Expected interrupt array");
}

const interrupts = result.data;
if (interrupts.length !== 3) {
  throw new Error("Expected 3 interrupts, got " + interrupts.length);
}

// Build responses by inspecting each interrupt's data — order-independent decision-making.
// Approve alpha and gamma, reject beta. The responses array MUST be in the same order as
// the interrupts array, but each response is selected by content.
const responses = interrupts.map((intr) => {
  if (intr.message === "approve beta?") return reject("nope");
  return approve();
});

const finalResult = await respondToInterrupts(interrupts, responses);

if (hasInterrupts(finalResult.data)) {
  throw new Error("Expected final result, got more interrupts");
}

const out = finalResult.data;
if (!Array.isArray(out) || out.length !== 3) {
  throw new Error("Expected an array of 3 results, got " + JSON.stringify(out));
}

// Approved branches return the string. Rejected branch returns a failure Result.
function classify(value) {
  if (typeof value === "string") return { kind: "ok", value };
  if (value && value.success === false) {
    return {
      kind: "rejected",
      hasRejectionMessage: typeof value.error === "string" && value.error.length > 0,
    };
  }
  return { kind: "unknown", value };
}

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      alpha: classify(out[0]),
      beta: classify(out[1]),
      gamma: classify(out[2]),
    },
    null,
    2,
  ),
);
