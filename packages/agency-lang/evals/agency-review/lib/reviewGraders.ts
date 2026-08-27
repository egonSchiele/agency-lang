// The one grading library for agency-review tests. Each test's graders.ts is
// a one-liner over these; the judge prompts live here so they improve for
// every test at once. Ground truth is data the test carries (a mutation diff
// and/or the author's reason), plus the shared Agency facts card.
import { binary, grader, type Grader } from "agency-lang/eval";

import { AGENCY_FACTS } from "./agencyFacts.js";

/** Mirrors `ReviewEvalInput` in stdlib/agents/agency/review.agency. */
type ReviewInput = { assignment: string; sourceFile: string };
type ReviewGrader = Grader<ReviewInput>;

type Feedback = { error: boolean; feedback: string };
const findings = (output: unknown): Feedback[] => (Array.isArray(output) ? output : []);
const errors = (output: unknown) => findings(output).filter((item) => item?.error === true);
const advisories = (output: unknown) => findings(output).filter((item) => item?.error !== true);
const text = (items: Feedback[]) => items.map((item) => item.feedback);

const reviewed = (source: string) => `The Agency source that was reviewed:\n\n${source}`;

/** Every claim the findings make about Agency must be true of Agency. Runs on
 *  ALL findings, error and advisory alike: a JS-flavored "error" and a
 *  JS-flavored suggestion are the same failure. Judged against the facts
 *  card, so what counts as true is written down and versioned. */
function agencyTrue(): ReviewGrader {
  return grader<ReviewInput>(
    ({ output, judges }) => {
      const all = findings(output);
      if (all.length === 0) {
        return binary(true, "no findings to check");
      }
      return judges.rubric({
        standard:
          "The work is the findings of a review of Agency-language code, each marked [error] or [advisory]. Every claim a finding makes about Agency syntax, semantics, or idiom is true of Agency, as the facts in the context state it. A finding that treats correct Agency as a mistake, or gives JavaScript advice (like preferring === or for...of), is false and lowers the score in proportion to how many findings are affected.",
        context: `Facts about Agency:\n\n${AGENCY_FACTS}`,
        output: all.map((item) => (item.error ? "[error] " : "[advisory] ") + item.feedback),
      });
    },
    { name: "agency-true" },
  );
}

/** Advisory findings should be worth reading: true of this code and genuinely
 *  useful (performance, idiom, robustness) for this assignment. A review with
 *  no advisory findings passes vacuously; advice is welcome, not demanded. */
function advisoryUseful(): ReviewGrader {
  return grader<ReviewInput>(
    ({ output, workdirFile, test, judges }) => {
      const advice = advisories(output);
      if (advice.length === 0) {
        return binary(true, "no advisory findings");
      }
      return judges.rubric({
        standard:
          "The work is the ADVISORY findings (not errors) of a review of Agency code. Each finding is a useful, accurate pointer for this code: a real performance, idiom, or robustness improvement for the assignment it was written for. Padding (generic advice that fits any code), advice the assignment already settles, and suggestions that are not true of this code lower the score in proportion.",
        context: `${reviewed(workdirFile(test.input?.sourceFile ?? ""))}\n\nThe assignment the code was written for:\n\n${test.input?.assignment ?? ""}`,
        output: text(advice),
      });
    },
    { name: "advisory-useful" },
  );
}

function rejects(): ReviewGrader {
  return grader(
    ({ output }) =>
      binary(
        errors(output).length > 0,
        `${errors(output).length} error finding(s), ${findings(output).length} total`,
      ),
    { name: "rejects" },
  );
}

/** Ground truth for a planted bug: the author's one-sentence `reason` for
 *  what the change breaks, plus, for a mutation-derived test, the diff
 *  (minus lines are the correct code, plus lines are what the reviewed
 *  code says) for precision and location. */
function plantedProblem(args: { diff?: string; reason: string }): string {
  const reason = `The code under review is a correct program with exactly one planted problem: ${args.reason}`;
  if (args.diff === undefined) return reason;
  return `${reason}\n\nThe change, as a diff (minus lines are the correct code, plus lines are what the reviewed code actually says):\n\n${args.diff}`;
}

function bugGraders(args: { diff?: string; reason: string }): ReviewGrader[] {
  return [
    rejects(),
    grader<ReviewInput>(
      ({ output, judges }) =>
        judges.rubric({
          standard:
            "The work is the ERROR findings of a code review. Some finding identifies the planted problem described in the context. Wording may differ; what matters is that a finding points at the planted change or its behavior.",
          context: plantedProblem(args),
          output: text(errors(output)),
        }),
      { name: "names-the-bug" },
    ),
    grader<ReviewInput>(
      ({ output, workdirFile, test, judges }) =>
        judges.rubric({
          standard:
            "The work is the ERROR findings of a code review. Every finding is a real problem with the source: the planted problem, or something genuinely wrong. A finding that objects to correct code is invented and lowers the score in proportion.",
          context: `${plantedProblem(args)}\n\n${reviewed(workdirFile(test.input?.sourceFile ?? ""))}`,
          output: text(errors(output)),
        }),
      { name: "no-invented-errors" },
    ),
    agencyTrue(),
    advisoryUseful(),
  ];
}

/** Graders for a mutation-derived bug test. `diff` is the mutation applied
 *  to a correct program, verified at authoring time to typecheck and fail
 *  the test's harness; `reason` is the mutation author's one sentence on
 *  what the change breaks. */
export function mutantGraders(args: { diff: string; reason: string }): ReviewGrader[] {
  return bugGraders(args);
}

/** Graders for a hand-planted bug test (no mutation diff): the author's
 *  `reason` alone is the ground truth for what is wrong. */
export function plantedBugGraders(args: { reason: string }): ReviewGrader[] {
  return bugGraders(args);
}

function noFalsePositive(): ReviewGrader {
  return grader(
    ({ output }) =>
      binary(
        errors(output).length === 0,
        `${errors(output).length} error finding(s) on correct code: ${text(errors(output)).join(" | ")}`,
      ),
    { name: "no-false-positive" },
  );
}

/** Graders for a clean test: correct code the reviewer must not reject. */
export function cleanGraders(): ReviewGrader[] {
  return [noFalsePositive(), agencyTrue(), advisoryUseful()];
}

/** Graders for an idiom test: code that does what the task asks, written the
 *  way a JavaScript programmer would rather than the Agency way. The reviewer
 *  must not reject it, and must point out the idiom in an advisory finding.
 *  `reason` is the author's one sentence on what the idiomatic form is. */
export function idiomGraders(args: { reason: string }): ReviewGrader[] {
  return [
    noFalsePositive(),
    grader<ReviewInput>(
      ({ output, judges }) =>
        judges.rubric({
          standard:
            "The work is the ADVISORY findings of a code review. Some finding points out the idiom described in the context and names the Agency form to use instead. Wording may differ; what matters is that a reader would know what to change.",
          context: `The code under review does what its task asks, but misses one Agency idiom: ${args.reason}`,
          output: text(advisories(output)),
        }),
      { name: "names-the-idiom" },
    ),
    agencyTrue(),
    advisoryUseful(),
  ];
}
