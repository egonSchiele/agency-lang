import type { SourceLocation } from "../types/base.js";
import { renderMessage } from "../typeChecker/diagnostics.js";
import type { LintFinding, LintFix } from "./types.js";

/**
 * The single source of truth for every lint finding the linter can emit.
 *
 * APPEND-ONLY: a shipped code is never renumbered or reused. A retired rule
 * keeps its entry with `retired: true` so the code stays reserved. Codes are
 * numbered sequentially (AL0001, AL0002, …) in the order rules are added.
 * This deliberately diverges from the type checker's prefix-range category
 * scheme (AG1xxx = types, AG4xxx = names, …): lint rules are few and flat,
 * so the code number carries no category meaning here.
 *
 * Message templates use {param} placeholders. Params are structured data
 * (a name, a count), never sentence fragments.
 */
export const LINT_DIAGNOSTICS = {
  unusedImport: {
    code: "AL0001",
    severity: "hint",
    message: "'{name}' is imported but never used.",
  },
} as const;

export type LintDiagnosticName = keyof typeof LINT_DIAGNOSTICS;

/** Build a fully-formed finding from a registry entry, stamping the code. */
export function lintDiagnostic(
  name: LintDiagnosticName,
  params: Record<string, string | number>,
  loc: SourceLocation,
  fix?: LintFix,
): LintFinding {
  const entry = LINT_DIAGNOSTICS[name];
  return {
    code: entry.code,
    name,
    message: renderMessage(entry.message, params),
    severity: entry.severity,
    loc,
    fix,
  };
}
