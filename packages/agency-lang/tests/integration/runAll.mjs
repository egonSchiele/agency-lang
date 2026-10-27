// Runs the integration scripts CI runs, in groups that run at the same time.
// The scripts in one group run one after another.
//
// The tarball scripts each install the packed tarball into their own temp
// project, so they share nothing and are spread over three groups. The repo
// scripts compile .agency files inside this package's own folder, so they stay
// together in one group and never run at the same time as each other.
//
// Each script's output is held until it finishes and then printed as one
// block, so the log reads the same as a serial run. The run fails if any
// script fails or runs past its time limit.
//
// Usage, from packages/agency-lang after `make` and `npm pack`:
//
//   node tests/integration/runAll.mjs ./agency-lang-*.tgz

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MINUTES = 10;

const tarball = process.argv[2];
if (!tarball) {
  console.error("usage: node tests/integration/runAll.mjs <tarball>");
  process.exit(2);
}

// The longest group first: tests/integration/cli takes about 3.5 minutes on
// a CI runner, which is about as long as any other group takes in total.
const GROUPS = [
  [{ script: "tests/integration/cli/test.mjs", args: [tarball] }],
  [
    { script: "tests/integration/cli-lang/test.mjs", args: [tarball] },
    { script: "tests/integration/cli-tier2/test.mjs", args: [tarball] },
    { script: "tests/integration/serve/test.mjs", args: [tarball] },
  ],
  [
    { script: "tests/integration/smoke/test.mjs", args: [tarball] },
    { script: "tests/integration/bundlers/test-esbuild.mjs", args: [tarball] },
    { script: "tests/integration/bundlers/test-vite.mjs", args: [tarball] },
  ],
  [
    { script: "tests/integration/statelog/test.mjs", args: [] },
    { script: "tests/integration/eval-run/test.mjs", args: [], timeoutMinutes: 5 },
    { script: "tests/integration/stdlib-sandbox/run.mjs", args: [] },
  ],
];

function runScript({ script, args, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const output = [];
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMinutes * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const seconds = Math.round((Date.now() - started) / 1000);
      const passed = code === 0 && !timedOut;
      const verdict = timedOut ? `TIMED OUT after ${timeoutMinutes} min` : passed ? "passed" : `FAILED (exit ${code})`;
      console.log(`\n=== ${script}: ${verdict} in ${seconds}s ===`);
      process.stdout.write(Buffer.concat(output));
      resolve(passed);
    });
  });
}

async function runGroup(group) {
  let allPassed = true;
  for (const entry of group) {
    if (!(await runScript(entry))) allPassed = false;
  }
  return allPassed;
}

const results = await Promise.all(GROUPS.map(runGroup));
if (results.includes(false)) {
  console.error("\nSome integration scripts failed; see the blocks above.");
  process.exit(1);
}
console.log("\nAll integration scripts passed.");
