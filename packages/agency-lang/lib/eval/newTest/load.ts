// A test folder becomes a form for `agency eval edit`. The loader in
// `lib/eval/loadInputs.ts` already knows what a test folder is, so it is
// asked first and every refusal it makes is inherited. What is left is the
// form's own: the fields it shows, the rows it locks, and the graders it
// can edit.
import * as fs from "fs";
import * as path from "path";

import { parseGradersJson } from "@/eval/gradersJson/schema.js";
import { walkTreeRefusingSymlinks } from "@/eval/grading/graderFilesSnapshot.js";
import { loadInputs } from "@/eval/loadInputs.js";
import type { Test } from "@/eval/runTypes.js";
import { sanitizeUntrusted } from "@/tui/untrusted.js";

import { editingForm, type FieldName, type FormState } from "./form.js";
import { draftFromSpec, type GraderDraft } from "./graders.js";

export const STRUCTURED_INPUT_LOCK = "structured input: edit the file";
const NO_FILES = "none";

export function loadTestForm(testDirAsGiven: string): FormState {
  // Resolved once, so `.` names the folder and every path comparison below
  // is absolute against absolute (the loader resolves what it returns).
  const testDir = path.resolve(testDirAsGiven);
  if (!fs.existsSync(testDir) || !fs.statSync(testDir).isDirectory()) {
    throw new Error(`${testDir} is not a directory`);
  }
  const testJson = path.join(testDir, "test.json");
  if (!fs.existsSync(testJson)) {
    throw new Error(`${testDir} has no test.json; eval edit opens one test folder`);
  }
  // A goal is not required here: a test that lacks one is what the form
  // is for. The files entry is not resolved: the form shows it as written,
  // and resolving a git source would clone it to draw a row.
  const [test] = loadInputs(testDir, undefined, { requireGoal: false, skipFiles: true });
  const base = JSON.parse(fs.readFileSync(testJson, "utf8")) as Record<string, unknown>;
  if (base.rubric !== undefined) {
    throw new Error(`${testJson} has a rubric; this form edits goal`);
  }
  const folder = path.basename(testDir);
  if (typeof base.id === "string" && base.id !== folder) {
    throw new Error(
      `${testJson} names id "${base.id}" but the folder is "${folder}"; rename the folder or the id`,
    );
  }
  const structured = typeof test.input === "object";
  const values: Record<FieldName, string> = {
    id: "",
    description: test.description ?? "",
    input: typeof test.input === "string" ? test.input : "",
    files: "",
    goal: test.goal ?? "",
  };
  const locks: FormState["locks"] = { id: folder, files: filesLock(testDir, base) };
  if (structured) {
    locks.input = STRUCTURED_INPUT_LOCK;
  }
  const graders = gradersOf(testDir, test);
  const harnessGraded = (test.agencyTests ?? []).length > 0;
  return editingForm({ testDir, base, values, locks, harnessGraded, ...graders });
}

/** What the files row shows: a count of the sibling `files/` when the
 *  file names it or names nothing and it exists, else the path the file
 *  names as written, else `none`. The form models only the sibling folder,
 *  so a path elsewhere is shown and not read. Lock text is drawn by the
 *  style parser, so a name from the file is sanitized here. */
function filesLock(testDir: string, base: Record<string, unknown>): string {
  const sibling = path.join(testDir, "files");
  if (typeof base.files === "string" && path.resolve(testDir, base.files) !== sibling) {
    return sanitizeUntrusted(base.files);
  }
  if (typeof base.files !== "string" && !fs.existsSync(sibling)) {
    return NO_FILES;
  }
  try {
    if (fs.lstatSync(sibling).isSymbolicLink()) {
      throw new Error(`files must not be a symlink: ${sibling}`);
    }
    return `files/ (${walkTreeRefusingSymlinks(sibling, "files").length} files)`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return sanitizeUntrusted(`files/ (could not be read: ${detail})`);
  }
}

/** The graders the form can edit: a sibling `graders.json` is read into
 *  drafts. Any other graders file locks the section, because a
 *  `graders.json` the form wrote would be ignored while `graders` points
 *  elsewhere. */
function gradersOf(
  testDir: string,
  test: Test,
): { graders: GraderDraft[]; gradersLock: string | null } {
  if (test.graders === undefined) {
    return { graders: [], gradersLock: null };
  }
  const sibling = path.join(testDir, "graders.json");
  if (path.resolve(test.graders) !== sibling) {
    const shown = sanitizeUntrusted(path.relative(testDir, test.graders));
    return { graders: [], gradersLock: `${shown}: edit the file` };
  }
  const specs = parseGradersJson(fs.readFileSync(sibling, "utf8"), sibling);
  return { graders: specs.map(draftFromSpec), gradersLock: null };
}
