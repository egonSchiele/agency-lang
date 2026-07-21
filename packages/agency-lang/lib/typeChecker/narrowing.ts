import { isAnyType } from "./utils.js";
import type { AgencyNode, Expression, TypeAliasEntry, IfElse, VariableType } from "../types.js";
import type {
  StringLiteralType,
  NumberLiteralType,
  BooleanLiteralType,
} from "../types/typeHints.js";
import { Scope } from "./scope.js";
import { walkNodes } from "../utils/node.js";
import { isAssignable, safeResolveType } from "./assignability.js";
import { literalToType } from "./literalType.js";
import { resultToObjectUnion } from "./resultUnion.js";
import { unescapeStringLiteralValue } from "../parsers/parsers.js";
// Type-only import: `flow.ts` imports `Refine`/`NarrowCandidate` from here, so a
// value import would cycle. `Reference` is the narrowed path (variable + chain).
// Import the path-segment core from its own module (NOT flow.ts) — flow.ts
// value-imports narrowByRefine from here, so a value import back from flow.ts
// would form a runtime cycle. See pathSegments.ts.
import { chainToSegments } from "./pathSegments.js";
import type { Reference } from "./pathSegments.js";

/**
 * What a candidate narrows to. Tagged so a new narrowing form slots in as one
 * more `narrowByRefine` case. `discriminant` filters a union by
 * `v.prop == literal` — and drives Result narrowing too (`isSuccess`/`isFailure`/
 * `if (r.success)` all narrow on the `success` field, with Result viewed as a
 * union via `resultToObjectUnion`). `presence` filters the `null` member for
 * optional / truthiness narrowing (`if (x != null)` / `if (x)`).
 */
export type Refine =
  | {
      kind: "discriminant";
      prop: string;
      literal: StringLiteralType | NumberLiteralType | BooleanLiteralType;
      keep: boolean;
    }
  | { kind: "presence"; present: boolean }
  // A type pattern's test (`x is T`): the then-branch narrows the subject to
  // the tested type. Positive-only by design — a Tier 2 test can fail on a
  // validator even when the static type matches, so the else-branch (and any
  // negative fact) would be unsound.
  | { kind: "typeTest"; testedType: VariableType };
export type NarrowCandidate = { ref: Reference; refine: Refine };
export type ConditionFacts = { then: NarrowCandidate[]; else: NarrowCandidate[] };

const NO_FACTS: ConditionFacts = { then: [], else: [] };

/**
 * The single Refine dispatcher: given a refine + the variable's current
 * (pre-resolved) type, the narrowed type, or null for "no narrowing". Used by
 * BOTH the flow path (`applyRefine`, flow.ts) and the legacy child-scope path
 * (`applyNarrowing`). The switch is exhaustive, so a new `Refine` variant is a
 * compile error here. (The "how" — child scope, reassignment gate,
 * declareLocal — lives in `applyNarrowing`.)
 */
export function narrowByRefine(
  refine: Refine,
  current: VariableType,
  aliases: Record<string, TypeAliasEntry>,
): VariableType | null {
  switch (refine.kind) {
    case "discriminant":
      return narrowUnionByDiscriminant(
        current,
        refine.prop,
        refine.literal,
        refine.keep,
        aliases,
      );
    case "presence":
      return narrowUnionByPresence(current, refine.present, aliases);
    case "typeTest":
      // If what we already know is at least as precise as the tested type
      // (e.g. `is string` on `"a" | "b"`), the test tells us nothing new —
      // replacing would WIDEN the literal union to `string` and break code
      // that returns the narrowed value where the union is expected. `any`
      // is excluded: it is "assignable" to everything, but the whole point
      // of the test is to escape it.
      if (!isAnyType(current) && isAssignable(current, refine.testedType, aliases)) {
        return null;
      }
      return refine.testedType;
  }
}

/**
 * A stable single-hop property path: a bare variable, or `variable.property`.
 * Returns the `Reference`, or null for anything else (calls, index/computed
 * keys, method hops, slices). A stable path is a bare variable or any chain of
 * property + literal-non-negative-integer-index hops over one (M2). The shared
 * `chainToSegments` (flow.ts) is the single source of the stability rule.
 */
function asPathReference(e: Expression): Reference | null {
  if (e.type === "variableName") return { variable: e.value, chain: [] };
  if (e.type === "valueAccess" && e.base.type === "variableName") {
    const chain = chainToSegments(e.chain);
    return chain === null ? null : { variable: e.base.value, chain };
  }
  return null;
}

/**
 * Recognize `V.prop` where the *receiver* `V` is any stable path. The
 * discriminant is the FINAL hop (must be a property); the narrowed reference is
 * the receiver prefix. So `obj.kind` → ref `{obj,[]}`, prop `kind`;
 * `obj.payload.kind` → ref `{obj,[payload]}`; `arr[0].kind` → ref `{arr,[[0]]}`,
 * prop `kind`. An unstable hop before the discriminant (`arr[i()].kind`) → null.
 * Variable-keyed, so the narrowed scrutinee is statically the same binding at
 * the access site.
 */
function asDiscriminantAccess(
  e: Expression,
): { ref: Reference; prop: string } | null {
  if (e.type !== "valueAccess" || e.base.type !== "variableName") return null;
  if (e.chain.length < 1) return null;
  const last = e.chain[e.chain.length - 1];
  if (last.kind !== "property") return null; // discriminant must be a static prop
  const receiver = chainToSegments(e.chain.slice(0, -1));
  if (receiver === null) return null; // an unstable hop before the discriminant
  return { ref: { variable: e.base.value, chain: receiver }, prop: last.name };
}

/**
 * `null` can reach the type checker as either the dedicated `NullLiteral` node
 * (`type: "null"`) or — in binary-operand position, as observed for `x != null`
 * — a bare `variableName` whose value is `"null"`. Recognize both shapes.
 */
function isNullExpr(e: Expression): boolean {
  return (
    e.type === "null" || (e.type === "variableName" && e.value === "null")
  );
}

/**
 * Recognize a presence test `x == null` / `x != null` over a single-hop path
 * (a bare variable or `obj.field`), either operand order. Returns the
 * `Reference`, or null otherwise.
 */
function asPresenceTest(left: Expression, right: Expression): Reference | null {
  const tryOne = (a: Expression, b: Expression): Reference | null =>
    !isNullExpr(a) && isNullExpr(b) ? asPathReference(a) : null;
  return tryOne(left, right) ?? tryOne(right, left);
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
      // Presence test: `x == null` / `x != null` over a single-hop path (either
      // operand order). Narrows by stripping/keeping the `null` member. Disjoint
      // from the discriminant shape below (path-vs-`null`-literal vs `V.prop`).
      const presenceRef = asPresenceTest(condition.left, condition.right);
      if (presenceRef) {
        // `x != null` → then: present (non-null); `x == null` → then: absent.
        const presentThen = condition.operator === "!=";
        const mkP = (present: boolean): NarrowCandidate => ({
          ref: presenceRef,
          refine: { kind: "presence", present },
        });
        return { then: [mkP(presentThen)], else: [mkP(!presentThen)] };
      }
      // `V.prop == literal` / `!= literal` over a single-hop receiver `V`. Either
      // operand order. then-branch keeps the matching member(s) for `==` (and the
      // complement for `!=`); the else-branch is the inverse.
      const acc = asDiscriminantAccess(condition.left) ?? asDiscriminantAccess(condition.right);
      const lit = literalToType(condition.right) ?? literalToType(condition.left);
      if (!acc || !lit) return NO_FACTS;
      const keepThen = condition.operator === "==";
      const mk = (keep: boolean): NarrowCandidate => ({
        ref: acc.ref,
        refine: { kind: "discriminant", prop: acc.prop, literal: lit, keep },
      });
      return { then: [mk(keepThen)], else: [mk(!keepThen)] };
    }
    return NO_FACTS;
  }

  // Member-access truthiness: `if (r.success)` ⇒ discriminant `r.success == true`.
  // SCOPE: fires ONLY for a member access (`v.prop`), never a bare variable
  // (`if (x)` is presence narrowing — see null-truthiness-narrowing-spec.md; do
  // NOT generalize this to bare vars). Non-boolean discriminants make
  // narrowUnionByDiscriminant return null, so this is a sound no-op there.
  if (condition.type === "valueAccess") {
    const acc = asDiscriminantAccess(condition);
    if (!acc) return NO_FACTS;
    const litTrue: BooleanLiteralType = { type: "booleanLiteralType", value: "true" };
    const truthy = (keep: boolean): NarrowCandidate => ({
      ref: acc.ref,
      refine: { kind: "discriminant", prop: acc.prop, literal: litTrue, keep },
    });
    return { then: [truthy(true)], else: [truthy(false)] };
  }

  // Bare-variable truthiness: `if (x)` strips `null` in the THEN-branch only.
  // The runtime evaluates conditions with JS truthiness (runner.ts), so a falsy
  // `x` can be a non-null value (`""`/`0`/`false`) as well as `null` — the
  // else-branch (and the post-`while` region) therefore CANNOT be narrowed to
  // `null` (that would be unsound). Truthy ⇒ non-null is the only safe fact.
  // Explicit `x == null` / `x != null` (above) are exact and narrow both sides.
  // Member-access truthiness (`if (r.success)`) is the discriminant case in the
  // `valueAccess` branch above; this fires ONLY for a bare variable.
  if (condition.type === "variableName" && condition.value !== "null") {
    return {
      then: [
        {
          ref: { variable: condition.value, chain: [] },
          refine: { kind: "presence", present: true },
        },
      ],
      else: [],
    };
  }

  // A type pattern's lowered test: `x is T` (or a match arm `p: T` testing
  // the scrutinee temp). Then-branch only — see the `typeTest` Refine.
  if (condition.type === "typeTestExpression") {
    const ref = asPathReference(condition.expression);
    if (!ref) return NO_FACTS;
    return {
      then: [{ ref, refine: { kind: "typeTest", testedType: condition.typeHint } }],
      else: [],
    };
  }

  if (condition.type !== "functionCall") return NO_FACTS;
  const fn = condition.functionName;
  if (fn !== "isSuccess" && fn !== "isFailure") return NO_FACTS;
  if (condition.arguments.length !== 1) return NO_FACTS;
  const arg = condition.arguments[0];
  // Skip splat / named args (not Expressions); only a bare var or one-hop path.
  if (arg.type !== "variableName" && arg.type !== "valueAccess") return NO_FACTS;
  const ref = asPathReference(arg);
  if (!ref) return NO_FACTS;
  // isSuccess(r) ⇔ r.success == true ; isFailure(r) ⇔ r.success != true.
  // Result is consumed as a discriminated union on `success` (resultUnion.ts).
  const successLit: BooleanLiteralType = { type: "booleanLiteralType", value: "true" };
  const keepThen = fn === "isSuccess";
  const onSuccess = (keep: boolean): NarrowCandidate => ({
    ref,
    refine: { kind: "discriminant", prop: "success", literal: successLit, keep },
  });
  return { then: [onSuccess(keepThen)], else: [onSuccess(!keepThen)] };
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
  let resolved = safeResolveType(type, aliases);
  // Result is a discriminated union on `success` — view it as one so the same
  // member-filter handles isSuccess/isFailure/`if (r.success)` narrowing.
  if (resolved.type === "resultType") resolved = resultToObjectUnion(resolved, aliases);
  if (resolved.type !== "unionType") return null;
  // A union *member* may itself be a Result — e.g. a flow join where one branch
  // kept the raw `Result<…>` and another expanded it to its `{success:…}` object
  // form (mergeFlows + uniteTypes produce `Result<…> | {success:false,…}`).
  // Expand such members so the discriminant filter below sees homogeneous object
  // members; otherwise a raw `resultType` has no discriminant property, survives
  // every filter, and silently blocks narrowing.
  const members = resolved.types.flatMap((m) => {
    const rm = safeResolveType(m, aliases);
    return rm.type === "resultType" ? resultToObjectUnion(rm, aliases).types : [m];
  });
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
 * Filter the `null` member of a union for presence narrowing.
 * - `present: true`  (e.g. `if (x != null)`): drop the `null` member.
 * - `present: false` (e.g. `if (x == null)`): keep only the `null` member.
 * Returns `null` (no narrowing) for a non-union type, a union with no `null`
 * member, or any result that would be empty — so it never narrows to `never`.
 */
export function narrowUnionByPresence(
  type: VariableType,
  present: boolean,
  aliases: Record<string, TypeAliasEntry>,
): VariableType | null {
  const resolved = safeResolveType(type, aliases);
  if (resolved.type !== "unionType") {
    return null;
  }
  const isNull = (m: VariableType): boolean => {
    const r = safeResolveType(m, aliases);
    return r.type === "primitiveType" && r.value === "null";
  };
  const kept = resolved.types.filter((m) => (present ? !isNull(m) : isNull(m)));
  if (kept.length === resolved.types.length || kept.length === 0) {
    return null;
  }
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
 * scope is dropped at branch exit and never leak to the function scope. A
 * narrowed binding is the concrete member type (e.g. a Result's success-member
 * object type), so nothing branch-specific persists once the child is dropped.
 */
export function applyNarrowing(
  childScope: Scope,
  candidates: NarrowCandidate[],
  branchBody: AgencyNode[],
  typeAliases: Record<string, TypeAliasEntry>,
): void {
  for (const cand of candidates) {
    // The legacy child-scope path narrows a bare variable (declareLocal by name).
    // Member-path candidates (chain.length > 0) are handled only by the flow
    // path (typeAt); skip them here — declaring a local named "obj.r" is
    // meaningless. Inference is bare-variable-only; path narrowing is Phase-B.
    if (cand.ref.chain.length !== 0) continue;
    const name = cand.ref.variable;
    const current = childScope.lookup(name);
    if (!current || isAnyType(current)) continue;
    // "what to narrow to" is delegated to narrowByRefine (the same dispatcher
    // the flow path uses). It resolves through type-alias variables itself
    // (mirrors synthValueAccess) so alias-typed scrutinees still narrow; null
    // means "leave the type as-is". Run it first: most `v.prop == literal`
    // candidates aren't unions and bail here, so we skip the (more expensive)
    // whole-body reassignment walk.
    const narrowed = narrowByRefine(cand.refine, current, typeAliases);
    if (narrowed === null) continue;
    // Soundness gate: a branch that reassigns the variable may change its type
    // mid-branch, so don't narrow it (whole-body scan, conservative).
    if (isReassignedIn(branchBody, name)) continue;
    childScope.declareLocal(name, narrowed);
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
