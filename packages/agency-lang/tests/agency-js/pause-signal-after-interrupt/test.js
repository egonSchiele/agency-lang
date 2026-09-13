import { main, isPaused, hasInterrupts, approve, respondToInterrupts, resumeFromCheckpoint } from "./agent.js";
import { bumpCount, reset } from "./counter.js";
import { writeFileSync } from "fs";

// A cancel that lands before the run starts throws AgencyCancelledError; one
// that lands mid-run unwinds as an AgencyAbort with a userKill cause.
const CANCEL_ERRORS = ["AgencyCancelledError", "AgencyAbort"];

const PAUSE_AFTER_MS = 150; // fires inside the program's 400ms sleep

// Interrupt, then pause during the response leg.
reset();
const first = await main();
const interrupted = hasInterrupts(first.data);
const pause = new AbortController();
setTimeout(() => pause.abort(), PAUSE_AFTER_MS);
const second = interrupted
  ? await respondToInterrupts(first.data, first.data.map(() => approve()), { pauseSignal: pause.signal })
  : first;
const pausedInResponseLeg = isPaused(second.data);
const bumpsAtPause = bumpCount();
const final = pausedInResponseLeg ? await resumeFromCheckpoint(second.data) : second;

// Interrupt, then cancel during the response leg.
reset();
const again = await main();
const cancel = new AbortController();
setTimeout(() => cancel.abort(), PAUSE_AFTER_MS);
let cancelledInResponseLeg = false;
try {
  await respondToInterrupts(again.data, again.data.map(() => approve()), { abortSignal: cancel.signal });
} catch (e) {
  cancelledInResponseLeg = !!e && CANCEL_ERRORS.includes(e.name);
}

writeFileSync(
  "__result.json",
  JSON.stringify(
    { interrupted, pausedInResponseLeg, bumpsAtPause, final: final.data, cancelledInResponseLeg },
    null,
    2,
  ),
);
