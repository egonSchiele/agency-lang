// The one grading library for typescript-review tests. Each test's graders.ts
// is a one-liner over these; the judge prompts live here so they improve for
// every test at once. Ground truth is the author's written `reason` for what
// is wrong with the planted source (harvested tests will carry the real
// review comment and rewrite diff as that reason).
import * as fs from "fs";
import * as path from "path";

import { grader, type Grader } from "agency-lang/eval";

type Feedback = { error: boolean; feedback: string };
const findings = (output: unknown): Feedback[] => (Array.isArray(output) ? output : []);
const errors = (output: unknown) => findings(output).filter((item) => item?.error === true);
const advisories = (output: unknown) => findings(output).filter((item) => item?.error !== true);

type TestShape = { input?: unknown };

/** The reviewed source, read from the test's seeded workdir. Fixture paths
 *  are authored, but a path that escapes the workdir reads as missing. */
function sourceOf(workdir: string, test: TestShape): string {
  const input = test.input as { sourceFile?: string } | undefined;
  if (!input?.sourceFile) return "";
  const root = path.resolve(workdir);
  const resolved = path.resolve(root, input.sourceFile);
  if (!resolved.startsWith(root + path.sep)) return "";
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return "";
  }
}

function assignmentOf(test: TestShape): string {
  const input = test.input as { assignment?: string } | undefined;
  return input?.assignment ?? "";
}

function rejects(): Grader {
  return grader(
    ({ output }) => ({
      score: { kind: "binary", pass: errors(output).length > 0 },
      feedback: `${errors(output).length} error finding(s), ${findings(output).length} total`,
    }),
    { name: "rejects" },
  );
}

/** Advisory findings should be worth reading: true of this code and genuinely
 *  useful for this assignment. A review with no advisory findings passes
 *  vacuously — advice is welcome, not demanded. */
function advisoryUseful(): Grader {
  return grader(
    ({ output, workdir, test, judge }) => {
      const advice = advisories(output);
      if (advice.length === 0) {
        return { score: { kind: "binary", pass: true }, feedback: "no advisory findings" };
      }
      return judge({
        goal:
          "This TypeScript source was reviewed for readability and architecture:\n\n" +
          sourceOf(workdir, test) +
          "\n\nIt was written for this task:\n\n" +
          assignmentOf(test) +
          "\n\nThese are the review's ADVISORY findings (not errors). Is each one a useful, " +
          "accurate pointer for this code? Padding (generic advice that fits any code) and " +
          "suggestions that are not true of this code should lower the score in proportion.",
        output: advice.map((item) => item.feedback),
        expected: "",
      });
    },
    { name: "advisory-useful" },
  );
}

/** Graders for a planted-flaw test: the author's `reason` is the ground
 *  truth for what is wrong with the source. */
export function plantedFlawGraders(args: { reason: string }): Grader[] {
  return [
    rejects(),
    grader(
      ({ output, judge }) =>
        judge({
          goal:
            "The TypeScript code under review has this planted problem: " +
            args.reason +
            "\n\nDo these review findings identify that problem? Wording may differ; what " +
            "matters is that some error finding points at it.",
          output: errors(output).map((item) => item.feedback),
          expected: "",
        }),
      { name: "names-the-flaw" },
    ),
    grader(
      ({ output, workdir, test, judge }) =>
        judge({
          goal:
            "This TypeScript source was reviewed:\n\n" +
            sourceOf(workdir, test) +
            "\n\nIts only planted problem: " +
            args.reason +
            "\n\nIs every one of these error findings a real problem with the source — the " +
            "planted problem, or something genuinely wrong? A finding that objects to " +
            "reasonable code, or that a compiler, linter, or formatter would already catch, " +
            "is invented.",
          output: errors(output).map((item) => item.feedback),
          expected: "",
        }),
      { name: "no-invented-errors" },
    ),
    advisoryUseful(),
  ];
}

/** Graders for a clean test: well-written code the reviewer must not reject. */
export function cleanGraders(): Grader[] {
  return [
    grader(
      ({ output }) => ({
        score: { kind: "binary", pass: errors(output).length === 0 },
        feedback: `${errors(output).length} error finding(s) on clean code: ${errors(output)
          .map((item) => item.feedback)
          .join(" | ")}`,
      }),
      { name: "rejects-nothing" },
    ),
    advisoryUseful(),
  ];
}
