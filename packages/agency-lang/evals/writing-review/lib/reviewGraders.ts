// The one grading library for writing-review tests. Each test's graders.ts
// is a one-liner over these; the judge prompts live here so they improve
// for every test at once. Ground truth is the author's written `reason` for
// what makes the planted text hard to follow (harvested tests will carry a
// real editing note as that reason).
import * as fs from "fs";
import * as path from "path";

import { grader, type Grader } from "agency-lang/eval";

type Feedback = { error: boolean; feedback: string };
const findings = (output: unknown): Feedback[] => (Array.isArray(output) ? output : []);
const errors = (output: unknown) => findings(output).filter((item) => item?.error === true);
const advisories = (output: unknown) => findings(output).filter((item) => item?.error !== true);

type TestShape = { input?: unknown };

/** The reviewed text, read from the test's seeded workdir. Fixture paths
 *  are authored, but a path that escapes the workdir reads as missing. */
function textOf(workdir: string, test: TestShape): string {
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

/** Advisory findings should be worth reading: true of this text and a real
 *  improvement for its audience. A review with no advisory findings passes
 *  vacuously — polish is welcome, not demanded. */
function advisoryUseful(): Grader {
  return grader(
    ({ output, workdir, test, judge }) => {
      const advice = advisories(output);
      if (advice.length === 0) {
        return { score: { kind: "binary", pass: true }, feedback: "no advisory findings" };
      }
      return judge({
        goal:
          "This text was reviewed for readability:\n\n" +
          textOf(workdir, test) +
          "\n\nIt was written for this task:\n\n" +
          assignmentOf(test) +
          "\n\nThese are the review's ADVISORY findings (not errors). Is each one a useful, " +
          "accurate pointer for this text and its audience? Padding (generic writing advice " +
          "that fits any text) and suggestions that are not true of this text should lower " +
          "the score in proportion.",
        output: advice.map((item) => item.feedback),
        expected: "",
      });
    },
    { name: "advisory-useful" },
  );
}

/** Graders for a planted-flaw test: the author's `reason` is the ground
 *  truth for what makes the text hard to follow. */
export function plantedFlawGraders(args: { reason: string }): Grader[] {
  return [
    rejects(),
    grader(
      ({ output, judge }) =>
        judge({
          goal:
            "The text under review has these planted readability problems: " +
            args.reason +
            "\n\nDo these review findings identify those problems? Wording may differ; what " +
            "matters is that the error findings point at the planted passages and what makes " +
            "them hard to follow.",
          output: errors(output).map((item) => item.feedback),
          expected: "",
        }),
      { name: "names-the-flaw" },
    ),
    grader(
      ({ output, workdir, test, judge }) =>
        judge({
          goal:
            "This text was reviewed for readability:\n\n" +
            textOf(workdir, test) +
            "\n\nIts planted problems: " +
            args.reason +
            "\n\nIs every one of these error findings a real obstacle for the text's reader — " +
            "one of the planted problems, or something genuinely hard to follow? A finding " +
            "that objects to clear prose, or to a matter of taste, is invented.",
          output: errors(output).map((item) => item.feedback),
          expected: "",
        }),
      { name: "no-invented-errors" },
    ),
    advisoryUseful(),
  ];
}

/** Graders for a clean test: clear prose the reviewer must not reject. */
export function cleanGraders(): Grader[] {
  return [
    grader(
      ({ output }) => ({
        score: { kind: "binary", pass: errors(output).length === 0 },
        feedback: `${errors(output).length} error finding(s) on clear prose: ${errors(output)
          .map((item) => item.feedback)
          .join(" | ")}`,
      }),
      { name: "rejects-nothing" },
    ),
    advisoryUseful(),
  ];
}
