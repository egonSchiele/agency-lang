import { parseAgency } from "../parser.js";
import type { AgencyConfig } from "../config.js";
import type { LintContext, LintFinding, LintRule } from "./types.js";
import { unusedImportsRule } from "./rules/unusedImports.js";

/** Every enabled rule. Append a rule here to enable it. */
export const LINT_RULES: LintRule[] = [unusedImportsRule];

/** Run every rule over the context and concatenate their findings. */
export function runLinter(ctx: LintContext): LintFinding[] {
  return LINT_RULES.flatMap((rule) => rule.run(ctx));
}

/**
 * Parse `source` and lint it. Parses with the template OFF so every finding's
 * offsets index into `source` (docs/dev/locations.md). A file that does not
 * parse has no lint findings — the parser's own error is the user's problem
 * to fix first, and every caller of this function surfaces parse errors
 * through its own channel (CLI compile errors, LSP parse diagnostics).
 */
export function lintSource(
  source: string,
  filePath: string,
  config: AgencyConfig,
): LintFinding[] {
  const parsed = parseAgency(source, config, false);
  if (!parsed.success) {
    return [];
  }
  return runLinter({ program: parsed.result, source, filePath });
}
