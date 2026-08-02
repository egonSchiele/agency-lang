import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { grader } from "agency-lang/eval";

// Proves the search tools work and that the agent looks rather than guesses.
// Fourteen files across four directories: enough that guessing is unlikely,
// small enough that a capable agent finishes in a handful of tool calls.
const NEEDLE = "PROJECT-CANARY-7Q4X";
const EXPECTED_PATH = "archive/2025/q3-notes.md";

function fail(feedback: string) {
  return { score: { kind: "binary" as const, pass: false }, feedback };
}

/** Accept the spellings that name the same file: a leading ./, a trailing
 *  newline, backslashes. Not a leading / — an absolute path is a different
 *  answer from the relative one the task asked for. */
function normalize(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export default [
  grader(({ workdir }) => existsSync(join(workdir, "answer.txt")), {
    name: "wrote-answer-file",
    mustPass: true,
  }),

  // Tripwire on the fixture, not the agent: if the needle ever moves or the
  // tree is reseeded wrong, say so instead of failing every run as if the
  // agent had searched badly.
  grader(({ workdir }) => {
    const needleFile = join(workdir, EXPECTED_PATH);
    if (!existsSync(needleFile)) {
      return fail(`fixture missing: ${EXPECTED_PATH} was not seeded into the workdir`);
    }
    if (!readFileSync(needleFile, "utf8").includes(NEEDLE)) {
      return fail(`fixture inconsistent: ${EXPECTED_PATH} no longer contains ${NEEDLE}`);
    }
    return true;
  }, { name: "fixture-is-consistent", mustPass: true }),

  grader(({ workdir }) => {
    const file = join(workdir, "answer.txt");
    if (!existsSync(file)) {
      return fail("answer.txt was not written");
    }
    const answer = normalize(readFileSync(file, "utf8"));
    if (answer === EXPECTED_PATH) {
      return true;
    }
    // Naming the right file with extra prose around it is a formatting miss,
    // not a search miss, and the feedback should distinguish them.
    if (answer.includes(EXPECTED_PATH)) {
      return fail(
        `answer.txt should contain only the path ${EXPECTED_PATH}, got ${JSON.stringify(answer)}`,
      );
    }
    return fail(`expected the path ${EXPECTED_PATH}, got ${JSON.stringify(answer)}`);
  }, { name: "path-matches", mustPass: true }),
];
