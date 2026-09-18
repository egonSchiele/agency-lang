import { afterInterrupt, forRewind, approve, respondToInterrupts, rewindFrom } from "./agent.js";
import { bumpCount, reset } from "./counter.js";
import { writeFileSync } from "fs";

// The default restore limit is 100. A loop that is not stopped never returns,
// so a missing limit shows up as this test timing out.
async function errorOf(run) {
  try {
    await run();
    return "no error";
  } catch (e) {
    return e.name + ": " + e.message;
  }
}

reset();
const first = await afterInterrupt();
const resumedLoop = await errorOf(() =>
  respondToInterrupts(first.data, first.data.map(() => approve())),
);
const resumedLoopBumps = bumpCount();

reset();
const { data: checkpoint } = await forRewind();
const rewoundLoop = await errorOf(() => rewindFrom(checkpoint, {}));
const rewoundLoopBumps = bumpCount();

writeFileSync(
  "__result.json",
  JSON.stringify({ resumedLoop, resumedLoopBumps, rewoundLoop, rewoundLoopBumps }, null, 2),
);
