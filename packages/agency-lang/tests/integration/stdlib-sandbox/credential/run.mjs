// Runner for credential-based stdlib tests. Only runs in CI with secrets available.

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..", "..", "..", "..");

if (!process.env.CI) {
  console.log("Skipping credential stdlib tests (only runs in CI)");
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

const tests = ["email", "sms", "browser"];

for (const name of tests) {
  run(`Credential test: ${name}`,
    `node ./dist/scripts/agency.js test tests/integration/stdlib-sandbox/credential/${name}.agency`);
}
