import { main, isPaused, resumeFromCheckpoint } from "./agent.js";
import { bumpCount } from "./counter.js";
import { writeFileSync } from "fs";

const PAUSE_AFTER_MS = 150; // fires inside the tool's 400ms sleep

// A pause requested during a tool call waits until the tool loop finishes,
// then lands on the next statement of the node. The tool runs once and its
// result reaches the model's second turn.
const pause = new AbortController();
setTimeout(() => pause.abort(), PAUSE_AFTER_MS);
const first = await main({ pauseSignal: pause.signal });
const paused = isPaused(first.data);
const resumed = paused ? await resumeFromCheckpoint(first.data) : first;
writeFileSync(
  "__result.json",
  JSON.stringify({ paused, final: resumed.data, toolRuns: bumpCount() }, null, 2),
);
