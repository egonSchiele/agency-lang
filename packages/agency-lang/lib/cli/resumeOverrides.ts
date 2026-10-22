import fs from "node:fs";
import path from "node:path";
import type { ResumeOverrides } from "../runtime/resumeSetup.js";
import {
  checkpointEditSchema,
  checkpointEditsSchema,
  type CheckpointEdit,
} from "../runtime/state/checkpointPatch/index.js";

export type ResumeOverrideFlags = {
  localVar?: string[];
  arg?: string[];
  globalVar?: string[];
  /** Each `--edit`, one edit as JSON. */
  edit?: string[];
  /** `--edits`, a file holding a JSON array of edits. */
  edits?: string;
};

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseAssignments(values: string[] | undefined, flag: string): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const assignment of values ?? []) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      throw new Error(`${flag} expects name=value (got "${assignment}")`);
    }
    const name = assignment.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === "__proto__") {
      throw new Error(`${flag} has an invalid Agency variable name: "${name}"`);
    }
    result[name] = parseValue(assignment.slice(separator + 1));
  }
  return result;
}

export function parseResumeOverrides(flags: ResumeOverrideFlags): ResumeOverrides {
  return {
    locals: parseAssignments(flags.localVar, "--local-var"),
    args: parseAssignments(flags.arg, "--arg"),
    globals: parseAssignments(flags.globalVar, "--global-var"),
  };
}

/** The schema's complaint about one edit, in the flag's words. */
function issuesOf(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.map(String).join(".");
      return where === "" ? issue.message : `${where}: ${issue.message}`;
    })
    .join("; ");
}

/** The edits `--edit` and `--edits` name, in that order, each checked
 *  against the edit schema here so a wrong shape is refused before the
 *  program starts. `--edits` is read relative to `cwd`. */
export function parseResumeEdits(
  flags: ResumeOverrideFlags,
  cwd = process.cwd(),
): CheckpointEdit[] {
  const edits: CheckpointEdit[] = [];
  for (const raw of flags.edit ?? []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`--edit is not valid JSON: ${String(error)}`);
    }
    const checked = checkpointEditSchema.safeParse(parsed);
    if (!checked.success) throw new Error(`--edit is not an edit: ${issuesOf(checked.error)}`);
    edits.push(checked.data);
  }
  if (flags.edits !== undefined) {
    const file = path.resolve(cwd, flags.edits);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`--edits could not read ${file}: ${String(error)}`);
    }
    const checked = checkpointEditsSchema.safeParse(parsed);
    if (!checked.success) {
      throw new Error(`--edits ${file} is not a list of edits: ${issuesOf(checked.error)}`);
    }
    edits.push(...checked.data);
  }
  return edits;
}
