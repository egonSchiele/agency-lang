import type { ResumeOverrides } from "../runtime/resumeSetup.js";

export type ResumeOverrideFlags = {
  localVar?: string[];
  arg?: string[];
  globalVar?: string[];
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
