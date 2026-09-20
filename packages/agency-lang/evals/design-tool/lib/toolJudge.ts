// For a tool with no fixed output to check: one that sends something, or
// reads today's news. The judge reads the saved code against a standard,
// with a reference solution for comparison.
import { binary, grader, type Grader } from "agency-lang/eval";
import { bestSource, type DesignInput } from "./designLog.js";

export function toolJudge(args: {
  name: string;
  standard: string;
  reference: string;
}): Grader<DesignInput> {
  return grader<DesignInput>(
    (ctx) => {
      const source = bestSource(ctx);
      if (source === "") {
        return binary(false, "no draft reached the user, so there is nothing to judge");
      }
      return ctx.judges.rubric({
        standard: args.standard,
        context: `A reference solution, for comparison. The output does not have to match it line for line. "Invalid Agency" means the parser refuses the file.\n\n${args.reference}`,
        output: source,
      });
    },
    { name: args.name },
  );
}
