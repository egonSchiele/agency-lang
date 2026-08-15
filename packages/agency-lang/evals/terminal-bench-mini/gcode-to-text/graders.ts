import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { grader } from "agency-lang/eval";

// Ported from terminal-bench 2.0's gcode-to-text verifier, which compares
// out.txt (trimmed) against the exact expected string. We compare a sha256
// of the trimmed content instead of the string itself: this repo is public
// and the expected output IS the task's answer — embedding it in plaintext
// would leak benchmark data (the fixture carries terminal-bench's canary
// telling training corpora to stay away) and make the test trivially
// searchable. Same technique terminal-bench's own fix-git verifier uses
// (hash comparison against an answer key).
const EXPECTED_SHA256 = "d62e43c8910bff34c49b6ede91b6958af68df5c9cf52fc03b4e8dd4521a64623";

export default [
  grader(({ workdir }) => existsSync(join(workdir, "out.txt")), {
    name: "wrote-out-file",
    mustPass: true,
  }),

  grader(
    ({ workdir }) => {
      const file = join(workdir, "out.txt");
      if (!existsSync(file)) {
        return {
          score: { kind: "binary" as const, pass: false },
          feedback: "out.txt was not written",
        };
      }
      const content = readFileSync(file, "utf8").trim();
      const digest = createHash("sha256").update(content).digest("hex");
      if (digest === EXPECTED_SHA256) {
        return true;
      }
      return {
        score: { kind: "binary" as const, pass: false },
        feedback:
          `out.txt does not contain the expected text (sha256 mismatch). ` +
          `Got ${content.length} chars starting with ${JSON.stringify(content.slice(0, 40))}`,
      };
    },
    { name: "decoded-text-matches", mustPass: true },
  ),
];
