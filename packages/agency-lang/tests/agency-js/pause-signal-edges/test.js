import { main, isPaused, resumeFromCheckpoint } from "./agent.js";
import { bumpCount, reset } from "./counter.js";
import { writeFileSync } from "fs";

// A cancel that lands before the run starts throws AgencyCancelledError; one
// that lands mid-run unwinds as an AgencyAbort with a userKill cause.
const CANCEL_ERRORS = ["AgencyCancelledError", "AgencyAbort"];

const FIRE_AFTER_MS = 100; // fires inside the program's 300ms sleep

// 1. A signal already aborted before the call pauses at the first statement.
reset();
const early = new AbortController();
early.abort();
const r1 = await main({ pauseSignal: early.signal });
const pausedAtStart = isPaused(r1.data) && bumpCount() === 0;
const r1Done = pausedAtStart ? await resumeFromCheckpoint(r1.data) : r1;

// 2. Firing the signal after the call returned changes nothing.
reset();
const late = new AbortController();
const r2 = await main({ pauseSignal: late.signal });
late.abort();
const lateIgnored = !isPaused(r2.data);

// 3. Both signals fired during a sleep: cancel wins and the call throws.
reset();
const cancel = new AbortController();
const pause = new AbortController();
setTimeout(() => {
  pause.abort();
  cancel.abort();
}, FIRE_AFTER_MS);
let cancelWon = false;
try {
  await main({ pauseSignal: pause.signal, abortSignal: cancel.signal });
} catch (e) {
  cancelWon = !!e && CANCEL_ERRORS.includes(e.name);
}

// 4. A resumed run can be paused again.
reset();
const again = new AbortController();
again.abort();
const r4 = await main({ pauseSignal: again.signal });
const r4b = await resumeFromCheckpoint(r4.data, { pauseSignal: again.signal });
const pausedTwice = isPaused(r4b.data);

writeFileSync(
  "__result.json",
  JSON.stringify(
    { pausedAtStart, firstFinished: r1Done.data, lateIgnored, cancelWon, pausedTwice },
    null,
    2,
  ),
);
