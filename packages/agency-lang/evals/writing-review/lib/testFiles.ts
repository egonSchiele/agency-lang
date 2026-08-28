// The test files both writing suites read: the reviewed text seeded into
// the workdir, the assignment, and for a harvested test the editor's notes
// and cleaned version in graderFiles/. The rewrite suite imports this by
// relative path, so the two suites grade against the same ground truth.
import * as fs from "fs";
import * as path from "path";

import type { Test } from "agency-lang/eval";

/** Mirrors `WritingReviewEvalInput` in stdlib/agents/writing/review.agency. */
export type WritingReviewInput = { assignment: string; sourceFile: string };
/** The reviewed text, read from the test's seeded workdir. Fixture paths
 *  are authored, but a path that escapes the workdir reads as missing. */
export function getSourceFileText(workdir: string, test: Test<WritingReviewInput>): string {
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

export function getAssignment(test: Test<WritingReviewInput>): string {
  return test.input?.assignment ?? "";
}

/** The editor's files for a harvested test, from its graderFiles/ directory:
 *  `notes.md` says what was wrong; `cleaned.md` is the text after editing,
 *  and an empty one means the text should not exist at all. */
export function harvest(graderFiles: string): { notes: string; cleaned: string | null } {
  if (graderFiles === "") {
    throw new Error("harvestedGraders needs a graderFiles/ directory holding notes.md");
  }
  const notes = fs.readFileSync(path.join(graderFiles, "notes.md"), "utf8");
  const cleanedFile = path.join(graderFiles, "cleaned.md");
  const cleaned = fs.existsSync(cleanedFile) ? fs.readFileSync(cleanedFile, "utf8") : null;
  return { notes, cleaned };
}

/** The editor's points from notes.md. A top-level bullet is a point, with
 *  its indented continuation lines. A prose paragraph is a point too; when
 *  it ends with a colon, the bullets under it belong to it. The judge is
 *  asked about each point on its own, so it cannot pad the list with the
 *  reviewer's findings. */
export function editorPoints(notes: string): string[] {
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
