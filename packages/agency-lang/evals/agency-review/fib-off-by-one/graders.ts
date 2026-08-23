// fib(0) returns 1. The reviewer must reject, and the rejection must be
// about the base case rather than some other complaint. No mustPass gates:
// a missed verdict costs its own score but the other graders still run, so
// scores move incrementally instead of pinning at 0.
import { grader } from "agency-lang/eval";

type Feedback = { error: boolean; feedback: string };
const findings = (output: unknown): Feedback[] => (Array.isArray(output) ? output : []);
const errors = (output: unknown) => findings(output).filter((item) => item?.error === true);

export default [
  grader(
    ({ output }) => ({
      score: { kind: "binary", pass: errors(output).length > 0 },
      feedback: `${errors(output).length} error finding(s), ${findings(output).length} total`,
    }),
    { name: "rejects" },
  ),
  // `expected: ""` keeps the judge from wanting a gold answer restated; the
  // goal already says what a correct finding mentions.
  grader(
    ({ output, judge }) =>
      judge({
        goal:
          "At least one of these review findings says that fib(0) returns 1 when it should " +
          "return 0 (the base case for n = 0 is wrong). Wording may differ.",
        output: errors(output).map((item) => item.feedback),
        expected: "",
      }),
    { name: "names-the-bug" },
  ),
  grader(({ output }) => findings(output).length <= 5, { name: "concise" }),
];
