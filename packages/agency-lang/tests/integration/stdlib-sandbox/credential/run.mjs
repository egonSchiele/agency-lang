// Runner for credential-based stdlib tests.
// Only runs in CI — credentials are not available locally.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../testRunner.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

if (!process.env.CI) {
  console.log("Skipping credential stdlib tests (only runs in CI)");
  process.exit(0);
}

const tests = ["email", "sms", "browser"];

for (const name of tests) {
  run(rootDir, `Credential test: ${name}`,
    `node ./dist/scripts/agency.js test tests/integration/stdlib-sandbox/credential/${name}.agency`);
}
