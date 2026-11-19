import { execFileSync, spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

// Long enough for node to start and load the program, far shorter than the
// job's thirty seconds.
const EXIT_WITHIN_MS = 15_000;
const CLI = resolve("../../../dist/scripts/agency.js");

const child = spawn(process.execPath, ["./program.js"], { stdio: ["ignore", "pipe", "inherit"] });
let printed = "";
child.stdout.on("data", (chunk) => {
  printed += chunk;
});
const exited = await new Promise((done) => {
  const timer = setTimeout(() => done(false), EXIT_WITHIN_MS);
  child.on("exit", () => {
    clearTimeout(timer);
    done(true);
  });
});
if (!exited) {
  child.kill("SIGKILL");
}

const id = printed.trim();
const record = join(process.env.AGENCY_HOME, "jobs", id, "record.json");
const stateAfterExit = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")).state : "no record";
let stopped = "not stopped";
if (stateAfterExit === "running") {
  stopped = execFileSync(process.execPath, [CLI, "jobs", "stop", id], { encoding: "utf8" }).trim();
}

writeFileSync(
  "__result.json",
  JSON.stringify(
    { exited, stateAfterExit, stopped: stopped.replace(id, "<id>") },
    null,
    2,
  ),
);
