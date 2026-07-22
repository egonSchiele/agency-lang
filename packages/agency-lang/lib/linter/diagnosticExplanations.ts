import type { LintDiagnosticName } from "./diagnostics.js";

/** Long-form explanations for `agency explain <code>`, keyed by rule name. */
export const LINT_EXPLANATIONS: Record<LintDiagnosticName, string> = {
  unusedImport: `An import brings in a name the file never references. Unused
imports add noise and can hide a mistake (an import you meant to use). This is a
hint, not an error — the program still compiles and runs. The editor grays the
name out and offers "Remove unused import"; \`agency lint\` reports it. Names
imported from \`std::index\` and \`import test { … }\` imports are not reported.`,
};
