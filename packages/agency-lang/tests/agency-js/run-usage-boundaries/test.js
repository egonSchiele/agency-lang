import {
  main,
  hasInterrupts,
  approve,
  respondToInterrupts,
  resumeFromCheckpoint,
} from "./agent.js";
import { writeFileSync } from "fs";

// Every public entry point returns what the run has spent since it began as
// `usage`, under the same `traceId`, and nothing else on the result reports
// spend. A resumed leg's figure includes what the run spent before it paused.
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

// 1. runNode: one call before the gate.
const first = await main({ callbacks });

// 2. resumeFromCheckpoint: from the last checkpoint before the pause. It makes
//    no call of its own, so it reports the one call the checkpoint carried.
const stored = seen[seen.length - 1];
const resumed = await resumeFromCheckpoint(
  { type: "paused", checkpoint: JSON.parse(stored.json), runId: stored.runId },
  { metadata: { callbacks } },
);

// 3. respondToInterrupts: one more call after the gate, two in total.
const final = await respondToInterrupts(first.data, first.data.map(() => approve()), {
  metadata: { callbacks },
});

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      interrupted: hasInterrupts(first.data),
      sameTraceId: first.traceId === resumed.traceId && first.traceId === final.traceId,
      runNode: report(first),
      resumeFromCheckpoint: report(resumed),
      respondToInterrupts: report(final),
    },
    null,
    2,
  ),
);
