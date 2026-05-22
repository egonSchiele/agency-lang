import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";

// Clean statelog so we count only THIS run's events.
if (existsSync("statelog.log")) unlinkSync("statelog.log");

const initial = await main();

if (!hasInterrupts(initial.data)) {
  throw new Error(
    `Expected interrupts on second LLM call; got: ${JSON.stringify(initial.data)}`,
  );
}

const final = await respondToInterrupts(initial.data, [approve()]);

// Count statelog.toolCall events across the whole run (first pass +
// resume). If pr.parallel re-executes a fully-completed branch on
// resume and the `statelogClient.toolCall(...)` call is OUTSIDE any
// b.step guard, this event is logged TWICE (regression). Gating it on
// a per-tool completion key (its own b.step) makes it exactly ONCE.
let toolCallEvents = 0;
const lines = readFileSync("statelog.log", "utf8").split("\n").filter(Boolean);
for (const line of lines) {
  const ev = JSON.parse(line);
  if (ev?.data?.type === "toolCall" && ev.data.toolName === "greet") {
    toolCallEvents++;
  }
}

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      data: final.data,
      toolCallEvents,
    },
    null,
    2,
  ),
);
