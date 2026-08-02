import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { grader } from "agency-lang/eval";

// The first test whose fixture matters: hello-file never opens `files/`, so it
// cannot catch a seeding regression. This one is unanswerable without reading
// the seeded CSV, which makes a wrong answer here evidence that the workdir
// was not seeded — check the run's workdir/ before blaming the model.
//
// Kept in sync with files/sales.csv by the sum-matches-fixture grader below,
// so editing the CSV without editing this constant fails loudly instead of
// silently grading against a stale total.
const EXPECTED_TOTAL = 3388;

function fail(feedback: string) {
  return { score: { kind: "binary" as const, pass: false }, feedback };
}

/** The amount column, summed straight from the seeded file. */
function totalFromFixture(workdir: string): number {
  const rows = readFileSync(join(workdir, "sales.csv"), "utf8").trim().split("\n");
  const header = rows[0].split(",");
  const amountIndex = header.indexOf("amount");
  return rows.slice(1).reduce((sum, row) => sum + Number(row.split(",")[amountIndex]), 0);
}

export default [
  grader(({ workdir }) => existsSync(join(workdir, "answer.txt")), {
    name: "wrote-answer-file",
    mustPass: true,
  }),

  // A tripwire on the test itself, not on the agent: if the fixture and the
  // constant ever disagree, every run would score 0 for a reason that has
  // nothing to do with the agent. Fail here instead, with the real cause.
  grader(({ workdir }) => {
    if (!existsSync(join(workdir, "sales.csv"))) {
      return fail("sales.csv is missing from the workdir — the test fixture was not seeded");
    }
    const actual = totalFromFixture(workdir);
    if (actual === EXPECTED_TOTAL) {
      return true;
    }
    return fail(
      `test fixture and grader disagree: sales.csv totals ${actual} but this grader ` +
      `expects ${EXPECTED_TOTAL}. Update EXPECTED_TOTAL in graders.ts.`,
    );
  }, { name: "fixture-is-consistent", mustPass: true }),

  grader(({ workdir }) => {
    const file = join(workdir, "answer.txt");
    if (!existsSync(file)) {
      return fail("answer.txt was not written");
    }
    const content = readFileSync(file, "utf8").trim();
    if (content === String(EXPECTED_TOTAL)) {
      return true;
    }
    // A right number in the wrong format is a different failure from a wrong
    // number, and the agent's feedback should say which.
    if (Number(content.replace(/[$,\s]/g, "")) === EXPECTED_TOTAL) {
      return fail(
        `the total is right but the formatting is not: expected ${EXPECTED_TOTAL} as bare digits, ` +
        `got ${JSON.stringify(content)}`,
      );
    }
    return fail(`expected the total ${EXPECTED_TOTAL}, got ${JSON.stringify(content)}`);
  }, { name: "total-matches", mustPass: true }),
];
