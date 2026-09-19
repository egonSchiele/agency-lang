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
  /** The inputs that have to reach the place the information is fetched. */
  inputs: string[];
  reference: string;
}) {
  return idiomJudge({
    name: "gets-the-information-from-a-source-that-has-it",
    standard: `
    The program must export \`${args.signature}\`. It has to find out ${args.needs}. That changes from day to day, so the program has to get it from somewhere that has it at the moment it runs.

    Make sure that:
    1. the information comes from a source that can supply it. A model call with a hosted web search tool (\`hostedTools: ["web_search"]\`), a web search function followed by reading the results, a fetch of a page or an API that publishes this information, and a standard library connector for this exact kind of data are all such sources. A model call with no tool and no retrieved material is not one: the model can only recall or invent. A connector or API for a different kind of data is not one either.
    2. every one of these inputs reaches the place the information is fetched, so that changing the input changes what is looked up: ${args.inputs.join(", ")}. An input that is accepted and never used, or used only after the lookup, fails this point.
    3. no variable, constant, or import is declared and then left unused, and no field of the result is filled with a placeholder or a guess the source did not supply.

    The three points count equally towards the final score. The program does not have to match the reference, and it does not have to use a hosted web search. If the file does not export the function named above, or is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: args.reference,
  });
}
