// The second process: resumes the paused run from JSON on disk, so the
// run's held jobs can only have come from the checkpoint.
import { respondToInterrupts, approve } from "./agent.js";
import { readFileSync, writeFileSync } from "fs";

const record = process.argv[2];
const paused = JSON.parse(readFileSync("paused.json", "utf8"));
const before = JSON.parse(readFileSync("record-before.json", "utf8"));
const resumed = await respondToInterrupts(
  paused,
  paused.map(() => approve()),
);
const after = JSON.parse(readFileSync(record, "utf8"));
writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      ...resumed.data,
      stateWhilePaused: before.state,
      sameRunner: before.runnerPid === after.runnerPid,
      stateAtEnd: after.state,
    },
    null,
    2,
  ),
);
