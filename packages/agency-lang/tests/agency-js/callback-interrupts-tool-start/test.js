import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

// `callback("onToolCallStart")` fires inside a parallel tool branch.
// Phase 1: b.step(...start) returns the Interrupt[] up through
// BranchRunner, parallel() merges into a single PromptBailout, runPrompt
// returns the interrupts. Resume re-runs the same branch step; the
// callback re-fires (count=2, no interrupt), the tool executes, the
// follow-up LLM call produces the final answer.
const initial = await main();

if (!hasInterrupts(initial.data)) {
  throw new Error(
    `Expected interrupts from main(); got: ${JSON.stringify(initial.data)}`,
  );
}

const final = await respondToInterrupts(initial.data, [approve()]);

writeFileSync(
  "__result.json",
  JSON.stringify({ data: final.data }, null, 2),
);
