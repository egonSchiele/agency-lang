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
  // is for.
  const [test] = loadInputs(testDir, undefined, { requireGoal: false });
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
  const locks: FormState["locks"] = { id: folder, files: filesLock(testDir, test, base) };
  if (structured) {
    locks.input = STRUCTURED_INPUT_LOCK;
  }
  const graders = gradersOf(testDir, test);
  const harnessGraded = (test.agencyTests ?? []).length > 0;
  return editingForm({ testDir, base, values, locks, harnessGraded, ...graders });
}

/** What the files row shows: the path the file names when it names one,
 *  else a count of the sibling `files/`, else `none`. The form models only
 *  the sibling folder, so a path elsewhere is shown as written. The sibling
 *  is checked by its own path, since the loader resolves a link. */
function filesLock(testDir: string, test: Test, base: Record<string, unknown>): string {
  if (typeof base.files === "string") {
    return base.files;
  }
  if (test.files === undefined) {
    return NO_FILES;
  }
  const sibling = path.join(testDir, "files");
  try {
    if (fs.lstatSync(sibling).isSymbolicLink()) {
      throw new Error(`files must not be a symlink: ${sibling}`);
    }
    return `files/ (${walkTreeRefusingSymlinks(sibling, "files").length} files)`;
  } catch (error) {
    return `files/ (could not be read: ${error instanceof Error ? error.message : String(error)})`;
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
    return { graders: [], gradersLock: `${path.relative(testDir, test.graders)}: edit the file` };
  }
  const specs = parseGradersJson(fs.readFileSync(sibling, "utf8"), sibling);
  return { graders: specs.map(draftFromSpec), gradersLock: null };
}
