import type { SourceLocation } from "../../types/base.js";
import type { DiagnosticName } from "../../typeChecker/diagnostics.js";

/**
 * Every way a splice can fail, from eligibility through execution to
 * grafting. Named for what it is — a diagnostic — rather than for
 * eligibility, because it also carries runtime failures (AG8008) and
 * post-graft name errors (AG8010), neither of which is an eligibility
 * question.
 */
export type SpliceDiagnostic = {
  diagnostic: DiagnosticName;
  params: Record<string, string>;
  loc: SourceLocation;
};

/**
 * Two shapes exist here, deliberately. A check has no value to report on
 * success, and forcing it into `SpliceResult<void>` reads worse than the
 * split. The rule is mechanical: if it JUDGES, it returns
 * `SpliceDiagnostic | null`; if it PRODUCES, it returns `SpliceResult<T>`.
 * Do not add a third.
 */
export type SpliceResult<T> = { ok: true; value: T } | { ok: false; diagnostic: SpliceDiagnostic };
