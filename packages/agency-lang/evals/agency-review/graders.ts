// PROTOTYPE. Shared grader for every test in this suite; each test.json
// points here with "graders": "../graders.ts".
//
// The agent's output is Feedback[]: [{ error: boolean, feedback: string }].
// A test's `expected` is { verdict: "reject" | "accept", about?: string }.
import { grader } from "agency-lang/eval";

type Feedback = { error: boolean; feedback: string };
type Expected = { verdict: "reject" | "accept"; about?: string };

function findings(output: unknown): Feedback[] {
  return Array.isArray(output) ? (output as Feedback[]) : [];
}

function errors(output: unknown): Feedback[] {
  return findings(output).filter((item) => item && item.error === true);
}

function expectedOf(test: { expected?: unknown }): Expected {
  return test.expected as Expected;
}

export default [
  // The gate: an error finding exists exactly when the test plants a bug.
  // "reject" with no error finding is a miss; "accept" with one is a false
  // positive. Deterministic, no model involved.
  grader(
    ({ output, test }) => {
      const wantReject = expectedOf(test).verdict === "reject";
      const gotReject = errors(output).length > 0;
      return {
        score: { kind: "binary", pass: wantReject === gotReject },
        feedback: `expected ${expectedOf(test).verdict}, got ${
          gotReject ? "reject" : "accept"
        } (${errors(output).length} error finding(s), ${findings(output).length} total)`,
      };
    },
    { name: "verdict", mustPass: true },
  ),

  // Only for planted bugs: does an error finding actually describe the bug,
  // or did the reviewer reject for some other reason? LLM-judged against
  // the test's `about`. `expected: null` stops the judge from treating the
  // whole `expected` object as a gold answer the findings must reproduce.
  grader(
    ({ output, test, judge }) =>
      judge({
        goal: `At least one of these review findings identifies this specific problem (wording may differ): ${
          expectedOf(test).about
        }`,
        output: errors(output).map((item) => item.feedback),
        expected: "",
      }),
    { name: "names-the-bug", inputScope: { tag: "bug" } },
  ),

  // Noise: a review that buries the verdict in many findings is less useful.
  grader(({ output }) => findings(output).length <= 5, { name: "concise" }),
];
