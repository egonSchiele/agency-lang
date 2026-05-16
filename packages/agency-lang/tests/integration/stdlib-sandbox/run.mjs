// Runner for sandboxed stdlib tests. Only runs in CI (or when AGENCY_SANDBOX_TESTS=1).
// These tests exercise real side effects (filesystem, shell, network) in controlled
// environments, so they should not run on developer machines by default.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, runAllowFail } from "./testRunner.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

if (!process.env.CI && process.env.AGENCY_SANDBOX_TESTS !== "1") {
  console.log("Skipping stdlib sandbox tests (set CI=true or AGENCY_SANDBOX_TESTS=1 to run)");
  process.exit(0);
}

// Agency tests (.agency + .test.json) — run each file individually so one failure
// doesn't block the rest, and we can allow specific tests to fail (e.g. wikipedia).
const agencyTests = [
  "fs", "shell", "pure", "date", "policy", "ui", "strategy",
];

for (const name of agencyTests) {
  run(rootDir, `Stdlib sandbox: ${name}`,
    `node ./dist/scripts/agency.js test tests/integration/stdlib-sandbox/${name}.agency`);
}

// Live APIs — allow to fail without blocking CI
runAllowFail(rootDir, "Stdlib sandbox: wikipedia",
  "node ./dist/scripts/agency.js test tests/integration/stdlib-sandbox/wikipedia.agency");
runAllowFail(rootDir, "Stdlib sandbox: weather",
  "node ./dist/scripts/agency.js test tests/integration/stdlib-sandbox/weather.agency");

// Agency-JS tests (test.js + fixture.json)
run(rootDir, "Stdlib sandbox (agency-js tests)",
  "node ./dist/scripts/agency.js test js tests/integration/stdlib-sandbox-js/");
