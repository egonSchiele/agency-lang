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
import {
  KIND_NEEDED,
  kindOf,
  questionForField,
  specObjectFor,
  type GraderDraft,
} from "./graders.js";

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
  // is required only then.
  const required = FIELDS.filter(
    (spec) =>
      spec.required && spec.name !== "id" && (spec.name !== "goal" || state.graders.length === 0),
  );
  for (const field of required) {
    if (state.values[field.name] === "") {
      problems.push({ row: fieldRow(field.name), text: `${field.label} is required` });
    }
  }
  return [...problems, ...graderProblems(state.graders)];
}

/** Every grader's first problem, in the parser's words, then the one check
 *  the parser makes only at file level: two graders with one name. The
 *  form holds no rule of its own about what a grader needs; the one
 *  message it words itself is for a kind not picked yet, where the
 *  parser's `unknown kind ""` would not say what to do. */
function graderProblems(graders: GraderDraft[]): Problem[] {
  const own = graders.flatMap((draft, index): Problem[] => {
    if (kindOf(draft) === null) {
      return [{ row: { kind: "grader", index, question: "kind" }, text: KIND_NEEDED }];
    }
    const problem = graderProblem(specObjectFor(draft));
    return problem === null
      ? []
      : [{ row: rowForField(draft, index, problem.field), text: problem.text }];
  });
  return [...own, ...duplicateNames(graders)];
}

/** The row a parser problem is about: the row `graders.ts` finds for the
 *  field, or the kind row for `kind` and for a cross-field rule (`null`). */
function rowForField(draft: GraderDraft, index: number, field: string | null): Row {
  const question = field === null ? null : questionForField(draft, field);
  return { kind: "grader", index, question: question === null ? "kind" : question.name };
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

/** The `test.json` object: every field with a value, under the key the
 *  loader reads. `files` is never a key, because the loader finds `./files`
 *  on its own; an empty `input` is left out, because the loader refuses an
 *  empty string and reads a missing key as "takes no input". */
export function testJsonFor(values: Record<FieldName, string>): Record<string, string> {
  const written: FieldName[] = ["description", "input", "goal"];
  return Object.fromEntries(
    written.filter((field) => values[field] !== "").map((field) => [field, values[field]]),
  );
}

/** Write the test folder and return its path. Callers validate first; this
 *  re-checks only what a race could change. A problem the user can fix is
 *  thrown as a `TestWriteError` naming the field. */
export function writeTest(state: FormState): string {
  const suiteDir = path.resolve(state.suiteDir);
  const id = state.values.id;
  const target = testDirFor(suiteDir, id);
  const staging = path.join(suiteDir, `.staging-${id}`);
  removeStaging(suiteDir, staging);
  fs.mkdirSync(staging);
  try {
    const json = `${JSON.stringify(testJsonFor(state.values), null, JSON_INDENT)}\n`;
    fs.writeFileSync(path.join(staging, "test.json"), json);
    if (state.graders.length > 0) {
      fs.writeFileSync(path.join(staging, "graders.json"), gradersJsonText(state.graders));
    }
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
  } catch (error) {
    removeStaging(suiteDir, staging);
    throw error;
  }
  return target;
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
