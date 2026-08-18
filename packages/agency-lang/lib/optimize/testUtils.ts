import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";
import type { Test } from "@/eval/runTypes.js";

/** Every directory fakeRun minted; tests call cleanupFakeRuns in afterEach so
 *  optimizer runs do not litter the system temp dir. */
const fakeRunDirs: string[] = [];

/** Raw rmSync, not safeDelete: mkdtemp paths sit outside any project root,
 *  which safeDelete refuses by design. */
export function cleanupFakeRuns(): void {
  for (const dir of fakeRunDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A run directory (one trace) backed by real artifacts on disk, because
 * grading reads the directory: a statelog with the trace, and the harness's
 * `run` row naming the test. Optimizer tests inject `runInput` seams that
 * return this directory. Registered for cleanupFakeRuns.
 */
export function fakeRun(inputId: string, output: unknown, spec?: Test): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimize-run-"));
  fakeRunDirs.push(root);
  const test: Test = { input: "", ...spec, id: inputId };
  return writeRunDirectory([{ test, output, traceId: `trace-${inputId}` }], root);
}
