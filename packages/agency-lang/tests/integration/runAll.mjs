// Runs the integration scripts CI runs, in groups that run at the same time.
// The scripts in one group run one after another.
//
// The tarball scripts each install the packed tarball into their own temp
// project, so they share nothing and are spread over three groups. The repo
// scripts compile .agency files inside this package's own folder, so they stay
// together in one group and never run at the same time as each other.
//
// Each script's output is held until it finishes and then printed as one
// block, so the log reads the same as a serial run. A `started` line is
// printed as each one begins. The run fails if any script fails or runs past
// its time limit, and a script that runs past it is killed along with every
// process it started.
//
// Usage, from packages/agency-lang after `make` and `npm pack`:
//
//   node tests/integration/runAll.mjs ./agency-lang-*.tgz

import { spawn } from "node:child_process";

// The `integration` job's timeout-minutes in .github/workflows/test.yml, less
// about 3 minutes for checkout, install, `make ci`, and `npm pack`. Every
// group's limits must add up to less than this, so a hung script is stopped
// here and its output printed before GitHub cancels the job and the held
// output is lost.
const RUNNER_BUDGET_MINUTES = 22;

const tarball = process.argv[2];
if (!tarball) {
  console.error("usage: node tests/integration/runAll.mjs <tarball>");
  process.exit(2);
}

// The longest group first: tests/integration/cli takes about 3.5 minutes on
// a CI runner, which is about as long as any other group takes in total.
// Each limit is several times the script's usual CI time. stdlib-sandbox gets
// 10 because its live-API cases may each wait up to 5 minutes.
const GROUPS = [
  [{ script: "tests/integration/cli/test.mjs", args: [tarball], timeoutMinutes: 10 }],
  [
    { script: "tests/integration/cli-lang/test.mjs", args: [tarball], timeoutMinutes: 3 },
    { script: "tests/integration/cli-tier2/test.mjs", args: [tarball], timeoutMinutes: 3 },
    { script: "tests/integration/serve/test.mjs", args: [tarball], timeoutMinutes: 3 },
  ],
  [
    { script: "tests/integration/smoke/test.mjs", args: [tarball], timeoutMinutes: 3 },
    { script: "tests/integration/bundlers/test-esbuild.mjs", args: [tarball], timeoutMinutes: 3 },
    { script: "tests/integration/bundlers/test-vite.mjs", args: [tarball], timeoutMinutes: 3 },
  ],
  [
    { script: "tests/integration/statelog/test.mjs", args: [], timeoutMinutes: 3 },
    { script: "tests/integration/eval-run/test.mjs", args: [], timeoutMinutes: 5 },
    { script: "tests/integration/stdlib-sandbox/run.mjs", args: [], timeoutMinutes: 10 },
  ],
];

for (const group of GROUPS) {
  const total = group.reduce((sum, entry) => sum + entry.timeoutMinutes, 0);
  if (total > RUNNER_BUDGET_MINUTES) {
    const scripts = group.map((entry) => entry.script).join(", ");
    console.error(
      `The limits for ${scripts} add up to ${total} min, over the ${RUNNER_BUDGET_MINUTES} min budget.`,
    );
    process.exit(2);
  }
}

// How long to keep reading a script's output after it exits. A process the
// script started can hold the pipe open, so the runner never waits on the
// pipe itself to close.
const OUTPUT_GRACE_MS = 5_000;

// Kills the script and every process it started. Each script runs as the
// leader of its own process group, and a negative pid names the group.
function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    // ESRCH means the group has already exited, which is the usual case.
    if (error.code !== "ESRCH") {
      console.error(`Could not stop process group ${pid}: ${error.message}`);
    }
  }
}

function verdictFor(exit, timedOut, timeoutMinutes) {
  if (timedOut) {
    return `TIMED OUT after ${timeoutMinutes} min`;
  } else if (exit.code === 0) {
    return "passed";
  } else {
    return `FAILED (exit ${exit.code ?? exit.signal})`;
  }
}

function runScript({ script, args, timeoutMinutes }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const output = [];
    // Printed at once, so a job that GitHub cancels still shows which
    // scripts were running; the held output is lost in that case.
    console.log(`started ${script}`);
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMinutes * 60_000);

    let exit = null;
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      // Whatever the script left running would otherwise hold the pipe open
      // and keep running into the next script's turn.
      killGroup(child.pid);
      const seconds = Math.round((Date.now() - started) / 1000);
      const verdict = verdictFor(exit, timedOut, timeoutMinutes);
      console.log(`\n=== ${script}: ${verdict} in ${seconds}s ===`);
      process.stdout.write(Buffer.concat(output));
      resolve(exit.code === 0 && !timedOut);
    };
    const recordExit = (code, signal) => {
      clearTimeout(timer);
      exit ??= { code, signal };
    };
    child.on("exit", (code, signal) => {
      recordExit(code, signal);
      setTimeout(finish, OUTPUT_GRACE_MS);
    });
    child.on("close", (code, signal) => {
      recordExit(code, signal);
      finish();
    });
  });
}

async function runGroup(group) {
  let allPassed = true;
  for (const entry of group) {
    const passed = await runScript(entry);
    if (!passed) {
      allPassed = false;
    }
  }
  return allPassed;
}

const results = await Promise.all(GROUPS.map(runGroup));
if (results.includes(false)) {
  console.error("\nSome integration scripts failed; see the blocks above.");
  process.exit(1);
}
console.log("\nAll integration scripts passed.");
