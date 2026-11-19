import { main, hasInterrupts } from "./agent.js";
import { readFileSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";

const PAUSED_FILE = "paused.json";
const BEFORE_FILE = "record-before.json";

rmSync(PAUSED_FILE, { force: true });
rmSync(BEFORE_FILE, { force: true });

const first = await main();
if (!hasInterrupts(first.data)) {
  writeFileSync(
    "__result.json",
    JSON.stringify({ error: `expected a pause, got ${JSON.stringify(first.data)}` }),
  );
  process.exit(0);
}

// The run has returned to this caller. Its job must still be running.
const id = first.data[0].data.id;
const record = join(process.env.AGENCY_HOME, "jobs", id, "record.json");
writeFileSync(BEFORE_FILE, readFileSync(record, "utf8"));
writeFileSync(PAUSED_FILE, JSON.stringify(first.data));
execFileSync(process.execPath, ["./resume-stage.js", record], { stdio: "inherit" });
rmSync(PAUSED_FILE, { force: true });
rmSync(BEFORE_FILE, { force: true });
