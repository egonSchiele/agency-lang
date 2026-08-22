// The real CLI: `agency test --json --agency-only --reject '*'` against an
// agent-written fib.agency, through the grader's own spawn.
import { describe, test, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgencyTestGrader } from "./agencyTestGrader.js";
import { AgencyRunner } from "./agencyRunner.js";
import { getPackageRoot } from "../../importPaths.js";
import type { GraderInput } from "./types.js";

const HARNESS =
  'import { fib } from "./fib.agency"\n\nexport node five(): number {\n  return fib(5)\n}\n\nexport node eight(): number {\n  return fib(6)\n}\n';
const HARNESS_JSON = JSON.stringify({
  tests: [
    { nodeName: "five", expectedOutput: "5", evaluationCriteria: [{ type: "exact" }] },
    { nodeName: "eight", expectedOutput: "8", evaluationCriteria: [{ type: "exact" }] },
  ],
});
const GOOD =
  "export def fib(n: number): number {\n  if (n < 2) {\n    return n\n  }\n  return fib(n - 1) + fib(n - 2)\n}\n";

function pairDir(): { agency: string; json: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fib-harness-"));
  fs.writeFileSync(path.join(dir, "fib-tests.agency"), HARNESS);
  fs.writeFileSync(path.join(dir, "fib-tests.test.json"), HARNESS_JSON);
  return {
    agency: path.join(dir, "fib-tests.agency"),
    json: path.join(dir, "fib-tests.test.json"),
  };
}

function workdirWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fib-workdir-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

function input(workdir: string): GraderInput {
  return {
    test: { id: "fib" },
    run: { output: null, traceId: "tr", workdir, record: {} as never },
    runAgency: new AgencyRunner({}),
  };
}

describe("AgencyTestGrader through the real agency CLI", () => {
  beforeAll(() => {
    expect(fs.existsSync(path.join(getPackageRoot(), "dist", "scripts", "agency.js"))).toBe(true);
  });

  test("a correct solution scores 1", async () => {
    const pair = pairDir();
    const grader = new AgencyTestGrader({
      name: "fib-tests",
      harnessAgency: pair.agency,
      harnessJson: pair.json,
    });
    const grade = await grader.run(input(workdirWith({ "fib.agency": GOOD })));
    expect(grade).toEqual({ score: { kind: "scalar", value: 1 } });
  }, 120_000);

  test("a wrong solution scores the passing fraction with the diff", async () => {
    const pair = pairDir();
    // Right for fib(5), wrong for fib(6): five passes, eight fails.
    const wrong =
      "export def fib(n: number): number {\n  if (n == 6) {\n    return 9\n  }\n  if (n < 2) {\n    return n\n  }\n  return fib(n - 1) + fib(n - 2)\n}\n";
    const grader = new AgencyTestGrader({
      name: "fib-tests",
      harnessAgency: pair.agency,
      harnessJson: pair.json,
    });
    const grade = await grader.run(input(workdirWith({ "fib.agency": wrong })));
    expect(grade.score).toEqual({ kind: "scalar", value: 0.5 });
    expect(grade.feedback).toMatch(/eight:/);
  }, 120_000);

  test("a solution importing fs scores 0 with the validator's refusal", async () => {
    const pair = pairDir();
    const grader = new AgencyTestGrader({
      name: "fib-tests",
      harnessAgency: pair.agency,
      harnessJson: pair.json,
    });
    const grade = await grader.run(
      input(workdirWith({ "fib.agency": `import fs from "fs"\n${GOOD}` })),
    );
    expect(grade.score).toEqual({ kind: "scalar", value: 0 });
    expect(grade.feedback).toMatch(/not Agency source/);
  }, 120_000);

  test("a solution that approves its own write writes nothing under the grader", async () => {
    // The positive control (the same write lands under plain `agency test`)
    // is tests/agency-js/test-cli-policy.
    const pair = pairDir();
    const writing = `${GOOD}\nexport node probe(): string {\n  const r = write("pwned.txt", "x", ".") with approve\n  return "done"\n}\n`;
    fs.writeFileSync(
      pair.agency,
      'import { probe } from "./fib.agency"\n\nexport node five(): string {\n  return probe()\n}\n',
    );
    fs.writeFileSync(
      pair.json,
      JSON.stringify({
        tests: [
          { nodeName: "five", expectedOutput: '"done"', evaluationCriteria: [{ type: "exact" }] },
        ],
      }),
    );
    const workdir = workdirWith({ "fib.agency": writing });
    const grader = new AgencyTestGrader({
      name: "fib-tests",
      harnessAgency: pair.agency,
      harnessJson: pair.json,
    });
    const grade = await grader.run(input(workdir));
    // The rejected write is a failure value inside probe; probe still
    // returns "done", so the case passes — and no file exists anywhere.
    expect(grade.score).toEqual({ kind: "scalar", value: 1 });
    expect(fs.existsSync(path.join(workdir, "pwned.txt"))).toBe(false);
  }, 120_000);
});
