// `agency test --reject '*'` installs the runner's policy as the outermost
// handler of every case, so a tested node's own `with approve` loses.
// Positive control first: the same file, no policy, writes the file.
import { execFileSync } from "child_process";
import { existsSync, rmSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../../../dist/scripts/agency.js");

// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

function runTest(extraFlags) {
  rmSync(resolve(here, "x.txt"), { force: true });
  let output = "";
  let exitCode = 0;
  try {
    output = execFileSync(
      process.execPath,
      [cli, "test", "run", ...extraFlags, "writer.test.json"],
      {
        cwd: here,
        stdio: "pipe",
        env: { ...process.env, AGENCY_RUN_POLICY: "" },
      },
    ).toString();
  } catch (e) {
    exitCode = e.status ?? 1;
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const fileWritten = existsSync(resolve(here, "x.txt"));
  rmSync(resolve(here, "x.txt"), { force: true });
  return { exitCode, fileWritten, output };
}

const control = runTest([]);
const restricted = runTest(["--reject", "*"]);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      control: { exitCode: control.exitCode, fileWritten: control.fileWritten },
      restricted: {
        exitCode: restricted.exitCode,
        fileWritten: restricted.fileWritten,
        // The case fails because the node returned "rejected", not "written".
        // The runner colorizes its diff per character, so strip ANSI first.
        mentionsRejected: stripAnsi(restricted.output).includes("rejected"),
      },
    },
    null,
    2,
  ),
);
