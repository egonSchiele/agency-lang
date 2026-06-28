import type { AgencyNode, Expression, TypeAliasEntry, IfElse, VariableType } from "../types.js";
import type {
  ResultType,
  StringLiteralType,
  NumberLiteralType,
  BooleanLiteralType,
} from "../types/typeHints.js";
import { Scope } from "./scope.js";
import { walkNodes } from "../utils/node.js";
import { safeResolveType } from "./assignability.js";
import { literalToType } from "./literalType.js";
import { unescapeStringLiteralValue } from "../parsers/parsers.js";

/**
 * What a candidate narrows to. Tagged so a new narrowing form slots in as one
 * `narrowers`-table entry without touching the apply loop. `resultBranch` is
 * the `isSuccess`/`isFailure` Result narrowing; `discriminant` filters a union
 * by `v.prop == literal`.
 */
export type Refine =
  | { kind: "resultBranch"; branch: "success" | "failure" }
  | {
      kind: "discriminant";
      prop: string;
      literal: StringLiteralType | NumberLiteralType | BooleanLiteralType;
      keep: boolean;
    };
export type NarrowCandidate = { variableName: string; refine: Refine };
export type ConditionFacts = { then: NarrowCandidate[]; else: NarrowCandidate[] };

const NO_FACTS: ConditionFacts = { then: [], else: [] };

// "what": given a refine + the variable's current (pre-resolved) type, the
// narrowed type, or null for "no narrowing". The "how" (child scope,
// reassignment gate, declareLocal) lives in applyNarrowing.
const narrowers: {
  [K in Refine["kind"]]: (
    refine: Extract<Refine, { kind: K }>,
    current: VariableType,
    aliases: Record<string, TypeAliasEntry>,
  ) => VariableType | null;
} = {
  resultBranch: (r, current, aliases) => {
    const resolved = safeResolveType(current, aliases);
    return resolved.type === "resultType" ? narrowToBranch(resolved, r.branch) : null;
  },
  discriminant: (r, current, aliases) =>
    narrowUnionByDiscriminant(current, r.prop, r.literal, r.keep, aliases),
};

/**
 * Recognize a single `v.prop` member access over a *bare variable* (exactly one
 * property hop). Returns null for anything else — nested access (`a.b.c`), a
 * non-variable base, index/call chains, etc. Variable-keyed only, so the
 * narrowed scrutinee is statically the same binding at the access site.
 */
function asDiscriminantAccess(
  e: Expression,
): { variableName: string; prop: string } | null {
  if (e.type !== "valueAccess") return null;
  if (e.base.type !== "variableName") return null;
  if (e.chain.length !== 1) return null;
  const el = e.chain[0];
  if (el.kind !== "property") return null;
  return { variableName: e.base.value, prop: el.name };
}

/**
 * Inspect a (post-lowering) boolean condition and report the narrowing
 * candidates it implies for the then- and else-branches.
 *
 * Increment 1 recognizes a single `isSuccess(x)` / `isFailure(x)` guard where
 * `x` is a bare variable. Both names are RESERVED_FUNCTION_NAMES
 * (lib/typeChecker/resolveCall.ts) and cannot be user-redefined, so matching on
 * the function name is unambiguous — no resolveCall lookup is required.
 */
export function analyzeCondition(condition: Expression): ConditionFacts {
  // Boolean combinators (the parser desugars `!x` into a binOpExpression of
  // the form { operator: "!", left: <true>, right: x }, so the operand is
  // `.right`). These are the standard sound narrowing rules:
  //   !c        → swap then/else
  //   a && b    → then = then(a) ∪ then(b); else unknown (both could be false)
  //   a || b    → else = else(a) ∪ else(b); then unknown (either could be true)
  if (condition.type === "binOpExpression") {
    if (condition.operator === "!") {
      const inner = analyzeCondition(condition.right);
      return { then: inner.else, else: inner.then };
    }
    if (condition.operator === "&&") {
      const l = analyzeCondition(condition.left);
      const r = analyzeCondition(condition.right);
      return { then: [...l.then, ...r.then], else: [] };
    }
    if (condition.operator === "||") {
      const l = analyzeCondition(condition.left);
      const r = analyzeCondition(condition.right);
      return { then: [], else: [...l.else, ...r.else] };
    }
    if (condition.operator === "==" || condition.operator === "!=") {
      // `v.prop == literal` / `!= literal` over a bare variable. Either operand
      // order is accepted. then-branch keeps the matching member(s) for `==`
      // (and the complement for `!=`); the else-branch is the inverse.
      const acc = asDiscriminantAccess(condition.left) ?? asDiscriminantAccess(condition.right);
      const lit = literalToType(condition.right) ?? literalToType(condition.left);
      if (!acc || !lit) return NO_FACTS;
      const keepThen = condition.operator === "==";
      const mk = (keep: boolean): NarrowCandidate => ({
        variableName: acc.variableName,
        refine: { kind: "discriminant", prop: acc.prop, literal: lit, keep },
      });
      return { then: [mk(keepThen)], else: [mk(!keepThen)] };
    }
    return NO_FACTS;
  }

  if (condition.type !== "functionCall") return NO_FACTS;
  const fn = condition.functionName;
  if (fn !== "isSuccess" && fn !== "isFailure") return NO_FACTS;
  if (condition.arguments.length !== 1) return NO_FACTS;
  const arg = condition.arguments[0];
  if (arg.type !== "variableName") return NO_FACTS;
  const name = arg.value;
  const thenBranch = fn === "isSuccess" ? "success" : "failure";
  const elseBranch = fn === "isSuccess" ? "failure" : "success";
  return {
    then: [{ variableName: name, refine: { kind: "resultBranch", branch: thenBranch } }],
    else: [{ variableName: name, refine: { kind: "resultBranch", branch: elseBranch } }],
  };
}

/** Return a copy of a ResultType tagged as narrowed to one branch. */
export function narrowToBranch(rt: ResultType, branch: "success" | "failure"): ResultType {
  return { ...rt, narrowedBranch: branch };
}

/**
 * Does a member's discriminant-property type equal the tested literal?
 * `"yes"`/`"no"` only when the property is itself the *same kind* of literal
 * type; anything else (a non-literal prop type, a union, a different literal
 * kind) is `"unknown"` — which keeps the member on both sides, preserving
 * soundness.
 */
function literalTypeMatches(
  t: VariableType,
  literal: StringLiteralType | NumberLiteralType | BooleanLiteralType,
  aliases: Record<string, TypeAliasEntry>,
): "yes" | "no" | "unknown" {
  const r = safeResolveType(t, aliases);
  if (r.type !== literal.type) return "unknown"; // non-literal prop, literal union, or kind mismatch
  return literalValuesEqual(r, literal) ? "yes" : "no";
}

/**
 * Compare two same-kind literal-type values, normalizing for the fact that the
 * member's type-position value (`a`) is parsed differently from the
 * expression-position discriminant (`b`):
 *  - strings: the type parser captures escapes raw (`a\tb`) while the
 *    expression parser unescapes them (`a⇥b`) — unescape `a` before comparing,
 *    or an escaped discriminant tag would wrongly drop the matching member.
 *  - numbers: compare numerically so `1` and `1.0` (both valid literal tags)
 *    are equal despite different source text.
 *  - booleans: already canonical (`"true"`/`"false"`).
 */
function literalValuesEqual(
  a: StringLiteralType | NumberLiteralType | BooleanLiteralType,
  b: StringLiteralType | NumberLiteralType | BooleanLiteralType,
): boolean {
  if (a.type === "stringLiteralType") {
    return unescapeStringLiteralValue(a.value) === b.value;
  }
  if (a.type === "numberLiteralType") {
    return Number(a.value) === Number(b.value);
  }
  return a.value === b.value;
}

/**
 * Filter a union's members by `prop == literal` (keep) or `prop != literal`
 * (!keep). Sound/conservative: drops only provably-excluded members; never
 * narrows to `never`; non-union → null (no narrowing).
 */
export function narrowUnionByDiscriminant(
  type: VariableType,
  prop: string,
  literal: StringLiteralType | NumberLiteralType | BooleanLiteralType,
  keep: boolean,
  aliases: Record<string, TypeAliasEntry>,
): VariableType | null {
  const resolved = safeResolveType(type, aliases);
  if (resolved.type !== "unionType") return null;
  const members = resolved.types;
  const kept = members.filter((m) => {
    const rm = safeResolveType(m, aliases);
    const propType =
      rm.type === "objectType"
        ? rm.properties.find((p) => p.key === prop)?.value
        : undefined;
    const match = propType ? literalTypeMatches(propType, literal, aliases) : "unknown";
    return keep ? match !== "no" : match !== "yes";
  });
  if (kept.length === members.length || kept.length === 0) return null;
  return kept.length === 1 ? kept[0] : { type: "unionType", types: kept };
}

/**
 * Conservative "this body always transfers control out of the enclosing
 * function" check. Increment 2 counts ONLY `return`: `raise` (interrupt) can
 * resume and continue, and `propagate` semantics are likewise non-trivial, so
 * treating either as an exit could be unsound. False negatives are fine — they
 * only cost a missed narrowing, never a wrong one.
 */
export function alwaysExits(body: AgencyNode[]): boolean {
  return body.some(
    (node) =>
      node.type === "returnStatement" ||
      (node.type === "ifElse" &&
        !!node.elseBody &&
        alwaysExits(node.thenBody) &&
        alwaysExits(node.elseBody)),
  );
}

/**
 * Facts that hold for the statements *after* an `if`, given which branch (if
 * any) always exits. If the then-branch exits and the else doesn't (or is
 * absent), reaching the after-code means the condition was false → else-facts.
 * Symmetrically for an exiting else-branch. If both or neither exit, nothing
 * is known (both-exit ⇒ after-code is dead; neither ⇒ both paths merge).
 */
export function postGuardFacts(node: IfElse, facts: ConditionFacts): NarrowCandidate[] {
  const thenExits = alwaysExits(node.thenBody);
  const elseExits = !!node.elseBody && alwaysExits(node.elseBody);
  if (thenExits && !elseExits) return facts.else;
  if (elseExits && !thenExits) return facts.then;
  return [];
}

/**
 * Apply narrowing candidates to a fresh child scope for one branch body.
 *
 * Soundness gate: if the branch reassigns the variable (`r = ...`) ANYWHERE
 * in its whole body, skip narrowing it — its type may change mid-branch.
 *
 * Two intentional sources of imprecision (both conservative — false negatives,
 * never false positives, so soundness is preserved):
 *  1. The scan is whole-body. A reassignment buried in a nested `if`'s OTHER
 *     branch still blocks narrowing in the access site. A future increment
 *     could thread a flow analysis here; not worth it yet.
 *  2. `walkNodes` doesn't know about scoping, so a `for (r in xs)` iterator
 *     or a nested function that shadows `r` would also trip the gate.
 *
 * Refinements are written with declareLocal so they vanish when the child
 * scope is dropped at branch exit and never leak to the function scope.
 *
 * A `let r2 = r` inside a narrowed branch does NOT propagate the marker
 * outside the block: `scope.declare()` calls `widenType()`, which for
 * `resultType` rebuilds the object without `narrowedBranch`
 * (assignability.ts:370). `r2.value` outside the block is therefore the
 * usual un-narrowed `any`. Locked in by a test in narrowing.test.ts.
 */
export function applyNarrowing(
  childScope: Scope,
  candidates: NarrowCandidate[],
  branchBody: AgencyNode[],
  typeAliases: Record<string, TypeAliasEntry>,
): void {
  for (const cand of candidates) {
    const current = childScope.lookup(cand.variableName);
    if (!current || current === "any") continue;
    // "what to narrow to" is delegated to the refine's narrower. Each narrower
    // resolves through type-alias variables itself (mirrors synthValueAccess) so
    // alias-typed scrutinees still narrow; null means "leave the type as-is".
    // Run it first: most `v.prop == literal` candidates aren't unions and bail
    // here, so we skip the (more expensive) whole-body reassignment walk.
    // The cast widens the table entry — indexing by `refine.kind` can't be
    // statically correlated with the matching `refine` variant — but the call
    // is sound: `narrowers[k]` is only ever invoked with the variant whose
    // `kind` is `k`.
    const narrow = narrowers[cand.refine.kind] as (
      refine: Refine,
      current: VariableType,
      aliases: Record<string, TypeAliasEntry>,
    ) => VariableType | null;
    const narrowed = narrow(cand.refine, current, typeAliases);
    if (narrowed === null) continue;
    // Soundness gate: a branch that reassigns the variable may change its type
    // mid-branch, so don't narrow it (whole-body scan, conservative).
    if (isReassignedIn(branchBody, cand.variableName)) continue;
    childScope.declareLocal(cand.variableName, narrowed);
  }
}

function isReassignedIn(body: AgencyNode[], name: string): boolean {
  for (const { node } of walkNodes(body)) {
    if (node.type === "assignment" && node.variableName === name) return true;
  }
  return false;
}

/**
 * The declarative one-call helper that every walkScopeBody narrowing site uses.
 *
 * Encapsulates the three-step "create a throwaway child scope, install
 * refinements into it, then walk the branch body in that scope" recipe so
 * callers say *what* they want ("walk this body under these narrowings")
 * rather than open-coding the *how*. Adding a new narrowing site (e.g.,
 * a future `for`-loop body if the spec ever calls for it) becomes a single
 * call rather than three lines copy-pasted.
 *
 * The generic `ctx` + injected `walk` keeps this module free of any
 * dependency on `scopes.ts` (which is where `walkScopeBody` and
 * `TypeCheckerContext` live), avoiding a circular import.
 */
export function walkWithNarrowing<C>(
  parent: Scope,
  body: AgencyNode[],
  candidates: NarrowCandidate[],
  typeAliases: Record<string, TypeAliasEntry>,
  ctx: C,
  walk: (body: AgencyNode[], scope: Scope, ctx: C) => void,
): void {
  const child = parent.child();
  applyNarrowing(child, candidates, body, typeAliases);
  walk(body, child, ctx);
}
