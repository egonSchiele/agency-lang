import { resumeFromCheckpoint, isPaused } from "./agent.js";
import { readFileSync, writeFileSync } from "fs";

const paused = JSON.parse(readFileSync("paused.json", "utf8"));
const result = await resumeFromCheckpoint(paused);
writeFileSync(
  "fresh-result.json",
  JSON.stringify({ finished: result.data, pausedAgain: isPaused(result.data) }),
);
