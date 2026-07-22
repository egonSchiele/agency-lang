import type { SourceLocation } from "../types/base.js";
import type { AgencyProgram } from "../types.js";
import type { LintDiagnosticName } from "./diagnostics.js";

/** The linter owns its own severity vocabulary. v1 only emits "hint". */
export type LintSeverity = "hint" | "info" | "warning";

/** A single text edit, as a half-open [start, end) offset range into the
 *  file's source. Deleting text is newText: "". */
export type LintEdit = { start: number; end: number; newText: string };

/** The automatic fix for a finding: a titled set of edits. */
export type LintFix = { title: string; edits: LintEdit[] };

/** One thing the linter noticed. Always carries a code (via the factory). */
export type LintFinding = {
  code: string;
  name: LintDiagnosticName;
  message: string;
  severity: LintSeverity;
  loc: SourceLocation;
  fix?: LintFix;
};

/** What a rule is given. `program` is parsed with the template OFF, so its
 *  `loc.start`/`loc.end` index into `source` and its import statements retain
 *  their locations. Rules that need scope or symbol information do not exist
 *  yet; when one does, extend this type in the same PR. */
export type LintContext = {
  program: AgencyProgram;
  source: string;
  filePath: string;
};

/** A rule: a pure function from context to findings, tied to its registry
 *  entry by `name`. */
export type LintRule = {
  name: LintDiagnosticName;
  run: (ctx: LintContext) => LintFinding[];
};
