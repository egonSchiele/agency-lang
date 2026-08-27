// One judge for tests about HOW Agency code is written. It reads the saved
// solution and scores it against a standard, with a reference solution as
// context so the judge knows what idiomatic Agency looks like.
import { binary, grader, type Grader } from "agency-lang/eval";

/** Mirrors `CodingEvalInput` in stdlib/agents/agency/coding.agency. */
type CodingInput = { assignment: string; outFile: string };

export function idiomJudge(args: {
  name: string;
  standard: string;
  reference: string;
  /** Share of the objective, default 1. */
  weight?: number;
}): Grader<CodingInput> {
  return grader<CodingInput>(
    ({ workdirFile, test, judges }) => {
      const source = workdirFile(test.input?.outFile ?? "");
      if (source === "") {
        return binary(false, `no ${test.input?.outFile} was saved`);
      }
      return judges.rubric({
        standard: args.standard,
        context: `An idiomatic reference solution, for comparison. The output does not need to match it line for line, only in the idioms the standard names. "Invalid Agency" means the parser refuses the file. A type name or helper you do not recognize does not make a file invalid, and these forms are all valid Agency: an inline block \`map(xs, \\x -> x * 2)\`, a full block \`map(xs) as x { ... }\`, and a comprehension \`[x for x in xs if cond]\`. Judge only the idioms the standard names.\n\n${args.reference}`,
        output: source,
      });
    },
    { name: args.name, ...(args.weight === undefined ? {} : { weight: args.weight }) },
  );
}
