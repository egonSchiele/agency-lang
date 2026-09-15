import { main, resumeFromCheckpoint } from "./agent.js";
import { bindCount, marksSeen } from "./recorder.js";
import { writeFileSync } from "fs";

const seen = [];
bindCount(() => seen.length);
const callbacks = { onCheckpoint: (event) => seen.push(event) };

const result = await main({ callbacks });
const marks = marksSeen();
const branches = marks.filter((m) => m.label === "branch").map((m) => m.count);
const after = marks.find((m) => m.label === "after").count;

// Every reported checkpoint resumes to the plain result.
let everyCheckpointResumes = true;
for (const event of seen) {
  const resumed = await resumeFromCheckpoint({
    type: "paused",
    checkpoint: event.checkpoint,
    runId: event.runId,
  });
  if (resumed.data !== 1) everyCheckpointResumes = false;
}

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      result: result.data,
      // A statement inside the fork body would report on the body's own scope.
      everyCheckpointOnMain: seen.every((event) => event.checkpoint.scopeName === "main"),
      // Both branches saw the same count, and the statement after the fork
      // added exactly one more: nothing fired while the branches ran.
      branchesSawSameCount: branches.every((c) => c === branches[0]),
      afterIsNextStatement: after === branches[0] + 1,
      everyCheckpointResumes,
    },
    null,
    2,
  ),
);
