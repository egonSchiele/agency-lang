import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const first = await main();
if (!hasInterrupts(first.data)) {
  writeFileSync(
    "__result.json",
    JSON.stringify({ error: `expected a pause, got ${JSON.stringify(first.data)}` }),
  );
  process.exit(0);
}

// `main` has returned to this caller. Its job must still be running.
const id = first.data[0].data.id;
const record = join(process.env.AGENCY_HOME, "jobs", id, "record.json");
const whilePaused = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")).state : "no record";
const resumed = await respondToInterrupts(first.data, [approve()]);

writeFileSync(
  "__result.json",
  JSON.stringify({ whilePaused, afterResume: resumed.data }, null, 2),
);
