import {
  main,
  hasInterrupts,
  approve,
  respondToInterrupts,
  resumeFromCheckpoint,
} from "./agent.js";
import { writeFileSync } from "fs";

// Every public entry point returns the run's spend as `usage`, and nothing
// else on the result reports spend.
const seen = [];
const callbacks = {
  onCheckpoint: ({ runId, checkpoint }) => {
    seen.push({ runId, json: JSON.stringify(checkpoint) });
  },
};

function report(result) {
  return {
    hasTokensField: "tokens" in result,
    complete: result.usage.complete,
    unpricedCallCount: result.usage.unpricedCallCount,
    totalTokens: result.usage.tokens.totalTokens,
    entries: result.usage.entries.map((entry) => `${entry.kind}:${entry.model}`),
  };
}

// 1. runNode: the leg up to the gate made one call.
const first = await main({ callbacks });

// 2. resumeFromCheckpoint: from the run's first checkpoint, which replays the
//    call before the gate on a fresh meter.
const stored = seen[0];
const resumed = await resumeFromCheckpoint(
  { type: "paused", checkpoint: JSON.parse(stored.json), runId: stored.runId },
  { metadata: { callbacks } },
);

// 3. respondToInterrupts: the leg after the gate made one call of its own.
const final = await respondToInterrupts(first.data, first.data.map(() => approve()), {
  metadata: { callbacks },
});

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      interrupted: hasInterrupts(first.data),
      runNode: report(first),
      resumeFromCheckpoint: report(resumed),
      respondToInterrupts: report(final),
    },
    null,
    2,
  ),
);
