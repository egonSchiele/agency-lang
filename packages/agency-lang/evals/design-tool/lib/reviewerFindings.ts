// Every test carries this grader. The reviewer inside designTool can block
// a draft, and a blocking finding that is wrong costs a whole round, or
// leaves the user looking at a complaint no draft could clear. A judge
// reads each blocking finding against the draft it was about.
import { binary, grader, type Grader } from "agency-lang/eval";
import { bestSource, readLog, type DesignInput } from "./designLog.js";

export function reviewerFindings(): Grader<DesignInput> {
  return grader<DesignInput>(
    (ctx) => {
      const log = readLog(ctx);
      if (log === null) {
        return binary(false, "no design-log.json");
      }
      const blocking = log.reviews.flatMap((review) => review.blocking);
      if (blocking.length === 0) {
        return binary(true, "no blocking findings reached the user");
      }
      const input = ctx.test.input;
      const facts = Object.entries(input?.facts ?? {}).map(
        ([name, value]) => `- ${name}: ${value}`,
      );
      const told =
        facts.length === 0
          ? ""
          : `\n\nThe author asked the user and was told the facts below. Writing them into the module is what the user wants, so a finding that objects to a hard-coded value from this list is not real, and neither is one that asks for an environment variable the user never named.\n${facts.join("\n")}`;
      return ctx.judges.rubric({
        standard: `
        A reviewer read a draft of an Agency module and reported the findings below as blocking. The module had to export \`type Request = ${input?.request}\` and \`def run(request: Request): Json\`, and do this: ${input?.purpose}

        Score the share of findings that are real: the draft has the problem the finding names, and the author could fix it by changing this module. A finding about the layout or line breaks of the Request type is not real. A finding that asks for something the task never stated is not real. A finding the draft plainly contradicts is not real.${told}`,
        context: `The draft the findings are about:\n\n${bestSource(ctx)}`,
        output: blocking.map((finding, index) => `${index + 1}. ${finding}`).join("\n"),
      });
    },
    { name: "reviewer-findings-are-real", weight: 0.5 },
  );
}
