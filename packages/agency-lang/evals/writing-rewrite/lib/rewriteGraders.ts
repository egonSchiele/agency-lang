// The grading library for writing-rewrite tests. The output under test is
// the rewritten text. Ground truth is the editor's notes and cleaned version
// in the test's graderFiles/. The tests are copies of writing-review tests
// and are kept in step with that suite by hand.
import * as fs from "fs";
import * as path from "path";

import { binary, grader, scalar, type Grade, type Grader, type Test } from "agency-lang/eval";

import * as prompts from "./templates.js";

/** Mirrors `WritingReviewEvalInput` in stdlib/agents/writing/review.agency. */
type WritingReviewInput = { assignment: string; sourceFile: string };
type RewriteGrader = Grader<WritingReviewInput>;

const getAssignment = (test: Test<WritingReviewInput>): string => test.input?.assignment ?? "";
const getSourceFile = (test: Test<WritingReviewInput>): string => test.input?.sourceFile ?? "";

/** The editor's files for a harvested test: `notes.md` says what was wrong
 *  and `cleaned.md` is the text after editing. */
function harvest(graderFiles: string): { notes: string; cleaned: string } {
  if (graderFiles === "") {
    throw new Error("harvestedRewriteGraders needs a graderFiles/ directory");
  }
  return {
    notes: fs.readFileSync(path.join(graderFiles, "notes.md"), "utf8"),
    cleaned: fs.readFileSync(path.join(graderFiles, "cleaned.md"), "utf8"),
  };
}

/** The editor's points from notes.md, one per top-level bullet or paragraph.
 *  Indented lines continue the point above; a paragraph ending in a colon
 *  owns the bullets under it. */
function editorPoints(notes: string): string[] {
  const points: string[] = [];
  let absorbing = false;
  for (const paragraph of notes.split(/\n\s*\n/)) {
    for (const line of paragraph.split("\n")) {
      if (line.trim() === "") continue;
      const isBullet = /^[-*] /.test(line);
      const text = isBullet ? line.slice(2).trim() : line.trim();
      const continues = (isBullet && absorbing) || (!isBullet && /^\s/.test(line));
      if (continues && points.length > 0) {
        points[points.length - 1] += `\n${text}`;
      } else {
        points.push(text);
        absorbing = !isBullet && text.endsWith(":");
      }
    }
    absorbing = false;
  }
  return points.length > 0 ? points : [notes.trim()];
}

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
    ({ output, workdirFile, test, graderFiles, judges }) => {
      const { cleaned } = harvest(graderFiles);
      return judges.rubric({
        ...prompts.matchesCuts({ sourceFileText: workdirFile(getSourceFile(test)), cleaned }),
        output: rewrittenText(output),
      });
    },
    { name: "matches-cuts" },
  );
}

/** No invented fact, and every identifier kept. */
function faithful(): RewriteGrader {
  return grader<WritingReviewInput>(
    ({ output, workdirFile, test, judges }) =>
      judges.rubric({
        ...prompts.faithful({
          sourceFileText: workdirFile(getSourceFile(test)),
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
      ({ output, workdirFile, test, judges }) =>
        judges.rubric({
          ...prompts.leavesCleanAlone({ sourceFileText: workdirFile(getSourceFile(test)) }),
          output: rewrittenText(output),
        }),
      { name: "leaves-clean-alone" },
    ),
    faithful(),
  ];
}
