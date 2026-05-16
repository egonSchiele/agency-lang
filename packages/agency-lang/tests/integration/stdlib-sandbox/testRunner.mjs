// Shared test runner utilities for sandbox and credential tests.

import { execSync } from "node:child_process";

export function run(rootDir, label, command) {
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

export function runAllowFail(rootDir, label, command) {
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
