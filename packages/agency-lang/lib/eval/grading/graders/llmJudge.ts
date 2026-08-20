import * as fs from "fs";

import { sha256Text } from "@/utils/hash.js";
import { z } from "zod";

import {
  asJudgeText,
  GOAL_JUDGE_VERSION,
  goalJudgeFile,
  scalarGrade,
  ScalarVerdict,
} from "../goalJudgeFile.js";
import { BaseGrader } from "../baseGrader.js";
import { getPath } from "../getPath.js";
import type { Grade, GraderInput, GraderOptions, JSONPath } from "../types.js";

type LlmJudgeOptions = GraderOptions & {
  agencyFile?: string; // judge .agency file (default: the bundled goal judge)
  goal?: string; // fixed goal for every input (overrides goalPath)
  goalPath?: JSONPath; // where to read the goal from the input (default ["goal"])
  expectedPath?: JSONPath; // where to read the gold answer (default ["expected"]); passed to the judge
  binary?: boolean; // expect a pass/fail verdict instead of a 0..1 score
  node?: string; // judge node (default "main")
};

const BinaryVerdict = z.object({ pass: z.boolean(), reasoning: z.string() });

/** Grades an output by running a judge .agency file and reading its structured verdict. */
export class LlmJudge extends BaseGrader {
  /** The bundled judge is `goal-judge@<GOAL_JUDGE_VERSION>` (a test pins the
   *  version to the prompt file's hash); a custom agencyFile is identified by
   *  its content, so editing it in place is a new annotator. */
  override annotator(): { kind: "grader" | "judge"; id: string } {
    if (this.revision !== undefined) return { kind: "grader", id: this.revision };
    const judgeFile = this.customJudgeFile();
    if (judgeFile === undefined) {
      return { kind: "judge", id: `goal-judge@${GOAL_JUDGE_VERSION}` };
    }
    const hash = sha256Text(fs.readFileSync(judgeFile, "utf8"));
    return { kind: "judge", id: `${this.options.agencyFile}@${hash}` };
  }

  protected readonly defaultName = "llm-judge";
  constructor(protected readonly options: LlmJudgeOptions) {
    super(options);
  }

  /** The custom judge file; undefined for the bundled judge. A run-directory
   *  snapshot rebinds it to the stored copy. */
  private judgeFile: string | undefined = undefined;
  private customJudgeFile(): string | undefined {
    return this.judgeFile ?? this.options.agencyFile;
  }
  override externalFiles(): string[] {
    return this.options.agencyFile === undefined ? [] : [this.options.agencyFile];
  }
  override rebindExternalFile(from: string, to: string): void {
    if (this.options.agencyFile === from) this.judgeFile = to;
  }

  protected async _run({ test, run, runAgency }: GraderInput): Promise<Grade> {
    const goalPath = this.options.goalPath ?? ["goal"];
    // Prefer an inline goal (same for every input); otherwise read it from the input.
    const goal = this.options.goal ?? getPath(test, goalPath);
    // An LLM judge with no goal has nothing to judge against — fail loudly rather
    // than ask the model to grade output against an empty criterion.
    if (goal === undefined || goal === null || String(goal).trim() === "") {
      throw new Error(
        `${this.name()}: no goal (set options.goal or provide one at ${globalThis.JSON.stringify(goalPath)} on test ${test.id ?? "(no id)"}); an LLM judge needs a goal.`,
      );
    }
    const agencyFile = this.customJudgeFile() ?? goalJudgeFile();
    // Judges take a string output; stringify structured outputs so they read as JSON
    // rather than "[object Object]".
    const output = asJudgeText(run.output);
    // The gold answer, when the input carries one — the bundled judge grades against
    // it. Empty string when absent; a custom judge node that ignores it is unaffected.
    const expectedRaw = getPath(test, this.options.expectedPath ?? ["expected"]);
    const expected =
      expectedRaw === undefined || expectedRaw === null ? "" : asJudgeText(expectedRaw);
    const args = [String(goal), output, expected];
    const node = this.options.node ?? "main";
    if (this.options.binary) {
      const v = await runAgency.runStructured(agencyFile, node, args, BinaryVerdict);
      return { score: { kind: "binary", pass: v.pass }, feedback: v.reasoning };
    }
    const v = await runAgency.runStructured(agencyFile, node, args, ScalarVerdict);
    return scalarGrade(v);
  }
}
