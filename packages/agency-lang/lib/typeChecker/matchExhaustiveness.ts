import type { AgencyNode, Expression, VariableType } from "../types.js";
import type { MatchArmMeta, MatchBlockCase } from "../types/matchBlock.js";
import type { SourceLocation } from "../types/base.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import type { Scope } from "./scope.js";
import { walkNodes } from "../utils/node.js";
import { isInScope } from "./checker.js";
import { synthType } from "./synthesizer.js";
import { decomposeCases, type TypeCase, type CaseSet } from "./typeCases.js";

type Severity = "silent" | "warn" | "error";
type CaseValue = MatchArmMeta["caseValue"]; // MatchPattern | "_"
type NormalizedArm = { caseValue: CaseValue; guarded: boolean };
type MatchSite = {
  scrutineeType: VariableType | "any";
  arms: NormalizedArm[];
  loc: SourceLocation | undefined;
};

/** A literal match arm's static value, or null if the arm isn't a static literal. */
function armLiteral(cv: CaseValue): string | number | boolean | null {
  if (cv === "_") return null;
  if (cv.type === "number") return Number(cv.value);
  if (cv.type === "boolean") return cv.value;
  if (cv.type === "string") {
    const segs = cv.segments;
    if (segs.length === 1 && segs[0].type === "text") return segs[0].value;
    return null; // interpolated → not a static literal case
  }
  return null;
}

/** True for a catch-all arm: the `_` default, or an un-guarded bare binding. */
function isCatchAll(arm: NormalizedArm): boolean {
  if (arm.guarded) return false;
  if (arm.caseValue === "_") return true;
  // A bare variable/binding pattern matches anything.
  // Deliberately conservative: an empty `objectPattern` or a rest binding could
  // also match everything, but we DON'T treat those as catch-alls here — missing
  // them only suppresses the catch-all shortcut (→ at worst a missed "exhaustive"
  // when one isn't required), never a false "missing case".
  return arm.caseValue.type === "variableName";
}

/** Cases the un-guarded arms cover (B1: result patterns + literals). */
function coveredCases(arms: NormalizedArm[]): TypeCase[] {
  const covered: TypeCase[] = [];
  for (const arm of arms) {
    if (arm.guarded || arm.caseValue === "_") continue;
    const cv = arm.caseValue;
    if (cv.type === "resultPattern") {
      covered.push({ kind: cv.kind === "success" ? "resultSuccess" : "resultFailure" });
      continue;
    }
    const lit = armLiteral(cv);
    if (lit !== null) covered.push({ kind: "literal", value: lit });
  }
  return covered;
}

function caseKey(c: TypeCase): string {
  return c.kind === "literal" ? `literal:${typeof c.value}:${String(c.value)}` : c.kind;
}

function describeCase(c: TypeCase): string {
  switch (c.kind) {
    case "resultSuccess":
      return "`success`";
    case "resultFailure":
      return "`failure`";
    case "member":
      return "an object case";
    case "literal":
      return typeof c.value === "string" ? `"${c.value}"` : String(c.value);
  }
}

/**
 * The cases a closed-type match leaves uncovered, or [] when no requirement
 * applies: an open type, a union with any `member` case (B2 territory — no
 * covering-arm rule yet), or a catch-all arm all yield [].
 */
function missingCases(arms: NormalizedArm[], caseSet: CaseSet): TypeCase[] {
  if (!caseSet.closed) return [];
  if (caseSet.cases.some((c) => c.kind === "member")) return [];
  if (arms.some(isCatchAll)) return [];
  const covered = new Set(coveredCases(arms).map(caseKey));
  return caseSet.cases.filter((c) => !covered.has(caseKey(c)));
}

function checkSite(site: MatchSite, severity: Severity, ctx: TypeCheckerContext): void {
  const caseSet = decomposeCases(site.scrutineeType, ctx.getTypeAliases());
  const missing = missingCases(site.arms, caseSet);
  if (missing.length === 0) {
    return;
  }
  ctx.errors.push({
    message: `match is not exhaustive: missing ${missing.map(describeCase).join(", ")}.`,
    severity: severity === "warn" ? "warning" : "error",
    loc: site.loc,
  });
}

/** Normalize the two surviving match shapes to `(scrutineeType, arms)`. */
function normalizeSite(
  node: AgencyNode,
  scope: Scope,
  ctx: TypeCheckerContext,
): MatchSite | null {
  // Pattern-arm match: lowered to a `__scrutinee` temp carrying `matchSource`.
  if (node.type === "assignment" && node.matchSource) {
    // Synth the original scrutinee expression, NOT the temp's declared type:
    // the temp's inference widens a literal union (`"a" | "b"` → `string`),
    // which would make decomposeCases see an open type. `node.value` is the
    // lowered scrutinee, so its synthesized type preserves the literal union.
    const scrutineeType = synthType(node.value as Expression, scope, ctx);
    const arms = node.matchSource.map((a) => ({
      caseValue: a.caseValue,
      guarded: a.guard !== undefined,
    }));
    return { scrutineeType, arms, loc: node.loc };
  }
  // Literal/identifier passthrough: a surviving `matchBlock` node.
  if (node.type === "matchBlock") {
    const scrutineeType = synthType(node.expression as Expression, scope, ctx);
    const arms = node.cases
      .filter((c): c is MatchBlockCase => c.type === "matchBlockCase")
      .map((c) => ({ caseValue: c.caseValue, guarded: c.guard !== undefined }));
    return { scrutineeType, arms, loc: node.loc };
  }
  return null;
}

/**
 * Diagnostic: a `match` over a closed value type (Result or a closed
 * literal/value union) that doesn't cover every case and has no `_` arm.
 * Opt-in via `typechecker.matchExhaustiveness` (default `silent`). Conservative:
 * open types and non-discriminated object unions are never reported (B1).
 */
export function checkMatchExhaustiveness(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): void {
  const severity = (ctx.config.typechecker?.matchExhaustiveness ?? "silent") as Severity;
  if (severity === "silent") {
    return;
  }
  for (const info of scopes) {
    ctx.withScope(info.scopeKey, () => {
      for (const { node, scopes: nodeScopes } of walkNodes(info.body)) {
        if (!isInScope(nodeScopes, info)) {
          continue;
        }
        const site = normalizeSite(node, info.scope, ctx);
        if (site) {
          checkSite(site, severity, ctx);
        }
      }
    });
  }
}
