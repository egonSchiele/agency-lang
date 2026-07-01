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

function caseKey(c: TypeCase): string {
  if (c.kind === "literal") return `literal:${typeof c.value}:${String(c.value)}`;
  if (c.kind === "member" && c.disc) return `member:${c.disc.prop}:${typeof c.disc.value}:${String(c.disc.value)}`;
  return c.kind; // resultSuccess/resultFailure, or an opaque member (no disc)
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
 * The cases a closed-type match leaves uncovered, or [] when no requirement
 * applies (open type, non-discriminated object union, or a catch-all arm).
 *
 * Object-union path (B2): if every `member` case carries the SAME discriminant
 * prop, an un-guarded `objectPattern` arm that pins that prop to a literal
 * covers the matching member. Bail (no diagnostic) if the union isn't
 * discriminated, or if any un-guarded, non-catch-all arm is an `objectPattern`
 * that does NOT pin the discriminant (it could match several members → we can't
 * prove non-coverage). Guarded arms never cover.
 */
function missingCases(arms: NormalizedArm[], caseSet: CaseSet): TypeCase[] {
  if (!caseSet.closed) return [];
  if (arms.some(isCatchAll)) return [];

  const memberCases = caseSet.cases.filter((c) => c.kind === "member");
  if (memberCases.length > 0) {
    const disc = memberCases[0].kind === "member" ? memberCases[0].disc : undefined;
    const allDisc =
      disc !== undefined &&
      memberCases.every((c) => c.kind === "member" && c.disc !== undefined && c.disc.prop === disc.prop);
    if (!allDisc) return []; // non-discriminated object union → un-checkable (B1)
    const ambiguous = arms.some(
      (a) =>
        !a.guarded &&
        !isCatchAll(a) &&
        a.caseValue !== "_" &&
        a.caseValue.type === "objectPattern" &&
        objectPatternDiscriminantValue(a.caseValue, disc.prop) === null,
    );
    if (ambiguous) return [];
    const covered = new Set(
      arms
        .filter((a) => !a.guarded)
        .map((a) => objectPatternDiscriminantValue(a.caseValue, disc.prop))
        .filter((v): v is string | number | boolean => v !== null)
        .map((v) => `member:${disc.prop}:${typeof v}:${String(v)}`),
    );
    return caseSet.cases.filter((c) => !covered.has(caseKey(c)));
  }

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
  const severity = (ctx.config.typechecker?.matchExhaustiveness ?? "warn") as Severity;
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
