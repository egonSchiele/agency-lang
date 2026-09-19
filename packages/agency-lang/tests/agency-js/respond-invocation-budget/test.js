import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

// What one answered leg came to: its value, or what stopped it. An abort
// carries a structured cause, so a budget trip can be named as one rather than
// lumped in with any other throw.
async function answer(interrupts, opts) {
  try {
    const result = await respondToInterrupts(interrupts, interrupts.map(() => approve()), opts);
    return hasInterrupts(result.data) ? "interrupted" : result.data;
  } catch (error) {
    const cause = error.agencyCause;
    return cause && cause.kind === "guardTrip"
      ? `${error.name}: ${cause.dimension} guard trip`
      : error.name;
  }
}

// 1. No invocation options: the leg runs under no budget and finishes.
const first = await main();
const unbudgeted = await answer(first.data);

// 2. A per-invocation time budget shorter than the sleep stops the leg. The
// fixture pins what stopped it by name, so an unrelated throw fails the test
// instead of passing as "not done".
const second = await main();
const stoppedBy = await answer(second.data, {
  invocation: { config: { budget: { maxTime: "50ms" } } },
});

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      interrupted: hasInterrupts(first.data) && hasInterrupts(second.data),
      unbudgeted,
      stoppedBy,
    },
    null,
    2,
  ),
);
