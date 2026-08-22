// --agency-only on `agency test` and `agency run`: a closure that is not pure
// Agency is refused, as a file failure in the test runner (the suite goes on
// and the exit code is 1) and as exit 1 in run. Positive controls first.
import { execFileSync } from "child_process";
import { existsSync, rmSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../../../dist/scripts/agency.js");
// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

function agency(args) {
  try {
    const out = execFileSync(process.execPath, [cli, ...args], { cwd: here, stdio: "pipe" });
    return { exitCode: 0, output: stripAnsi(out.toString()) };
  } catch (e) {
    return { exitCode: e.status ?? 1, output: stripAnsi(`${e.stdout ?? ""}${e.stderr ?? ""}`) };
  }
}

const testControl = agency(["test", "run", "bad.test.json"]);
const testRestricted = agency(["test", "run", "--agency-only", "good.test.json", "bad.test.json"]);

const runControl = agency(["run", "bad.agency"]);
const runRestricted = agency(["run", "--agency-only", "bad.agency"]);

rmSync(resolve(here, "y.txt"), { force: true });
const writeControl = agency(["run", "writes.agency"]);
const writeControlFile = existsSync(resolve(here, "y.txt"));
rmSync(resolve(here, "y.txt"), { force: true });
const writeRestricted = agency(["run", "--agency-only", "--reject", "*", "writes.agency"]);
const writeRestrictedFile = existsSync(resolve(here, "y.txt"));
rmSync(resolve(here, "y.txt"), { force: true });

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      testControl: { exitCode: testControl.exitCode },
      testRestricted: {
        exitCode: testRestricted.exitCode,
        refused: testRestricted.output.includes("not Agency source"),
        // The good file still ran and reported: no process.exit on the refusal.
        goodReported: testRestricted.output.includes("1/1 tests passed"),
      },
      runControl: { exitCode: runControl.exitCode },
      runRestricted: {
        exitCode: runRestricted.exitCode,
        refused: runRestricted.output.includes("not Agency source"),
      },
      writeControl: { exitCode: writeControl.exitCode, fileWritten: writeControlFile },
      writeRestricted: { exitCode: writeRestricted.exitCode, fileWritten: writeRestrictedFile },
    },
    null,
    2,
  ),
);
