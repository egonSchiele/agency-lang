import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

// What one answered leg came to: its value, or the name of what stopped it.
async function answer(interrupts, opts) {
  try {
    const result = await respondToInterrupts(interrupts, interrupts.map(() => approve()), opts);
    return hasInterrupts(result.data) ? "interrupted" : result.data;
  } catch (error) {
    return error.name;
  }
}

// 1. No invocation options: the leg runs under no budget and finishes.
const first = await main();
const unbudgeted = await answer(first.data);

// 2. A per-invocation time budget shorter than the sleep stops the leg.
const second = await main();
const budgeted = await answer(second.data, {
  invocation: { config: { budget: { maxTime: "50ms" } } },
});

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      interrupted: hasInterrupts(first.data) && hasInterrupts(second.data),
      unbudgeted,
      budgetStoppedTheLeg: budgeted !== "done",
    },
    null,
    2,
  ),
);
