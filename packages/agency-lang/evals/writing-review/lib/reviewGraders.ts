// The one grading library for writing-review tests. Each test's graders.ts
// is a one-liner over these, and every judge prompt lives in templates.ts,
// so a prompt improves for every test at once. Ground truth is either the
// author's written `reason` for what makes a planted text hard to follow,
// or, for a harvested test, the editor's own notes and cleaned version in
// the test's graderFiles/ directory.
import * as fs from "fs";
import * as path from "path";

import { binary, grader, scalar, type Grader, type Test } from "agency-lang/eval";

import * as prompts from "./templates.js";

/** Mirrors `WritingReviewEvalInput` in stdlib/agents/writing/review.agency. */
type WritingReviewInput = { assignment: string; sourceFile: string };
type WritingReviewGrader = Grader<WritingReviewInput>;

type Feedback = { error: boolean; feedback: string };
const findings = (output: unknown): Feedback[] => (Array.isArray(output) ? output : []);
const errors = (output: unknown) => findings(output).filter((item) => item?.error === true);
const advisories = (output: unknown) => findings(output).filter((item) => item?.error !== true);
const text = (items: Feedback[]) => items.map((item) => item.feedback);

/** The reviewed text, read from the test's seeded workdir. Fixture paths
 *  are authored, but a path that escapes the workdir reads as missing. */
function getSourceFileText(workdir: string, test: Test<WritingReviewInput>): string {
  if (!test.input?.sourceFile) return "";
  const root = path.resolve(workdir);
  const resolved = path.resolve(root, test.input.sourceFile);
  if (!resolved.startsWith(root + path.sep)) return "";
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return "";
  }
}

function getAssignment(test: Test<WritingReviewInput>): string {
  return test.input?.assignment ?? "";
}

function rejects(): WritingReviewGrader {
  return grader(
    ({ output }) =>
      binary(
        errors(output).length > 0,
        `${errors(output).length} error finding(s), ${findings(output).length} total`,
      ),
    { name: "rejects" },
  );
}

/** Advisory findings should be worth reading: true of this text and a real
 *  improvement for its audience. A review with no advisory findings passes
 *  vacuously; polish is welcome, not demanded. */
function advisoryUseful(): WritingReviewGrader {
  return grader<WritingReviewInput>(
    ({ output, workdir, test, judges }) => {
      const advice = advisories(output);
      if (advice.length === 0) {
        return binary(true, "no advisory findings");
      }
      return judges.rubric({
        ...prompts.advisoryUseful({
          sourceFileText: getSourceFileText(workdir, test),
          assignment: getAssignment(test),
        }),
        output: text(advice),
      });
    },
    { name: "advisory-useful" },
  );
}

/** A finding's suggested rewrite must say what the original said: no new
 *  claim or mechanism, and every identifier copied exactly. A reviewer whose
 *  rewrites get applied to real docs must not invent facts along the way. */
function rewritesFaithful(): WritingReviewGrader {
  return grader<WritingReviewInput>(
    ({ output, workdir, test, judges }) => {
      const all = findings(output);
      if (all.length === 0) {
        return binary(true, "no findings");
      }
      return judges.rubric({
        ...prompts.rewritesFaithful({ sourceFileText: getSourceFileText(workdir, test) }),
        output: text(all),
      });
    },
    { name: "rewrites-faithful" },
  );
}

/** The editor removed material the reader did not need; the findings must
 *  say to cut it, not reword it. Needs `graderFiles/cleaned.md`. */
export function recommendsCuts(): WritingReviewGrader {
  return grader<WritingReviewInput>(
    ({ output, workdir, test, graderFiles, judges }) => {
      const cleanedFile = path.join(graderFiles, "cleaned.md");
      if (graderFiles === "" || !fs.existsSync(cleanedFile)) {
        throw new Error("recommendsCuts needs graderFiles/cleaned.md");
      }
      const cleaned = fs.readFileSync(cleanedFile, "utf8");
      return judges.rubric({
        ...prompts.recommendsCuts({ sourceFileText: getSourceFileText(workdir, test), cleaned }),
        output: text(findings(output)),
      });
    },
    { name: "recommends-cuts" },
  );
}

/** Graders for a planted-flaw test: the author's `reason` is the ground
 *  truth for what makes the text hard to follow. */
export function plantedFlawGraders(args: { reason: string }): WritingReviewGrader[] {
  return [
    rejects(),
    grader<WritingReviewInput>(
      ({ output, judges }) =>
        judges.rubric({
          ...prompts.namesPlantedFlaw({ reason: args.reason }),
          output: text(errors(output)),
        }),
      { name: "names-the-flaw" },
    ),
    grader<WritingReviewInput>(
      ({ output, workdir, test, judges }) =>
        judges.rubric({
          ...prompts.noInventedErrorsPlanted({
            sourceFileText: getSourceFileText(workdir, test),
            reason: args.reason,
          }),
          output: text(errors(output)),
        }),
      { name: "no-invented-errors" },
    ),
    advisoryUseful(),
    rewritesFaithful(),
  ];
}

/** Graders for a clean test: clear prose the reviewer must not reject. */
export function cleanGraders(): WritingReviewGrader[] {
  return [
    grader(
      ({ output }) =>
        binary(
          errors(output).length === 0,
          `${errors(output).length} error finding(s) on clear prose: ${text(errors(output)).join(" | ")}`,
        ),
      { name: "rejects-nothing" },
    ),
    advisoryUseful(),
    rewritesFaithful(),
  ];
}

/** The editor's files for a harvested test, from its graderFiles/ directory:
 *  `notes.md` says what was wrong; `cleaned.md` is the text after editing,
 *  and an empty one means the text should not exist at all. */
function harvest(graderFiles: string): { notes: string; cleaned: string | null } {
  if (graderFiles === "") {
    throw new Error("harvestedGraders needs a graderFiles/ directory holding notes.md");
  }
  const notes = fs.readFileSync(path.join(graderFiles, "notes.md"), "utf8");
  const cleanedFile = path.join(graderFiles, "cleaned.md");
  const cleaned = fs.existsSync(cleanedFile) ? fs.readFileSync(cleanedFile, "utf8") : null;
  return { notes, cleaned };
}

/** Graders for a harvested test: a real piece of text, the editor's notes on
 *  it, and the text after editing. The notes are the ground truth for what
 *  the findings must name; the cleaned text is the ground truth for whether
 *  the findings would get a writer there, and for what it cut. */
export function harvestedGraders(): WritingReviewGrader[] {
  return [
    rejects(),
    grader<WritingReviewInput>(
      ({ output, graderFiles, judges }) => {
        if (findings(output).length === 0) {
          return scalar(0, "no findings to match");
        }
        return judges.rubric({
          ...prompts.namesHarvestedFlaws({ notes: harvest(graderFiles).notes }),
          output: text(findings(output)),
        });
      },
      { name: "names-the-flaws" },
    ),
    grader<WritingReviewInput>(
      ({ output, workdir, test, graderFiles, judges }) => {
        if (errors(output).length === 0) {
          return binary(true, "no error findings");
        }
        return judges.rubric({
          ...prompts.noInventedErrorsHarvested({
            sourceFileText: getSourceFileText(workdir, test),
            notes: harvest(graderFiles).notes,
          }),
          output: text(errors(output)),
        });
      },
      { name: "no-invented-errors" },
    ),
    grader<WritingReviewInput>(
      ({ output, workdir, test, graderFiles, judges }) => {
        const { cleaned } = harvest(graderFiles);
        if (cleaned === null) {
          return binary(true, "no cleaned version");
        }
        if (cleaned.trim() === "") {
          return judges.rubric({
            ...prompts.fixLandsOnDelete(),
            output: text(findings(output)),
          });
        }
        return judges.rubric({
          ...prompts.fixLands({ sourceFileText: getSourceFileText(workdir, test), cleaned }),
          output: text(findings(output)),
        });
      },
      { name: "fix-lands" },
    ),
    recommendsCuts(),
    advisoryUseful(),
    rewritesFaithful(),
  ];
}
