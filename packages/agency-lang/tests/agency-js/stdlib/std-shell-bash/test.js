import { mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runBash } from "./agent.js";

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "agency-bash-")));

async function run(cmd, cwd = "", stdin = "") {
  const r = await runBash(cmd, cwd, stdin);
  return r.data;
}

// --- Case 1: stdout capture ---
const stdoutCase = await run("echo hello");

// --- Case 2: non-zero exit code ---
const exitCase = await run("exit 3");

// --- Case 3: cwd override ---
// pwd -P prints the physical (symlink-resolved) path, matching what mkdtempSync
// returns on macOS (where /tmp is a symlink to /private/tmp).
const cwdCase = await run("pwd -P", TMP);

// --- Case 4: stdin piping ---
const stdinCase = await run("cat", "", "piped-input");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      stdout: { stdout: stdoutCase.stdout, exitCode: stdoutCase.exitCode },
      exit: { exitCode: exitCase.exitCode, stdout: exitCase.stdout },
      cwd: { matches: cwdCase.stdout.trim() === TMP, exitCode: cwdCase.exitCode },
      stdin: { stdout: stdinCase.stdout, exitCode: stdinCase.exitCode },
    },
    null,
    2,
  ),
);
