// The grading library for architecture-review tests. Each test's graders.ts
// is a one-liner over these. Ground truth for a flawed plan is the owner's
// objection to it, written as `reason`. Ground truth for a control is why the
// owner approved the design, written as `approvedBecause`.
import { binary, grader, type Grader } from "agency-lang/eval";

type ArchReviewInput = { plan: string; commit: string; task: string };
type ArchReviewGrader = Grader<ArchReviewInput>;

type Feedback = { error: boolean; feedback: string };
const findings = (output: unknown): Feedback[] => (Array.isArray(output) ? output : []);
const errors = (output: unknown) => findings(output).filter((item) => item?.error === true);
const text = (items: Feedback[]) => items.map((item) => item.feedback);

/** The flaw kinds this suite is about, for the judges' prompts. */
const KINDS =
  "(1) the change is in the wrong layer, such as shared code changed to serve one caller; " +
  "(2) the plan builds something the codebase already has; " +
  "(3) the plan is more complex than the problem needs.";

/** Graders for a plan the owner rejected. */
export function flawedPlanGraders(args: { reason: string }): ArchReviewGrader[] {
  return [
    grader(
      ({ output }) =>
        binary(
          errors(output).length > 0,
          `${errors(output).length} error finding(s), ${findings(output).length} total`,
        ),
      { name: "rejects" },
    ),
    grader<ArchReviewInput>(
      ({ output, judges }) =>
        judges.rubric({
          standard:
            "The work is the ERROR findings of a review of a software design plan. Score 1.0 only if some finding says the plan's approach should be replaced for the reason described in the context: it names the same problem and points toward the same fix, such as the existing mechanism to reuse or the place the change belongs. Wording may differ. Score 0.5 if a finding touches the problem but accepts the plan's approach: for example it keeps the new mechanism and only says where to put it, how to implement it, what to test, or what to document. Score 0.0 if no finding raises the problem. Other findings neither add nor subtract. Before scoring, quote the finding you are scoring and say whether it asks for the plan's approach to be replaced.",
          context: `The design problem the plan's owner raised: ${args.reason}`,
          output: text(errors(output)),
        }),
      { name: "names-the-flaw" },
    ),
  ];
}

/** Graders for a plan the owner approved. */
export function approvedPlanGraders(args: { approvedBecause: string }): ArchReviewGrader[] {
  return [
    // A finished review always reports something, because the reviewer is told
    // to list satisfied points as well as problems. An empty list means the
    // review ran out of budget before it saved anything.
    grader(
      ({ output }) => binary(findings(output).length > 0, `${findings(output).length} finding(s)`),
      { name: "review-finished" },
    ),
    grader<ArchReviewInput>(
      ({ output, judges }) =>
        judges.rubric({
          standard: `The work is the ERROR findings of a review of a software design plan that its owner approved. Score 1.0 if no finding objects to the design's architecture in any of these ways: ${KINDS} Score 0.0 if a finding says the design as a whole should be replaced with a different approach for one of those reasons. Score in proportion for findings that object to one part of the design for one of those reasons. Findings about other things, such as missing tests, unclear wording, or edge cases, do not count either way.`,
          context: `Why the owner approved this design: ${args.approvedBecause}`,
          output: text(errors(output)),
        }),
      { name: "no-false-architecture-alarm" },
    ),
  ];
}
