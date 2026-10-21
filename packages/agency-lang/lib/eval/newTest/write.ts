// What `agency eval new` checks before it writes, and what it writes: a
// test folder holding `test.json` and, when a files directory was named, a
// copy of it as `files/`. The folder is assembled in a staging directory
// and renamed into place, so a failure part way leaves nothing behind.
import * as fs from "fs";
import * as path from "path";

import { graderProblem } from "@/eval/gradersJson/schema.js";
import { walkTreeRefusingSymlinks, type TreeFile } from "@/eval/grading/graderFilesSnapshot.js";
import { isStrictDescendant, safeDeleteDirectoryWithin } from "@/utils.js";

import {
  FIELDS,
  fieldSpec,
  type FieldName,
  type FormState,
  type Problem,
  type Row,
} from "./form.js";
import { questionsFor, specObjectFor, type GraderDraft } from "./graders.js";

/** A folder name the loader takes as a test id. */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const JSON_INDENT = 2;

/** The file-system questions validation asks, injectable so the pure cases
 *  test without a disk. `realPath` resolves every symlink in a path that
 *  exists. */
export type FileChecks = {
  exists: (file: string) => boolean;
  isDirectory: (file: string) => boolean;
  realPath: (file: string) => string;
};

export const realFileChecks: FileChecks = {
  exists: (file) => fs.existsSync(file),
  isDirectory: (file) => fs.existsSync(file) && fs.statSync(file).isDirectory(),
  realPath: (file) => fs.realpathSync(file),
};

/** A write that stopped for a reason the user can fix, naming the row. */
export class TestWriteError extends Error {
  constructor(
    public readonly row: Row,
    message: string,
  ) {
    super(message);
    this.name = "TestWriteError";
  }
}

export function testDirFor(suiteDir: string, id: string): string {
  return path.join(suiteDir, id);
}

/** Everything that would stop the write, in field order. */
function fieldRow(name: FieldName): Row {
  return { kind: "field", name };
}

export function validateForm(state: FormState, checks: FileChecks = realFileChecks): Problem[] {
  return [
    ...fieldProblems(state, checks).filter((problem) => !isLockedProblem(state, problem)),
    ...graderProblems(state.graders),
  ];
}

/** A locked field is not validated: the row cannot be reached, and what
 *  it shows is not a value. That is what skips the folder-name checks
 *  while editing. */
function isLockedProblem(state: FormState, problem: Problem): boolean {
  return problem.row.kind === "field" && state.locks[problem.row.name] !== undefined;
}

function fieldProblems(state: FormState, checks: FileChecks): Problem[] {
  const problems: Problem[] = [];
  const id = state.values.id;
  const idLabel = fieldSpec("id").label;
  if (id === "") {
    problems.push({ row: fieldRow("id"), text: `${idLabel} is required` });
  } else if (!ID_PATTERN.test(id)) {
    problems.push({
      row: fieldRow("id"),
      text: `${idLabel} may hold only letters, digits, - and _`,
    });
  } else if (checks.exists(testDirFor(state.suiteDir, id))) {
    problems.push({
      row: fieldRow("id"),
      text: `${testDirFor(state.suiteDir, id)} already exists`,
    });
  }
  const files = filesProblem(state, checks);
  if (files !== null) {
    problems.push(files);
  }
  // A goal is judged only when the test has no graders of its own, so it
  // is required only then: no grader in the section, no locked graders
  // file, and no harness pairs grading it.
  const graded =
    state.graders.length > 0 ||
    state.gradersLock !== null ||
    (state.editing?.harnessGraded ?? false);
  const required = FIELDS.filter(
    (spec) => spec.required && spec.name !== "id" && (spec.name !== "goal" || !graded),
  );
  for (const field of required) {
    if (state.values[field.name] === "") {
      problems.push({ row: fieldRow(field.name), text: `${field.label} is required` });
    }
  }
  return problems;
}

/** Every grader's first problem, in the parser's words, then the one check
 *  the parser makes only at file level: two graders with one name. The
 *  form holds no rule of its own about what a grader needs. */
function graderProblems(graders: GraderDraft[]): Problem[] {
  const own = graders.flatMap((draft, index): Problem[] => {
    const problem = graderProblem(specObjectFor(draft));
    return problem === null
      ? []
      : [{ row: rowForField(draft, index, problem.field), text: problem.text }];
  });
  return [...own, ...duplicateNames(graders)];
}

/** The row a parser problem is about. A field that names a shown question
 *  is that row; a repeating question's list key (`points`) is its first row
 *  (`point.0`); `kind` and a cross-field rule (`null`) are the kind row. */
function rowForField(draft: GraderDraft, index: number, field: string | null): Row {
  const questions = questionsFor(draft);
  const named = questions.find((question) => question.name === field);
  const first = questions.find(
    (question) => question.output === "list" && `${question.name.replace(/\.0$/, "")}s` === field,
  );
  const question = named ?? first;
  return { kind: "grader", index, question: question === undefined ? "kind" : question.name };
}

function duplicateNames(graders: GraderDraft[]): Problem[] {
  const names = graders.map((draft) => draft.answers.name ?? "");
  return names.flatMap((name, index): Problem[] =>
    name !== "" && names.indexOf(name) !== index
      ? [{ row: { kind: "grader", index, question: "name" }, text: `two graders named "${name}"` }]
      : [],
  );
}

/** The text of `graders.json` for the drafts. */
export function gradersJsonText(graders: GraderDraft[]): string {
  return `${JSON.stringify(graders.map(specObjectFor), null, JSON_INDENT)}\n`;
}

/** The files directory as typed, resolved against the suite; null when
 *  the field is empty. */
function filesDirFor(state: FormState): string | null {
  const typed = state.values.files;
  return typed === "" ? null : path.resolve(state.suiteDir, typed);
}

/** What stops the files directory being copied. It must sit inside the
 *  suite by name, exist as a directory, and be reached without a symlink:
 *  its real path must be the suite's real path plus the typed name, so a
 *  link anywhere on the way is refused rather than followed. */
function filesProblem(state: FormState, checks: FileChecks): Problem | null {
  const dir = filesDirFor(state);
  if (dir === null) {
    return null;
  }
  const suite = path.resolve(state.suiteDir);
  if (!isStrictDescendant(suite, dir)) {
    return { row: fieldRow("files"), text: "files must be a directory inside the suite" };
  }
  if (!checks.isDirectory(dir)) {
    return { row: fieldRow("files"), text: `${dir} is not a directory` };
  }
  const expected = path.join(checks.realPath(suite), path.relative(suite, dir));
  if (checks.realPath(dir) !== expected) {
    return { row: fieldRow("files"), text: `files must not be reached through a symlink: ${dir}` };
  }
  return null;
}

/** The `test.json` object: `base` (what the file held, when editing) with
 *  every written field set from its value, or deleted when the value is
 *  empty. `files` is never a key, because the loader finds `./files` on
 *  its own; an empty `input` is left out, because the loader refuses an
 *  empty string and reads a missing key as "takes no input". A locked
 *  field (a structured input) is left as the base has it. */
export function testJsonFor(
  values: Record<FieldName, string>,
  base: Record<string, unknown> = {},
  locks: FormState["locks"] = {},
): Record<string, unknown> {
  const written: FieldName[] = ["description", "input", "goal"];
  const out = { ...base };
  for (const field of written.filter((name) => locks[name] === undefined)) {
    if (values[field] === "") {
      delete out[field];
    } else {
      out[field] = values[field];
    }
  }
  return out;
}

type StagedFile = { name: string; text: string };

/** What a save writes: `test.json`, and `graders.json` when there is at
 *  least one grader. */
function stagedFiles(state: FormState): StagedFile[] {
  const base = state.editing === null ? {} : state.editing.base;
  const testJson = `${JSON.stringify(testJsonFor(state.values, base, state.locks), null, JSON_INDENT)}\n`;
  const files: StagedFile[] = [{ name: "test.json", text: testJson }];
  if (state.graders.length > 0) {
    files.push({ name: "graders.json", text: gradersJsonText(state.graders) });
  }
  return files;
}

/** How the staged files reach their place. `create` renames the whole
 *  staging folder into the suite as a new test. `replace` moves each file
 *  over its original in an existing test folder, one rename each. */
const COMMITS: Record<"create" | "replace", (staging: string, state: FormState) => string> = {
  create: (staging, state) => {
    const target = testDirFor(path.resolve(state.suiteDir), state.values.id);
    const files = filesDirFor(state);
    if (files !== null) {
      copyFiles(state, files, path.join(staging, "files"));
    }
    // A rename onto an existing empty directory can succeed silently, so the
    // check validation made is repeated right before the move.
    if (fs.existsSync(target)) {
      throw new TestWriteError(fieldRow("id"), `${target} already exists`);
    }
    fs.renameSync(staging, target);
    return target;
  },
  replace: (staging, state) => {
    const testDir = state.editing?.testDir ?? "";
    const names = ["test.json", "graders.json"];
    // Every target is checked before anything moves, so a failure here
    // leaves the originals as they were.
    for (const name of names) {
      assertReplaceable(path.join(testDir, name));
    }
    const staged = stagedFiles(state).map((file) => file.name);
    staged.forEach((name, i) => {
      try {
        fs.renameSync(path.join(staging, name), path.join(testDir, name));
      } catch (error) {
        const written = staged.slice(0, i).join(", ");
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(written === "" ? detail : `${detail} (${written} already written)`);
      }
    });
    const old = path.join(testDir, "graders.json");
    if (state.graders.length === 0 && fs.existsSync(old)) {
      // Last, so a failure above leaves it in place. It leaves with the
      // staging folder rather than through a delete helper: `safeDeleteFile`
      // refuses a path outside the nearest package, which every suite in a
      // temp directory is.
      fs.renameSync(old, path.join(staging, "graders.json.old"));
    }
    return testDir;
  },
};

/** A path a staged file may be renamed over: absent, or a plain file. */
function assertReplaceable(file: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new TestWriteError(
      fieldRow("goal"),
      `${file} is a symlink; the form will not replace it`,
    );
  }
  if (!stat.isFile()) {
    throw new TestWriteError(
      fieldRow("goal"),
      `${file} is not a file; the form will not replace it`,
    );
  }
}

/** Write the test and return its folder. Callers validate first; this
 *  re-checks only what a race could change. Both modes build the files in
 *  a staging folder under the suite; how they reach their place is the
 *  mode's entry in `COMMITS`. A problem the user can fix is thrown as a
 *  `TestWriteError` naming the row. */
export function writeTest(state: FormState): string {
  const suiteDir = path.resolve(state.suiteDir);
  const id = state.editing === null ? state.values.id : path.basename(state.editing.testDir);
  const staging = path.join(suiteDir, `.staging-${id}`);
  removeStaging(suiteDir, staging);
  fs.mkdirSync(staging);
  try {
    for (const file of stagedFiles(state)) {
      fs.writeFileSync(path.join(staging, file.name), file.text);
    }
    return COMMITS[state.editing === null ? "create" : "replace"](staging, state);
  } finally {
    removeStaging(suiteDir, staging);
  }
}

/** Copy the files directory byte for byte. The symlink rule is checked
 *  again here, because the directory could have changed since validation. */
function copyFiles(state: FormState, from: string, to: string): void {
  const problem = filesProblem(state, realFileChecks);
  if (problem !== null) {
    throw new TestWriteError(problem.row, problem.text);
  }
  // The folder is made first, so an empty files directory still gives the
  // test an empty `files/` rather than disappearing.
  fs.mkdirSync(to);
  for (const entry of filesToCopy(from)) {
    const destination = path.join(to, entry.rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(entry.full, destination);
  }
}

function filesToCopy(from: string): TreeFile[] {
  try {
    return walkTreeRefusingSymlinks(from, "files");
  } catch (error) {
    throw new TestWriteError(
      fieldRow("files"),
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Remove a staging folder, whether left by a crash or by this write
 *  failing. The delete refuses a file or a link that escapes the suite,
 *  and that refusal stops the write rather than being built on. */
function removeStaging(suiteDir: string, staging: string): void {
  if (!fs.existsSync(staging) && !isSymlink(staging)) {
    return;
  }
  const result = safeDeleteDirectoryWithin(suiteDir, staging);
  if (!result.success) {
    throw new TestWriteError(fieldRow("id"), result.message ?? `could not remove ${staging}`);
  }
}

function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** What to run next, shown after a save. */
export function nextCommands(suiteDir: string, id: string): string[] {
  return [
    `agency eval run <agent> --suite ${suiteDir} --test ${id} --out runs/<name>`,
    "agency eval grade runs/<name>",
  ];
}
