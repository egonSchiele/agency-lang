import { diagnostic } from "./diagnostics.js";
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
  /** True when the match is used in expression position (`const x = match(...)`).
   *  Expression matches must be exhaustive regardless of config — a missing case
   *  means the produced value is undefined at runtime, which is unsound. */
  isExpression: boolean;
};

/**
 * A static literal value from a pattern's `Literal` node, or null (interpolated
 * string, or a non-value literal / binding / nested pattern). THE single
 * expression-side literal extractor — used by both `armLiteral` and
 * `objectPatternDiscriminantValue`.
 */
function asStaticLiteral(v: Exclude<CaseValue, "_">): string | number | boolean | null {
  if (v.type === "number") return Number(v.value);
  if (v.type === "boolean") return v.value;
  if (v.type === "string") {
    const segs = v.segments;
    if (segs.length === 1 && segs[0].type === "text") return segs[0].value;
    return null; // interpolated → not a static literal case
  }
  return null;
}

/** A literal match arm's static value, or null if the arm isn't a static literal. */
function armLiteral(cv: CaseValue): string | number | boolean | null {
  return cv === "_" ? null : asStaticLiteral(cv);
}

/** The literal value an objectPattern arm pins property `prop` to, or null. */
function objectPatternDiscriminantValue(
  cv: CaseValue,
  prop: string,
): string | number | boolean | null {
  if (cv === "_" || cv.type !== "objectPattern") return null;
  for (const p of cv.properties) {
    if (p.type !== "objectPatternProperty" || p.key !== prop) continue;
    // value is BindingPattern | Literal | ResultPattern; only a Literal pins it.
    return asStaticLiteral(p.value);
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

type LiteralValue = string | number | boolean;

// Case identity keys. A value is tagged with its `typeof` so a numeric `1` and a
// string "1" never collide. An arm and a decomposed case are the "same case"
// iff their keys are equal.
function literalKey(value: LiteralValue): string {
  return `literal:${typeof value}:${String(value)}`;
}
function discriminatedMemberKey(prop: string, value: LiteralValue): string {
  return `member:${prop}:${typeof value}:${String(value)}`;
}

function caseKey(c: TypeCase): string {
  switch (c.kind) {
    case "resultSuccess":
    case "resultFailure":
      return c.kind;
    case "literal":
      return literalKey(c.value);
    case "member":
      // A discriminated member keys on its tag; an opaque member has no key an
      // arm can match (its coverage is never computed — the union bails).
      return c.disc ? discriminatedMemberKey(c.disc.prop, c.disc.value) : "member";
  }
}

function describeCase(c: TypeCase): string {
  switch (c.kind) {
    case "resultSuccess":
      return "`success`";
    case "resultFailure":
      return "`failure`";
    case "member":
      return c.disc ? `\`{ ${c.disc.prop}: ${JSON.stringify(c.disc.value)} }\`` : "an object case";
    case "literal":
      // JSON-encode so a string value renders quoted-and-escaped (a newline/quote
      // can't make the diagnostic multi-line or ambiguous); numbers/booleans print
      // bare (JSON.stringify(2) → "2", JSON.stringify(true) → "true").
      return JSON.stringify(c.value);
  }
}

/**
 * The single discriminant property shared by every member case, or null if the
 * members aren't a uniformly-discriminated set (an object union with no common
 * tag → un-checkable, B1 behavior).
 */
function sharedDiscriminant(memberCases: TypeCase[]): string | null {
  const first = memberCases[0];
  const prop = first.kind === "member" ? first.disc?.prop : undefined;
  if (prop === undefined) return null;
  const everyMemberSharesIt = memberCases.every(
    (c) => c.kind === "member" && c.disc?.prop === prop,
  );
  return everyMemberSharesIt ? prop : null;
}

/**
 * True if some un-guarded arm is an objectPattern that does NOT pin the
 * discriminant to a literal (e.g. `{ x }`, shorthand `{ kind }`, interpolated
 * `{ kind: "x${y}" }`). Such an arm could match several members, so we can't
 * prove any member is uncovered → the whole match must bail.
 */
function hasArmWithUnpinnedDiscriminant(arms: NormalizedArm[], prop: string): boolean {
  return arms.some(
    (arm) =>
      !arm.guarded &&
      !isCatchAll(arm) &&
      arm.caseValue !== "_" &&
      arm.caseValue.type === "objectPattern" &&
      objectPatternDiscriminantValue(arm.caseValue, prop) === null,
  );
}

/** The member keys covered by the un-guarded objectPattern arms (a guarded arm
 *  may not run, so it never counts toward coverage). */
function coveredMemberKeys(arms: NormalizedArm[], prop: string): Set<string> {
  const covered = new Set<string>();
  for (const arm of arms) {
    if (arm.guarded) continue;
    const pinnedValue = objectPatternDiscriminantValue(arm.caseValue, prop);
    if (pinnedValue !== null) covered.add(discriminatedMemberKey(prop, pinnedValue));
  }
  return covered;
}

/**
 * The cases a closed-type match leaves uncovered, or [] when no requirement
 * applies (open type or a catch-all arm). Object unions take the discriminated
 * path; Result / literal / boolean take the B1 path.
 */
function missingCases(arms: NormalizedArm[], caseSet: CaseSet): TypeCase[] {
  if (!caseSet.closed) return [];
  if (arms.some(isCatchAll)) return [];

  const memberCases = caseSet.cases.filter((c) => c.kind === "member");
  if (memberCases.length > 0) {
    const discriminant = sharedDiscriminant(memberCases);
    if (discriminant === null) return []; // non-discriminated object union
    if (hasArmWithUnpinnedDiscriminant(arms, discriminant)) return [];
    const covered = coveredMemberKeys(arms, discriminant);
    return caseSet.cases.filter((c) => !covered.has(caseKey(c)));
  }

  const covered = new Set(coveredCases(arms).map(caseKey));
  return caseSet.cases.filter((c) => !covered.has(caseKey(c)));
}

function checkSite(site: MatchSite, configured: Severity, ctx: TypeCheckerContext): void {
  // Expression matches are ALWAYS a hard error — a non-exhaustive expression
  // match yields `undefined` at runtime, which is unsound; config only tunes the
  // statement-match diagnostic.
  const severity: Severity = site.isExpression ? "error" : configured;
  if (severity === "silent") {
    return;
  }
  const caseSet = decomposeCases(site.scrutineeType, ctx.getTypeAliases());
  const missing = missingCases(site.arms, caseSet);
  if (missing.length === 0) {
    return;
  }
  ctx.errors.push(
    diagnostic(
      "matchNotExhaustive",
      { missing: missing.map(describeCase).join(", ") },
      site.loc ?? null,
      { severity: severity === "warn" ? "warning" : "error" },
    ),
  );
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
    return { scrutineeType, arms, loc: node.loc, isExpression: node.matchExprId !== undefined };
  }
  // Literal/identifier passthrough: a surviving `matchBlock` node.
  if (node.type === "matchBlock") {
    const scrutineeType = synthType(node.expression as Expression, scope, ctx);
    const arms = node.cases
      .filter((c): c is MatchBlockCase => c.type === "matchBlockCase")
      .map((c) => ({ caseValue: c.caseValue, guarded: c.guard !== undefined }));
    return { scrutineeType, arms, loc: node.loc, isExpression: node.matchExprId !== undefined };
  }
  return null;
}

/**
 * Diagnostic: a `match` over a closed value type (Result or a closed
 * literal/value union) that doesn't cover every case and has no `_` arm.
 * Enabled by default at `error`; configurable via
 * `typechecker.matchExhaustiveness` (`silent` / `warn` / `error`). Conservative:
 * open types and non-discriminated object unions are never reported (B1).
 */
export function checkMatchExhaustiveness(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): void {
  // Do NOT early-return on `silent`: expression matches are still hard-checked
  // per-site (checkSite decides the effective severity). Only statement sites
  // honor the configured value.
  const configured = (ctx.config.typechecker?.matchExhaustiveness ?? "error") as Severity;
  for (const info of scopes) {
    ctx.withScope(info.scopeKey, () => {
      for (const { node, scopes: nodeScopes } of walkNodes(info.body)) {
        if (!isInScope(nodeScopes, info)) {
          continue;
        }
        const site = normalizeSite(node, info.scope, ctx);
        if (site) {
          checkSite(site, configured, ctx);
        }
      }
    });
  }
}
