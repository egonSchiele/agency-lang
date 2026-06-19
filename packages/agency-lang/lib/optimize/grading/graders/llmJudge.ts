import { z } from "zod";

import { asJudgeText, goalJudgeFile, ScalarVerdict } from "../../goalJudgeFile.js";
import { BaseGrader } from "../baseGrader.js";
import { getPath } from "../getPath.js";
import type { Grade, GraderInput, GraderOptions, JSONPath } from "../types.js";

type LlmJudgeOptions = GraderOptions & {
  agencyFile?: string;  // judge .agency file (default: the bundled goal judge)
  goal?: string;        // fixed goal for every input (overrides goalPath)
  goalPath?: JSONPath;  // where to read the goal from the input (default ["goal"])
  binary?: boolean;     // expect a pass/fail verdict instead of a 0..1 score
  node?: string;        // judge node (default "main")
};

const BinaryVerdict = z.object({ pass: z.boolean(), reasoning: z.string() });

/** Grades an output by running a judge .agency file and reading its structured verdict. */
export class LlmJudge extends BaseGrader {
  protected readonly defaultName = "llm-judge";
  constructor(protected readonly options: LlmJudgeOptions) {
    super(options);
  }

  protected async _run({ input, run, runAgency }: GraderInput): Promise<Grade> {
    const goalPath = this.options.goalPath ?? ["goal"];
    // Prefer an inline goal (same for every input); otherwise read it from the input.
    const goal = this.options.goal ?? getPath(input, goalPath);
    // An LLM judge with no goal has nothing to judge against — fail loudly rather
    // than ask the model to grade output against an empty criterion.
    if (goal === undefined || goal === null || String(goal).trim() === "") {
      throw new Error(`${this.name()}: no goal (set options.goal or provide one at ${globalThis.JSON.stringify(goalPath)} on input ${input.id ?? "(no id)"}); an LLM judge needs a goal.`);
    }
    const agencyFile = this.options.agencyFile ?? goalJudgeFile();
    // Judges take a string output; stringify structured outputs so they read as JSON
    // rather than "[object Object]".
    const output = asJudgeText(run.output);
    const args = [String(goal), output];
    const node = this.options.node ?? "main";
    if (this.options.binary) {
      const v = await runAgency.runStructured(agencyFile, node, args, BinaryVerdict);
      return { score: { kind: "binary", pass: v.pass }, feedback: v.reasoning };
    }
    const v = await runAgency.runStructured(agencyFile, node, args, ScalarVerdict);
    return { score: { kind: "scalar", value: v.score }, feedback: v.reasoning };
  }
}
