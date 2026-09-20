// Did the author ask the user when it had to, and only then? A test whose
// purpose leaves out a fact expects at least one question. A test whose
// purpose says everything expects none: an author that asks anyway is
// spending the user's time.
import { binary, grader, type Grader } from "agency-lang/eval";
import { readLog, savedSource, type DesignInput } from "./designLog.js";

export function asked(args: { expected: boolean }): Grader<DesignInput> {
  return grader<DesignInput>(
    (ctx) => {
      const log = readLog(ctx);
      if (log === null) {
        return binary(false, "the run has no output");
      }
      const count = log.questions.length;
      if (args.expected) {
        return binary(
          count > 0,
          count > 0 ? `asked: ${log.questions.join(" | ")}` : "never asked the user",
        );
      }
      return binary(
        count === 0,
        count === 0 ? "asked nothing" : `asked without need: ${log.questions.join(" | ")}`,
      );
    },
    { name: args.expected ? "asked-the-user" : "did-not-ask" },
  );
}

/** The saved code must contain each of these, which only the user's
 *  answers could have supplied. */
export function usesAnswers(values: string[]): Grader<DesignInput> {
  return grader<DesignInput>(
    (ctx) => {
      const source = savedSource(ctx);
      if (source === "") {
        return binary(false, "no tool was saved");
      }
      const missing = values.filter((value) => !source.includes(value));
      if (missing.length === 0) {
        return binary(true, "the saved code uses every answer");
      }
      return binary(false, `the saved code never uses: ${missing.join(", ")}`);
    },
    { name: "uses-the-answers" },
  );
}
