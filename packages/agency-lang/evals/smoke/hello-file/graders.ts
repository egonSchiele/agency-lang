import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { grader } from "agency-lang/eval";

// The canary. Nothing here is a benchmark — the point is that a failure
// localizes to the harness rather than to the agent's ability, because no
// capable model fails this. Read it as: seeding, the tool loop, the statelog,
// record extraction, and file grading are all alive.
const EXPECTED = "hello world";

function fail(feedback: string) {
  return { score: { kind: "binary" as const, pass: false }, feedback };
}

export default [
  grader(({ workdir }) => existsSync(join(workdir, "out.txt")), {
    name: "wrote-out-file",
    mustPass: true,
  }),

  grader(
    ({ workdir }) => {
      const file = join(workdir, "out.txt");
      if (!existsSync(file)) {
        return fail("out.txt was not written");
      }
      const content = readFileSync(file, "utf8").trim();
      if (content === EXPECTED) {
        return true;
      }
      return fail(
        `out.txt should contain exactly ${JSON.stringify(EXPECTED)}, got ${JSON.stringify(content)}`,
      );
    },
    { name: "content-matches", mustPass: true },
  ),
];
