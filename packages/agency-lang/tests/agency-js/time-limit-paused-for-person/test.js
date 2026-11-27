import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

// A whole-run time limit of 1 second, as `--max-time 1s` sets it. The program
// does almost no work, and the person takes 1.5 seconds to answer. Waiting on
// a person must not count, so the run finishes instead of tripping.
process.env.AGENCY_MAX_TIME = "1000";

async function outcome(run) {
  try {
    const result = await run();
    return hasInterrupts(result.data) ? "interrupted" : result.data;
  } catch (error) {
    const cause = error.agencyCause;
    return cause && cause.kind === "guardTrip" ? `${cause.dimension} guard trip` : error.name;
  }
}

const first = await main();
const interrupted = hasInterrupts(first.data);

await new Promise((resolve) => setTimeout(resolve, 1500));

const finished = await outcome(() => respondToInterrupts(first.data, [approve()]));

delete process.env.AGENCY_MAX_TIME;

writeFileSync("__result.json", JSON.stringify({ interrupted, finished }, null, 2));
