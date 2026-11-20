// Types one line into a REPL whose token counts and watched job come from
// outside its run, then waits for the job to end, and reads what it printed.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const JOB_ENDS_WITHIN_MS = 4000;

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

const child = spawn(process.execPath, ["./stage.js"], { stdio: ["pipe", "pipe", "inherit"] });
const exited = new Promise((resolve) => child.on("exit", resolve));
let printed = "";
child.stdout.on("data", (chunk) => {
  printed += chunk.toString();
});
child.stdin.write("hi\n");
await new Promise((resolve) => setTimeout(resolve, JOB_ENDS_WITHIN_MS));
child.stdin.end();
await exited;

const shown = stripAnsi(printed);
writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      replied: shown.includes("said: hi"),
      footerCounts: /↑120 ↓30/.test(shown),
      jobLine: /job-[0-9a-f]{6} finished after .*\(exit 0\): nap/.test(shown),
    },
    null,
    2,
  ),
);
