/**
 * Where a saved workflow is, from what a person typed: a path to its file,
 * or a bare name. A saved workflow is one file, `<dir>/workflows/<name>.json`,
 * and `<dir>` is the project directory its steps' modules are relative to.
 */
import fs from "fs";
import path from "path";
import { _workflowNameProblem } from "../../stdlib/workflow/parse.js";

const WORKFLOWS_DIR = "workflows";
const FILE_SUFFIX = ".json";

/** `dir` is the project directory, `name` the workflow's name, and `file`
 *  the absolute path of its JSON file. */
export type WorkflowFile = { dir: string; name: string; file: string };
export type Located = { found: WorkflowFile; error: null } | { found: null; error: string };

/** A workflow named by its file, `<dir>/workflows/<name>.json`, or by a
 *  bare name in `<cwd>/workflows`. */
export function locateWorkflow(arg: string, cwd: string): Located {
  if (!arg.endsWith(FILE_SUFFIX)) {
    return checked(arg, cwd, path.join(cwd, WORKFLOWS_DIR, `${arg}${FILE_SUFFIX}`), arg);
  }
  const file = path.resolve(cwd, arg);
  const folder = path.dirname(file);
  if (path.basename(folder) !== WORKFLOWS_DIR) {
    return refused(
      `${arg} is not in a folder named ${WORKFLOWS_DIR}; a saved workflow is <project>/${WORKFLOWS_DIR}/<name>${FILE_SUFFIX}`,
    );
  }
  return checked(path.basename(file, FILE_SUFFIX), path.dirname(folder), file, arg);
}

/** The name is checked as `loadWorkflow` checks it, so `../x` names no file
 *  outside the folder. The file must be a regular file, not a link. */
function checked(name: string, dir: string, file: string, arg: string): Located {
  const problem = _workflowNameProblem(name);
  if (problem !== null) {
    return refused(problem);
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return refused(`no workflow at ${arg === name ? path.relative(dir, file) : arg}`);
  }
  if (stat.isSymbolicLink()) {
    return refused(`${arg} is a symbolic link; a workflow file must be a regular file`);
  }
  if (!stat.isFile()) {
    return refused(`${arg} is not a regular file`);
  }
  return { found: { dir, name, file }, error: null };
}

function refused(error: string): Located {
  return { found: null, error };
}
