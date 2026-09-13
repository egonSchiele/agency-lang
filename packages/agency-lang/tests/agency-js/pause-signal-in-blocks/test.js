import { main, isPaused, hasInterrupts, resumeFromCheckpoint } from "./agent.js";
import { writeFileSync } from "fs";

const PAUSE_AFTER_MS = 150; // fires inside each 400ms sleep

const p1 = new AbortController();
setTimeout(() => p1.abort(), PAUSE_AFTER_MS);
const first = await main({ pauseSignal: p1.signal });
const pausedInTry = isPaused(first.data);

const p2 = new AbortController();
setTimeout(() => p2.abort(), PAUSE_AFTER_MS);
const second = pausedInTry ? await resumeFromCheckpoint(first.data, { pauseSignal: p2.signal }) : first;
const pausedInHandle = isPaused(second.data);

const final = pausedInHandle ? await resumeFromCheckpoint(second.data) : second;

// If the `with approve` handler were not registered again on resume, the
// raise inside gated() would come back as an interrupt instead of a value.
writeFileSync(
  "__result.json",
  JSON.stringify(
    { pausedInTry, pausedInHandle, final: final.data, leakedInterrupt: hasInterrupts(final.data) },
    null,
    2,
  ),
);
