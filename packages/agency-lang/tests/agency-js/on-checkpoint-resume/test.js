import {
  main,
  hasInterrupts,
  isPaused,
  approve,
  respondToInterrupts,
  resumeFromCheckpoint,
} from "./agent.js";
import { bumpCount, reset } from "./counter.js";
import { writeFileSync } from "fs";

const seen = [];
const callbacks = {
  onCheckpoint: ({ runId, checkpoint }) => {
    seen.push({ runId, json: JSON.stringify(checkpoint), bumpsBefore: bumpCount() });
  },
};

// 1. Fresh leg: two bumps, then the gate. Every statement reported a checkpoint.
reset();
const first = await main({ callbacks });
const interrupted = hasInterrupts(first.data);
const runId = interrupted ? first.data[0].runId : null;
const freshCount = seen.length;
const everyRunIdMatches = seen.every((event) => event.runId === runId);
const everyCheckpointResumable = seen.every((event) =>
  isPaused({ type: "paused", checkpoint: JSON.parse(event.json), runId: event.runId }),
);

// 2. The process is gone. The host has the checkpoint it stored before the
//    second bump. Resuming there runs the second bump again and reaches the gate.
const stored = [...seen].reverse().find((event) => event.bumpsBefore === 1);
const resumed = await resumeFromCheckpoint(
  { type: "paused", checkpoint: JSON.parse(stored.json), runId: stored.runId },
  { metadata: { callbacks } },
);
const resumedInterrupted = hasInterrupts(resumed.data);
const bumpsAfterResume = bumpCount();
const resumeLegReported = seen.length > freshCount;
const afterResumeCount = seen.length;

// 3. Answer the gate. The last bump runs and the node returns the count.
const final = await respondToInterrupts(resumed.data, resumed.data.map(() => approve()), {
  metadata: { callbacks },
});
const answerLegReported = seen.length > afterResumeCount;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      interrupted,
      freshReported: freshCount > 0,
      everyRunIdMatches,
      everyCheckpointResumable,
      resumedInterrupted,
      bumpsAfterResume,
      resumeLegReported,
      final: final.data,
      answerLegReported,
    },
    null,
    2,
  ),
);
