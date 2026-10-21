import * as fs from "fs";
import * as path from "path";

import { isStrictDescendant } from "@/utils.js";

import { BaseGrader } from "../baseGrader.js";
import {
  CHECKLIST_JUDGE_VERSION,
  ChecklistVerdict,
  checklistJudgeFile,
} from "../checklistJudgeFile.js";
import { asJudgeText } from "../goalJudgeFile.js";
import type { Grade, GraderInput, GraderOptions, Point } from "../types.js";

const SINGLE_SAMPLE = 1;

type ChecklistJudgeOptions = GraderOptions & {
  /** The points the work is checked against, as the test wrote them. */
  points: string[];
  /** Background for the judge, as a path under the test's `graderFiles/`.
   *  Read from the run directory's stored copy at grade time, so a stored
   *  run grades the same after the test folder is gone. */
  context?: string;
};

/**
 * Grades a work against a list of points by asking the bundled checklist
 * judge for one answer per point. The score is the share of points that
 * passed; "cannot tell" counts as a fail. The answers travel on the grade
 * as `points`, so the score row shows which point failed. A must-pass
 * checklist passes only when every point passed. A checklist cannot be
 * sampled: aggregation keeps only the score and feedback.
 */
export class ChecklistJudge extends BaseGrader {
  protected readonly defaultName = "checklist";

  constructor(protected readonly options: ChecklistJudgeOptions) {
    super(options);
    if ((options.samples ?? SINGLE_SAMPLE) > SINGLE_SAMPLE) {
      throw new Error(
        `${this.name()}: a checklist judge cannot be sampled; its per-point answers do not survive aggregation`,
      );
    }
  }

  override annotator(): { kind: "grader" | "judge"; id: string } {
    if (this.revision !== undefined) return { kind: "grader", id: this.revision };
    return { kind: "judge", id: `checklist-judge@${CHECKLIST_JUDGE_VERSION}` };
  }

  override describe(): string {
    return `${this.name()}: checklist of ${this.options.points.length} points`;
  }

  /** Does not call the base method: that one wants a threshold for a scalar
   *  gate, and a checklist has none. */
  override passes(grade: Grade): boolean {
    if (grade.points !== undefined) {
      return grade.points.every((point) => point.pass);
    }
    return grade.score.kind === "binary" ? grade.score.pass : grade.score.value === 1;
  }

  protected async _run({ run, runAgency, graderFiles }: GraderInput): Promise<Grade> {
    const points = this.options.points;
    const verdict = await runAgency.runStructured(
      checklistJudgeFile(),
      "main",
      [points, asJudgeText(run.output), this.contextText(graderFiles)],
      ChecklistVerdict,
    );
    if (verdict.points.length !== points.length) {
      throw new Error(
        `${this.name()}: the judge answered ${verdict.points.length} points for ${points.length} asked`,
      );
    }
    const answered: Point[] = points.map((point, index) => ({
      point,
      pass: verdict.points[index].pass === true,
      evidence: verdict.points[index].evidence,
    }));
    const passed = answered.filter((point) => point.pass).length;
    return {
      score: { kind: "scalar", value: passed / points.length },
      feedback: verdict.note,
      points: answered,
    };
  }

  /** The context file must sit inside `graderFiles/` with no symlink on
   *  the way, as the snapshot that stored the folder refused symlinks. */
  private contextText(graderFiles: string | undefined): string {
    const context = this.options.context;
    if (context === undefined) {
      return "";
    }
    const file = graderFiles === undefined ? undefined : contextFileWithin(graderFiles, context);
    if (file === undefined) {
      throw new Error(`${this.name()}: context file ${context} is not in graderFiles/`);
    }
    return fs.readFileSync(file, "utf8");
  }
}

/** The resolved context path, or undefined when it leaves the root, is
 *  missing, or any step from the root down is a symlink. */
function contextFileWithin(graderFiles: string, context: string): string | undefined {
  const root = path.resolve(graderFiles);
  const file = path.resolve(root, context);
  if (!isStrictDescendant(root, file) || !fs.existsSync(file)) {
    return undefined;
  }
  const steps = path.relative(root, file).split(path.sep);
  const visited = steps.map((_, index) => path.join(root, ...steps.slice(0, index + 1)));
  const anySymlink = [root, ...visited].some((step) => fs.lstatSync(step).isSymbolicLink());
  return anySymlink ? undefined : file;
}
