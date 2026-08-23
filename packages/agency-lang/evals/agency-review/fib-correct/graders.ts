// A correct fib: the reviewer must not flag an error. Deterministic. No
// grader is a mustPass gate: a wrong verdict costs its own score but the
// rest still run, so improvement shows up incrementally.
import { grader } from "agency-lang/eval";

type Feedback = { error: boolean; feedback: string };
const findings = (output: unknown): Feedback[] => (Array.isArray(output) ? output : []);
const errors = (output: unknown) => findings(output).filter((item) => item?.error === true);

export default [
  grader(
    ({ output }) => ({
      score: { kind: "binary", pass: errors(output).length === 0 },
      feedback: `${errors(output).length} error finding(s) on correct code: ${errors(output)
        .map((item) => item.feedback)
        .join(" | ")}`,
    }),
    { name: "no-false-positive" },
  ),
  grader(({ output }) => findings(output).length <= 5, { name: "concise" }),
];
