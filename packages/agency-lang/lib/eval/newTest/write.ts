// What `agency eval new` checks before it writes, and what it writes: a
// test folder holding `test.json` and, when a files directory was named, a
// copy of it as `files/`. The folder is assembled in a staging directory
// and renamed into place, so a failure part way leaves nothing behind.
import * as fs from "fs";
import * as path from "path";

import { readTreeRefusingSymlinks } from "@/eval/grading/graderFilesSnapshot.js";
import { safeDeleteDirectoryWithin } from "@/utils.js";

import { FIELDS, type FieldName, type FormState, type Problem } from "./form.js";

/** A folder name the loader takes as a test id. */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const JSON_INDENT = 2;

/** The file-system questions validation asks, injectable so the pure cases
 *  test without a disk. */
export type FileChecks = {
  exists: (file: string) => boolean;
  isDirectory: (file: string) => boolean;
};

export const realFileChecks: FileChecks = {
  exists: (file) => fs.existsSync(file),
  isDirectory: (file) => fs.existsSync(file) && fs.statSync(file).isDirectory(),
};

export function testDirFor(suiteDir: string, id: string): string {
  return path.join(suiteDir, id);
}

/** Everything that would stop the write, in field order. */
export function validateForm(state: FormState, checks: FileChecks = realFileChecks): Problem[] {
  const problems: Problem[] = [];
  const id = state.values.id;
  if (id === "") {
    problems.push({ field: "id", text: "id is required" });
  } else if (!ID_PATTERN.test(id)) {
    problems.push({ field: "id", text: "id may hold only letters, digits, - and _" });
  } else if (checks.exists(testDirFor(state.suiteDir, id))) {
    problems.push({ field: "id", text: `${testDirFor(state.suiteDir, id)} already exists` });
  }
  const files = filesDirFor(state);
  if (files.kind === "outside") {
    problems.push({ field: "files", text: "files must be a directory inside the suite" });
  } else if (files.kind === "named" && !checks.isDirectory(files.dir)) {
    problems.push({ field: "files", text: `${files.dir} is not a directory` });
  }
  for (const field of FIELDS.filter((spec) => spec.required && spec.name !== "id")) {
    if (state.values[field.name] === "") {
      problems.push({ field: field.name, text: `${field.label} is required` });
    }
  }
  return problems;
}

type FilesDir = { kind: "none" } | { kind: "named"; dir: string } | { kind: "outside" };

/** The files directory as typed, resolved against the suite. A path that
 *  leaves the suite is refused rather than copied from wherever it points. */
function filesDirFor(state: FormState): FilesDir {
  const typed = state.values.files;
  if (typed === "") {
    return { kind: "none" };
  }
  const suite = path.resolve(state.suiteDir);
  const dir = path.resolve(suite, typed);
  const relative = path.relative(suite, dir);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { kind: "outside" };
  }
  return { kind: "named", dir };
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
 *  re-checks only what a race could change. */
export function writeTest(state: FormState): string {
  const suiteDir = path.resolve(state.suiteDir);
  const id = state.values.id;
  const target = testDirFor(suiteDir, id);
  const staging = path.join(suiteDir, `.staging-${id}`);
  if (fs.existsSync(staging)) {
    safeDeleteDirectoryWithin(suiteDir, staging);
  }
  fs.mkdirSync(staging, { recursive: true });
  const json = `${JSON.stringify(testJsonFor(state.values), null, JSON_INDENT)}\n`;
  fs.writeFileSync(path.join(staging, "test.json"), json);
  const files = filesDirFor(state);
  if (files.kind === "named") {
    for (const entry of readTreeRefusingSymlinks(files.dir, "files")) {
      const destination = path.join(staging, "files", entry.rel);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, entry.content);
    }
  }
  // A rename onto an existing empty directory can succeed silently, so the
  // check validation made is repeated right before the move.
  if (fs.existsSync(target)) {
    safeDeleteDirectoryWithin(suiteDir, staging);
    throw new Error(`${target} already exists`);
  }
  fs.renameSync(staging, target);
  return target;
}

/** What to run next, shown after a save. */
export function nextCommands(suiteDir: string, id: string): string[] {
  return [
    `agency eval run <agent> --suite ${suiteDir} --test ${id} --out runs/<name>`,
    "agency eval grade runs/<name>",
  ];
}
