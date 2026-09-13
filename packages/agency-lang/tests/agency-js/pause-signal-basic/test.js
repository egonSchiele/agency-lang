import { main, isPaused, hasInterrupts, resumeFromCheckpoint } from "./agent.js";
import { bumpCount } from "./counter.js";
import { writeFileSync, readFileSync, rmSync } from "fs";
import { execFileSync } from "child_process";

const PAUSE_AFTER_MS = 200; // fires inside the program's 400ms sleep

rmSync("paused.json", { force: true });
rmSync("fresh-result.json", { force: true });

const pause = new AbortController();
setTimeout(() => pause.abort(), PAUSE_AFTER_MS);
const first = await main({ pauseSignal: pause.signal });
const pausedFirst = isPaused(first.data);
const bumpsAtPause = bumpCount();

// Resume in this process.
const resumed = pausedFirst ? await resumeFromCheckpoint(first.data) : first;

// Resume the same paused value in a fresh process, from JSON on disk.
writeFileSync("paused.json", JSON.stringify(first.data));
execFileSync(process.execPath, ["./resume-stage.js"], { stdio: "inherit" });
const fresh = JSON.parse(readFileSync("fresh-result.json", "utf8"));

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      pausedFirst,
      bumpsAtPause,
      sameProcess: { finished: resumed.data, interrupted: hasInterrupts(resumed.data) },
      freshProcess: fresh,
    },
    null,
    2,
  ),
);
rmSync("paused.json", { force: true });
rmSync("fresh-result.json", { force: true });
