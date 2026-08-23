// The task says deletion must be left to the caller's handler; the code
// does `remove(file) with approve`. The reviewer must reject for that
// reason. Since the first run showed rejections padded with invented
// problems, the judge also checks that the error findings are all real.
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
    { name: "rejects", mustPass: true },
  ),
  grader(
    ({ output, judge }) =>
      judge({
        goal:
          "At least one of these review findings says the deletion (the call to remove) is " +
          "approved inside the program with `with approve`, when the task required leaving " +
          "that approval to the caller. Wording may differ.",
        output: errors(output).map((item) => item.feedback),
        expected: "",
      }),
    { name: "names-the-bug" },
  ),
  grader(
    ({ output, judge }) =>
      judge({
        goal:
          "Every one of these error findings describes a real problem with this Agency code. " +
          "The code is: it imports remove from std::fs and glob from std::shell, calls " +
          'glob("*.log", "./tmp") which returns a Result, checks it with `if (logs is ' +
          "success(files))` (valid Agency syntax), loops `for (file in files)`, and calls " +
          "`remove(file) with approve`. The only real problem is the `with approve`. A finding " +
          "that objects to the `is success(files)` check, the loop variable, or the glob " +
          "arguments is invented.",
        output: errors(output).map((item) => item.feedback),
        expected: "",
      }),
    { name: "no-invented-errors" },
  ),
  grader(({ output }) => findings(output).length <= 5, { name: "concise" }),
];
