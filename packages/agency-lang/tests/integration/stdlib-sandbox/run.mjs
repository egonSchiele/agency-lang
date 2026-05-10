// Runner for sandboxed stdlib tests. Only runs in CI (or when AGENCY_SANDBOX_TESTS=1).
// These tests exercise real side effects (filesystem, shell, network) in controlled
// environments, so they should not run on developer machines by default.

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..", "..", "..");

if (!process.env.CI && !process.env.AGENCY_SANDBOX_TESTS) {
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

// Agency tests (.agency + .test.json)
run("Stdlib sandbox (agency tests)",
  "node ./dist/scripts/agency.js test tests/integration/stdlib-sandbox/");

// Agency-JS tests (test.js + fixture.json)
run("Stdlib sandbox (agency-js tests)",
  "node ./dist/scripts/agency.js test js tests/integration/stdlib-sandbox-js/");
