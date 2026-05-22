import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

// Two top-level callbacks on the same hook each interrupt on first fire.
// `callHook` collects interrupts across all listeners; PromptRunner.step
// sees the merged array and stamps ONE shared checkpoint, then bails
// with both interrupts. The JS caller sees both in `result.data` and
// approves them together. On resume the step body re-runs, both
// callbacks fire again (counts -> 2 each), no interrupts, LLM resolves.
const initial = await main();

if (!hasInterrupts(initial.data)) {
  throw new Error(
    `Expected interrupts; got: ${JSON.stringify(initial.data)}`,
  );
}

const interrupts = initial.data;
if (interrupts.length !== 2) {
  throw new Error(
    `Expected 2 interrupts (one per callback), got ${interrupts.length}`,
  );
}

// Both interrupts must share the same checkpoint — they were collected
// in one callHook invocation and a single checkpoint is stamped per
// pr.step bailout.
const cpIds = interrupts.map((i) => i.checkpointId);
if (!cpIds.every((id) => id === cpIds[0])) {
  throw new Error(
    `Expected shared checkpoint, got: ${JSON.stringify(cpIds)}`,
  );
}

const kinds = interrupts.map((i) => i.kind).sort();
if (JSON.stringify(kinds) !== JSON.stringify(["myapp::pauseA", "myapp::pauseB"])) {
  throw new Error(`Unexpected kinds: ${JSON.stringify(kinds)}`);
}

const final = await respondToInterrupts(
  interrupts,
  interrupts.map(() => approve()),
);

writeFileSync(
  "__result.json",
  JSON.stringify({ data: final.data }, null, 2),
);
