import { z } from "zod";

import { BaseGrader } from "./baseGrader.js";
import { getPath } from "./getPath.js";
import type { Grade, GraderInput, GraderOptions, JSONPath } from "./types.js";

type LlmJudgeOptions = GraderOptions & {
  agencyFile: string;   // judge .agency file
  goalPath?: JSONPath;  // where to read the goal from the input (default ["metadata","goal"])
  binary?: boolean;     // expect a pass/fail verdict instead of a 0..1 score
  node?: string;        // judge node (default "main")
};

const ScalarVerdict = z.object({ score: z.number(), reasoning: z.string() });
const BinaryVerdict = z.object({ pass: z.boolean(), reasoning: z.string() });

/** Grades an output by running a judge .agency file and reading its structured verdict. */
export class LlmJudge extends BaseGrader {
  protected readonly defaultName = "llm-judge";
  constructor(protected readonly options: LlmJudgeOptions) {
    super(options);
  }

  protected async _run({ input, run, runAgency }: GraderInput): Promise<Grade> {
    const goal = String(getPath(input, this.options.goalPath ?? ["metadata", "goal"]) ?? "");
    const args = { goal, output: run.output };
    const node = this.options.node ?? "main";
    if (this.options.binary) {
      const v = await runAgency.runStructured(this.options.agencyFile, node, args, BinaryVerdict);
      return { score: { kind: "binary", pass: v.pass }, feedback: v.reasoning };
    }
    const v = await runAgency.runStructured(this.options.agencyFile, node, args, ScalarVerdict);
    return { score: { kind: "scalar", value: v.score }, feedback: v.reasoning };
  }
}
