// Types one line into a REPL whose token counts and watched job come from
// outside its run, then waits for the job to end, and reads what it printed.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

// The job's line normally shows within a few seconds, but a busy CI machine
// can take longer to start the REPL. Stdin closes as soon as the line shows,
// or at this limit, so a line that never comes still fails the test.
const JOB_LINE_WITHIN_MS = 20000;
const JOB_LINE = /job-[0-9a-f]{6} finished after .*\(exit 0\): nap/;

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

const child = spawn(process.execPath, ["./stage.js"], { stdio: ["pipe", "pipe", "inherit"] });
const exited = new Promise((resolve) => child.on("exit", resolve));
let printed = "";
let sawJobLine;
const jobLineShown = new Promise((resolve) => {
  sawJobLine = resolve;
});
child.stdout.on("data", (chunk) => {
  printed += chunk.toString();
  if (JOB_LINE.test(stripAnsi(printed))) {
    sawJobLine();
  }
});
child.stdin.write("hi\n");
const limit = setTimeout(sawJobLine, JOB_LINE_WITHIN_MS);
await jobLineShown;
clearTimeout(limit);
child.stdin.end();
await exited;

const shown = stripAnsi(printed);
writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      replied: shown.includes("said: hi"),
      footerCounts: /↑120 ↓30/.test(shown),
      jobLine: JOB_LINE.test(shown),
    },
    null,
    2,
  ),
);
