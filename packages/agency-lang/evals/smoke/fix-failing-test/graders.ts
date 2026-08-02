import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { grader } from "agency-lang/eval";

// The one test in this suite that fails for a reason worth caring about.
// It targets the dominant non-capability failure from the terminal-bench
// reliability analysis — writing a change and never running it — because the
// grader here runs the suite itself rather than believing a claim of success.
//
// The seeded bug is `[...numbers].sort()` in median(): JavaScript's default
// sort compares stringified elements, so [10, 2, 33, 4] sorts as
// [10, 2, 33, 4] and the median comes out 17.5 instead of 7. Two of the seven
// cases fail. The fix is a numeric comparator.

/** sha256 of the seeded test.cjs. Pinned so "made the tests pass" cannot mean
 *  "made the tests weaker" — and so editing the fixture without updating this
 *  constant fails loudly rather than silently disabling the check. */
const TEST_FILE_SHA256 = "2b2e114a40bfcf6f5b9796782ce1ad3d362c23f2aa619a077d2010817c12c1b2";

const TEST_TIMEOUT_MS = 30_000;

function fail(feedback: string) {
  return { score: { kind: "binary" as const, pass: false }, feedback };
}

export default [
  grader(({ workdir }) => {
    const file = join(workdir, "test.cjs");
    if (!existsSync(file)) {
      return fail("test.cjs is gone — the task said not to edit it, let alone delete it");
    }
    const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (digest !== TEST_FILE_SHA256) {
      return fail(
        "test.cjs was modified. The task is to fix stats.cjs; changing the test " +
        "makes a pass meaningless.",
      );
    }
    return true;
  }, { name: "test-file-untouched", mustPass: true }),

  grader(({ workdir }) => {
    if (!existsSync(join(workdir, "stats.cjs"))) {
      return fail("stats.cjs is missing from the workdir");
    }
    try {
      // Inherit no stdin and cap the wall clock: a fix that hangs is a
      // failure, not a stuck grading pass.
      const stdout = execFileSync("node", ["test.cjs"], {
        cwd: workdir,
        encoding: "utf8",
        timeout: TEST_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { score: { kind: "binary" as const, pass: true }, feedback: stdout.trim() };
    } catch (err) {
      // execFileSync throws on any non-zero exit; its stdout holds the
      // per-case ok/FAIL lines, which are the useful feedback.
      const output = (err as { stdout?: string }).stdout ?? "";
      const message = (err as Error).message;
      return fail(`node test.cjs did not pass:\n${output.trim() || message}`);
    }
  }, { name: "tests-pass", mustPass: true }),
];
