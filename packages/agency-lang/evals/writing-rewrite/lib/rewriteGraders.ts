// The grading library for writing-rewrite tests. The output under test is
// the rewritten text. Each test points at a writing-review test's files and
// graderFiles, so the ground truth (the editor's notes and cleaned version)
// is shared with the reviewer suite; only what is graded differs.
import { binary, grader, scalar, type Grade, type Grader } from "agency-lang/eval";

import {
  type WritingReviewInput,
  editorPoints,
  getAssignment,
  getSourceFileText,
  harvest,
} from "../../writing-review/lib/testFiles.js";
import * as prompts from "./templates.js";

type RewriteGrader = Grader<WritingReviewInput>;

const rewrittenText = (output: unknown): string => (typeof output === "string" ? output : "");

function scoreValue(score: Grade["score"]): number {
  return score.kind === "binary" ? (score.pass ? 1 : 0) : score.value;
}

/** Each of the editor's points, judged on its own: is the problem gone
 *  from the rewrite? Share of points fixed. */
function flawsFixed(): RewriteGrader {
  return grader<WritingReviewInput>(
    async ({ output, graderFiles, judges }) => {
      const { notes } = harvest(graderFiles);
      const points = editorPoints(notes);
      const verdicts = await Promise.all(
        points.map((point) =>
          judges.rubric({ ...prompts.flawFixed({ point, notes }), output: rewrittenText(output) }),
        ),
      );
      const fixed = verdicts.filter((verdict) => scoreValue(verdict.score) >= 0.5).length;
      const report = points.map(
        (point, i) =>
          `[${scoreValue(verdicts[i].score) >= 0.5 ? "fixed" : "remains"}] ${point}\n    ${verdicts[i].feedback ?? ""}`,
      );
      return scalar(fixed / points.length, report.join("\n"));
    },
    { name: "flaws-fixed" },
  );
}

/** What the editor removed must be absent from the rewrite. */
function matchesCuts(): RewriteGrader {
  return grader<WritingReviewInput>(
    ({ output, workdir, test, graderFiles, judges }) => {
      const { cleaned } = harvest(graderFiles);
      if (cleaned === null) {
        throw new Error("matchesCuts needs graderFiles/cleaned.md");
      }
      return judges.rubric({
        ...prompts.matchesCuts({ sourceFileText: getSourceFileText(workdir, test), cleaned }),
        output: rewrittenText(output),
      });
    },
    { name: "matches-cuts" },
  );
}

/** No invented fact, and every identifier kept. */
function faithful(): RewriteGrader {
  return grader<WritingReviewInput>(
    ({ output, workdir, test, judges }) =>
      judges.rubric({
        ...prompts.faithful({
          sourceFileText: getSourceFileText(workdir, test),
          assignment: getAssignment(test),
        }),
        output: rewrittenText(output),
      }),
    { name: "faithful" },
  );
}

/** A rewrite that is empty or that is not text at all fails outright. */
function producesText(): RewriteGrader {
  return grader(
    ({ output }) => {
      const text = rewrittenText(output).trim();
      return binary(text.length > 0 && !text.startsWith("rewrite agent failed"), text.slice(0, 80));
    },
    { name: "produces-text", mustPass: true },
  );
}

/** Graders for a test harvested from real text: the editor's notes and
 *  cleaned version in graderFiles/ are the ground truth. */
export function harvestedRewriteGraders(): RewriteGrader[] {
  return [producesText(), flawsFixed(), matchesCuts(), faithful()];
}

/** Graders for text that was already clear: the rewrite should be the
 *  original, or nearly so. */
export function cleanRewriteGraders(): RewriteGrader[] {
  return [
    producesText(),
    grader<WritingReviewInput>(
      ({ output, workdir, test, judges }) =>
        judges.rubric({
          ...prompts.leavesCleanAlone({ sourceFileText: getSourceFileText(workdir, test) }),
          output: rewrittenText(output),
        }),
      { name: "leaves-clean-alone" },
    ),
    faithful(),
  ];
}
