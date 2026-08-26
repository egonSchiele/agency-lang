// One judge for tests about HOW Agency code is written. It reads the saved
// solution and scores it against a standard, with a reference solution as
// context so the judge knows what idiomatic Agency looks like.
import * as fs from "fs";
import * as path from "path";

import { binary, grader, type Grader, type Test } from "agency-lang/eval";

/** Mirrors `CodingEvalInput` in stdlib/agents/agency/coding.agency. */
type CodingInput = { assignment: string; outFile: string };

/** The saved solution, read from the run's workdir; "" when missing. */
function solutionOf(workdir: string, test: Test<CodingInput>): string {
  if (!test.input?.outFile) return "";
  const root = path.resolve(workdir);
  const resolved = path.resolve(root, test.input.outFile);
  if (!resolved.startsWith(root + path.sep)) return "";
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return "";
  }
}

export function idiomJudge(args: {
  name: string;
  standard: string;
  reference: string;
}): Grader<CodingInput> {
  return grader<CodingInput>(
    ({ workdir, test, judges }) => {
      const source = solutionOf(workdir, test);
      if (source === "") return binary(false, `no ${test.input?.outFile} was saved`);
      return judges.rubric({
        standard: args.standard,
        context: `An idiomatic reference solution, for comparison. The output does not need to match it line for line, only in the idioms the standard names:\n\n${args.reference}`,
        output: source,
      });
    },
    { name: args.name },
  );
}
