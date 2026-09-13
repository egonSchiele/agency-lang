import { main, isPaused, resumeFromCheckpoint } from "./agent.js";
import { bumpCount } from "./counter.js";
import { writeFileSync } from "fs";

const PAUSE_AFTER_MS = 150; // fires inside the callback's 400ms sleep

const pause = new AbortController();
setTimeout(() => pause.abort(), PAUSE_AFTER_MS);
const first = await main({ pauseSignal: pause.signal });
const paused = isPaused(first.data);
const bumpsAtPause = bumpCount();
const resumed = paused ? await resumeFromCheckpoint(first.data) : first;
writeFileSync(
  "__result.json",
  JSON.stringify({ paused, bumpsAtPause, final: resumed.data }, null, 2),
);
