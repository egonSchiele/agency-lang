import type { AgencyNode, Expression, TypeAliasEntry } from "../types.js";
import type { ResultType } from "../types/typeHints.js";
import { Scope } from "./scope.js";
import { walkNodes } from "../utils/node.js";
import { safeResolveType } from "./assignability.js";

export type NarrowCandidate = { variableName: string; branch: "success" | "failure" };
export type ConditionFacts = { then: NarrowCandidate[]; else: NarrowCandidate[] };

const NO_FACTS: ConditionFacts = { then: [], else: [] };

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
    then: [{ variableName: name, branch: thenBranch }],
    else: [{ variableName: name, branch: elseBranch }],
  };
}

/** Return a copy of a ResultType tagged as narrowed to one branch. */
export function narrowToBranch(rt: ResultType, branch: "success" | "failure"): ResultType {
  return { ...rt, narrowedBranch: branch };
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
    // Resolve through type-alias variables (`let r: R = …` where
    // `type R = Result<…>` is stored as `typeAliasVariable`, not `resultType`).
    // Mirrors `synthValueAccess`, which also resolves before its Result check —
    // without this, alias-typed Results silently never narrow, leaving them
    // unfixable under Increment 3's hard-error flip.
    const resolved = safeResolveType(current, typeAliases);
    if (resolved.type !== "resultType") continue;
    if (isReassignedIn(branchBody, cand.variableName)) continue;
    childScope.declareLocal(cand.variableName, narrowToBranch(resolved, cand.branch));
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
