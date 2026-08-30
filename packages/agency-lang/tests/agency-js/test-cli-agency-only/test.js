// --agency-only on `agency test` and `agency run`: a closure that is not pure
// Agency is refused, as a file failure in the test runner (the suite goes on
// and the exit code is 1) and as exit 1 in run. Positive controls first.
import { spawnSync } from "child_process";
import { existsSync, rmSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../../../dist/scripts/agency.js");
// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

// spawnSync (not execFileSync) so both streams and the exit code come back
// even when the child exits 0: codegen-walk.agency logs its EvalError to
// stderr and exits 0, so a stdout-only capture would miss it.
function agency(args) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: here, encoding: "utf8" });
  return { exitCode: r.status ?? 1, output: stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`) };
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

// Bound names under --agency-only (SANDBOX_JS_GLOBALS). Each refused fixture
// references a capability but performs no destructive action, so a regression
// that let one compile still could not do harm when only the exit code is
// asserted (anti-patterns.md: no catastrophic-on-failure tests).
const boundRefused = ["bound-globals", "bound-new", "bound-ctor", "bound-tag", "bound-default"].map(
  (name) => {
    const r = agency(["run", "--agency-only", "--reject", "*", `${name}.agency`]);
    return { name, exitCode: r.exitCode, refused: r.output.includes("compile refused") };
  },
);
const boundGood = agency(["run", "--agency-only", "bound-good.agency"]);

// Layer 2: --agency-only runs the child Node process with
// --disallow-code-generation-from-strings. codegen-walk.agency reaches
// Function through a runtime-computed key, which layer 1 cannot see, so it
// COMPILES; the flag makes the call throw EvalError at runtime. This is the
// one check that fails if the flag falls off the spawn args: without it the
// Function call succeeds and no EvalError is printed.
const codegenWalk = agency(["run", "--agency-only", "--reject", "*", "codegen-walk.agency"]);

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
      boundRefused,
      boundGood: { exitCode: boundGood.exitCode },
      codegenWalk: {
        compiled: !codegenWalk.output.includes("compile refused"),
        blocked: codegenWalk.output.includes("EvalError"),
      },
    },
    null,
    2,
  ),
);
