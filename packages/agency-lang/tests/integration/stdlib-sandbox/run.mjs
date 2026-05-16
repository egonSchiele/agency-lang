// Runner for sandboxed stdlib tests. Only runs in CI (or when AGENCY_SANDBOX_TESTS=1).
// These tests exercise real side effects (filesystem, shell, network) in controlled
// environments, so they should not run on developer machines by default.

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..", "..", "..");

if (!process.env.CI && process.env.AGENCY_SANDBOX_TESTS !== "1") {
  console.log("Skipping stdlib sandbox tests (set CI=true or AGENCY_SANDBOX_TESTS=1 to run)");
  process.exit(0);
}

function run(label, command) {
  console.log(`\n=== ${label} ===`);
  try {
    execSync(command, {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: "inherit",
      timeout: 300_000,
    });
    console.log(`${label}: PASSED`);
  } catch {
    console.error(`${label}: FAILED`);
    process.exit(1);
  }
}

function runAllowFail(label, command) {
  console.log(`\n=== ${label} (allow fail) ===`);
  try {
    execSync(command, {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: "inherit",
      timeout: 300_000,
    });
    console.log(`${label}: PASSED`);
  } catch {
    console.error(`${label}: FAILED (allowed)`);
  }
}

// Agency tests (.agency + .test.json) — run each file individually so one failure
// doesn't block the rest, and we can allow specific tests to fail (e.g. wikipedia).
const agencyTests = [
  "fs", "shell", "pure", "date", "policy", "ui", "strategy",
];

for (const name of agencyTests) {
  run(`Stdlib sandbox: ${name}`,
    `node ./dist/scripts/agency.js test tests/integration/stdlib-sandbox/${name}.agency`);
}

// Live APIs — allow to fail without blocking CI
runAllowFail("Stdlib sandbox: wikipedia",
  "node ./dist/scripts/agency.js test tests/integration/stdlib-sandbox/wikipedia.agency");
runAllowFail("Stdlib sandbox: weather",
  "node ./dist/scripts/agency.js test tests/integration/stdlib-sandbox/weather.agency");

// Agency-JS tests (test.js + fixture.json)
run("Stdlib sandbox (agency-js tests)",
  "node ./dist/scripts/agency.js test js tests/integration/stdlib-sandbox-js/");
