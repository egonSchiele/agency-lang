// One judge for the tests about programs that need information from
// outside the program: today's news, a current version number, a forecast.
// The answer changes every day, so there is no fixed output to check. The
// judge reads the program instead, for three things that hold whatever the
// subject is.
import { idiomJudge } from "./idiomJudge.js";

export function outsideInfoJudge(args: {
  /** The exported function the assignment names, as `name(params)`. */
  signature: string;
  /** What the program has to find out, in a few words. */
  needs: string;
  /** The inputs that decide what is looked up. Leave out one that only
   *  shapes the result afterwards, such as a unit to convert to. */
  inputs: string[];
  /** Inputs that shape the result after the lookup. They must change
   *  what is returned, and need not reach the lookup. */
  shapes?: string[];
  reference: string;
}) {
  const shapes = args.shapes ?? [];
  const shapesRule =
    shapes.length === 0
      ? ""
      : ` These inputs must change what is returned, before or after the lookup: ${shapes.join(", ")}. One that is accepted and ignored fails this point.`;
  return idiomJudge({
    name: "gets-the-information-from-a-source-that-has-it",
    standard: `
    The program must export \`${args.signature}\`. It has to find out ${args.needs}. That changes from day to day, so the program has to get it from somewhere that has it at the moment it runs.

    Make sure that:
    1. the information comes from a source that can supply it. A model call with a hosted web search tool (\`hostedTools: ["web_search"]\`), a web search function followed by reading the results, a fetch of a page or an API that publishes this information, and a standard library connector for this exact kind of data are all such sources. A model call with no tool and no retrieved material is not one: the model can only recall or invent. A connector or API for a different kind of data is not one either.
    2. every one of these inputs decides what is looked up, so that changing it changes the lookup: ${args.inputs.join(", ")}. An input that is accepted and never used, or that reaches the lookup too late to change it, fails this point. An input that only shapes the result after the lookup, such as a unit to convert to, is not on this list.${shapesRule}
    3. no variable, constant, or import is declared and then left unused, and on the path where the lookup succeeds, no field of the result is filled with a placeholder or a guess the source did not supply. How the program reports a failed lookup is not judged: an empty list, zero values, or a failure are all fine there.

    The three points count equally towards the final score. The program does not have to match the reference, and it does not have to use a hosted web search. If the file does not export the function named above, or is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: args.reference,
  });
}
