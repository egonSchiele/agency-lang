// The one grading library for agency-review tests. Each test's graders.ts is
// a one-liner over these; the judge prompts live here so they improve for
// every test at once. Ground truth is data the test carries (a mutation diff
// and/or the author's reason), plus the shared Agency facts card.
import * as fs from "fs";
import * as path from "path";

import { grader, type Grader } from "agency-lang/eval";

import { AGENCY_FACTS } from "./agencyFacts.js";

type Feedback = { error: boolean; feedback: string };
const findings = (output: unknown): Feedback[] => (Array.isArray(output) ? output : []);
const errors = (output: unknown) => findings(output).filter((item) => item?.error === true);
const advisories = (output: unknown) => findings(output).filter((item) => item?.error !== true);

type TestShape = { input?: unknown };

/** The reviewed source, read from the test's seeded workdir. */
function sourceOf(workdir: string, test: TestShape): string {
  const input = test.input as { sourceFile?: string } | undefined;
  if (!input?.sourceFile) return "";
  try {
    return fs.readFileSync(path.join(workdir, input.sourceFile), "utf8");
  } catch {
    return "";
  }
}

function assignmentOf(test: TestShape): string {
  const input = test.input as { assignment?: string } | undefined;
  return input?.assignment ?? "";
}

/** Every claim the findings make about Agency must be true of Agency. Runs on
 *  ALL findings, error and advisory alike: a JS-flavored "error" and a
 *  JS-flavored suggestion are the same failure. Judged against the facts
 *  card, so what counts as true is written down and versioned. */
function agencyTrue(): Grader {
  return grader(
    ({ output, judge }) => {
      const all = findings(output);
      if (all.length === 0) {
        return { score: { kind: "binary", pass: true }, feedback: "no findings to check" };
      }
      return judge({
        goal:
          "These are review findings about a piece of Agency-language code. Facts about " +
          "Agency:\n\n" +
          AGENCY_FACTS +
          "\n\nIs every claim these findings make about Agency syntax, semantics, or idiom " +
          "true of Agency? A finding that treats correct Agency as a mistake, or gives " +
          "JavaScript advice (like preferring === or for...of), is false and should lower " +
          "the score in proportion to how many findings are affected.",
        output: all.map((item) => (item.error ? "[error] " : "[advisory] ") + item.feedback),
        expected: "",
      });
    },
    { name: "agency-true" },
  );
}

/** Advisory findings should be worth reading: true of this code and genuinely
 *  useful (performance, idiom, robustness) for this assignment. A review with
 *  no advisory findings passes vacuously — advice is welcome, not demanded. */
function advisoryUseful(): Grader {
  return grader(
    ({ output, workdir, test, judge }) => {
      const advice = advisories(output);
      if (advice.length === 0) {
        return { score: { kind: "binary", pass: true }, feedback: "no advisory findings" };
      }
      return judge({
        goal:
          "This Agency source was reviewed:\n\n" +
          sourceOf(workdir, test) +
          "\n\nIt was written for this assignment:\n\n" +
          assignmentOf(test) +
          "\n\nThese are the review's ADVISORY findings (not errors). Is each one a useful, " +
          "accurate pointer for this code — a real performance, idiom, or robustness " +
          "improvement? Padding (generic advice that fits any code), advice the assignment " +
          "already settles, and suggestions that are not true of this code should lower the " +
          "score in proportion.",
        output: advice.map((item) => item.feedback),
        expected: "",
      });
    },
    { name: "advisory-useful" },
  );
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

/** Graders for a mutation-derived bug test. `diff` is the mutation applied
 *  to a correct program — verified at authoring time to typecheck and fail
 *  the test's harness. `reason` is the mutation author's one sentence on
 *  what the change breaks; the judges get both, the reason for semantic
 *  framing and the diff for precision and location. */
export function mutantGraders(args: { diff: string; reason: string }): Grader[] {
  return [
    rejects(),
    grader(
      ({ output, judge }) =>
        judge({
          goal:
            "The code under review is a correct program with exactly one planted change: " +
            args.reason +
            "\nThe change, as a diff (minus lines are the correct code, plus lines are what " +
            "the reviewed code actually says):\n\n" +
            args.diff +
            "\n\nDo these review findings identify that problem? Wording may differ; what " +
            "matters is that some error finding points at the planted change or its behavior.",
          output: errors(output).map((item) => item.feedback),
          expected: "",
        }),
      { name: "names-the-bug" },
    ),
    grader(
      ({ output, workdir, test, judge }) =>
        judge({
          goal:
            "This Agency source was reviewed:\n\n" +
            sourceOf(workdir, test) +
            "\n\nIts only planted problem: " +
            args.reason +
            "\nThe change from the correct version:\n\n" +
            args.diff +
            "\n\nIs every one of these error findings a real problem with the source — the " +
            "planted change, or something genuinely wrong? A finding that objects to correct " +
            "code is invented.",
          output: errors(output).map((item) => item.feedback),
          expected: "",
        }),
      { name: "no-invented-errors" },
    ),
    agencyTrue(),
    advisoryUseful(),
  ];
}

/** Graders for a hand-planted bug test (no mutation diff): the author's
 *  `reason` alone is the ground truth for what is wrong. */
export function plantedBugGraders(args: { reason: string }): Grader[] {
  return [
    rejects(),
    grader(
      ({ output, judge }) =>
        judge({
          goal:
            "The code under review has exactly one planted problem: " +
            args.reason +
            "\n\nDo these review findings identify that problem? Wording may differ; what " +
            "matters is that some error finding points at it.",
          output: errors(output).map((item) => item.feedback),
          expected: "",
        }),
      { name: "names-the-bug" },
    ),
    grader(
      ({ output, workdir, test, judge }) =>
        judge({
          goal:
            "This Agency source was reviewed:\n\n" +
            sourceOf(workdir, test) +
            "\n\nIts only planted problem: " +
            args.reason +
            "\n\nIs every one of these error findings a real problem with the source — the " +
            "planted problem, or something genuinely wrong? A finding that objects to " +
            "correct code is invented.",
          output: errors(output).map((item) => item.feedback),
          expected: "",
        }),
      { name: "no-invented-errors" },
    ),
    agencyTrue(),
    advisoryUseful(),
  ];
}

/** Graders for a clean test: correct code the reviewer must not reject. */
export function cleanGraders(): Grader[] {
  return [
    grader(
      ({ output }) => ({
        score: { kind: "binary", pass: errors(output).length === 0 },
        feedback: `${errors(output).length} error finding(s) on correct code: ${errors(output)
          .map((item) => item.feedback)
          .join(" | ")}`,
      }),
      { name: "no-false-positive" },
    ),
    agencyTrue(),
    advisoryUseful(),
  ];
}
