import type { VariableType } from "../types.js";
import type { MatchYield } from "../types/matchYield.js";
import type { SourceLocation } from "../types/base.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import { walkNodes } from "../utils/node.js";
import { isInScope } from "./checker.js";
import { synthType } from "./synthesizer.js";
import { widenType, isAssignable } from "./assignability.js";
import { isAnyType, emitAssignabilityError } from "./utils.js";
import { unionTypes } from "./inference.js";

/**
 * Computes the value type of every expression-position `match`: the widened
 * union of its `matchYield` value types. Runs after buildScopes + buildFlowGraphs
 * (so scope types and flow-sensitive narrowing are available) and before
 * checkScopes (so consumers can read `ctx.matchExprTypes`).
 *
 * Per scope, match ids are processed in DESCENDING order: inner matches have
 * higher ids (the lowerer recurses inner-last), and an outer match's yield may
 * be `varRef(__matchval_<inner>)`. Synthing that ref goes through the
 * `__matchval_` hook in the synthesizer, which reads the already-computed inner
 * entry — so descending order makes the recursion resolve bottom-up.
 *
 * After the table is built for ALL scopes, a second pass patches the recorded
 * scope type of every consumer variable (`const x = match(...)` → tagged
 * `matchExprSource`) to the match's value type when the assignment had no
 * explicit annotation. The two passes are separate so a consumer whose match
 * yields live in another scope (a module-level `const x = match(...)` lowers to
 * a call into a synthesized init function) still resolves regardless of order. buildScopes ran before this pass and synthed the `__matchval_`
 * ref to "any" (the table was empty then), so without this patch a downstream
 * `const y = x` would see `x` as "any".
 */
export function computeMatchExprTypes(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): void {
  // ORDERING ASSERTION (load-bearing — see TypeChecker.check()): yield
  // synthesis must see flow-narrowed bindings, and this pass patches the
  // eagerly-snapshotted matchConsumerAssignFlows nodes — both require the
  // flow graph to exist. A reorder would silently type every
  // expression-match as its un-narrowed synthesis.
  if (!ctx.flowEnv) {
    throw new Error(
      "computeMatchExprTypes must run after buildFlowGraphs (ctx.flowEnv is not set)",
    );
  }
  for (const info of scopes) {
    ctx.withScope(info.scopeKey, () => {
      const yieldsByMatch: Record<number, MatchYield[]> = {};
      for (const { node, scopes: nodeScopes } of walkNodes(info.body)) {
        if (node.type !== "matchYield") continue;
        if (!isInScope(nodeScopes, info)) continue;
        (yieldsByMatch[node.matchId] ??= []).push(node);
      }

      const ids = Object.keys(yieldsByMatch)
        .map(Number)
        .sort((a, b) => b - a);
      for (const id of ids) {
        const yields = yieldsByMatch[id];
        // A single-expression arm is hoisted to a temp for interrupt
        // propagation (#430); `typeSource` carries the arm's original
        // expression so literal types and per-arm narrowing survive typing —
        // the temp ref in `value` would widen them and lose narrowing.
        const typeExpr = (y: MatchYield) => y.typeSource ?? y.value;
        const types = yields.map((y) => {
          const e = typeExpr(y);
          return e ? synthType(e, info.scope, ctx) : "any";
        });
        // Record each yield's UNWIDENED type + loc for CHECKED-position
        // per-arm assignability checking (see `checkMatchExprYields`).
        ctx.matchExprYieldTypes[id] = yields.map((y, i) => ({
          type: types[i],
          loc: typeExpr(y)?.loc ?? y.loc,
        }));
        // A yield of `any` (the sentinel string OR the `any` primitive) makes
        // the whole match's value type `any` — the union can't be narrowed.
        const isAny = (t: VariableType | "any") => t === "any" || isAnyType(t);
        ctx.matchExprTypes[id] = types.some(isAny)
          ? "any"
          : unionTypes(
              (types as VariableType[]).map((t) => widenType(t) as VariableType),
            );
      }

    });
  }

  // Phase 2: patch each un-annotated consumer binding (`const x = match(...)`)
  // so downstream uses see the match's value type instead of the "any" recorded
  // before this pass ran. Two stale copies exist, both eager snapshots:
  //  1. the scope entry (buildScopes synthed the `__matchval_` ref to "any"
  //     while the table was empty), and
  //  2. the `assign` flow node (buildFlowGraphs snapshotted `scope.lookup(...)`
  //     at graph-build time — see the flow builder's assignment rule /
  //     FlowEnvironment.matchConsumerAssignFlows).
  // Annotated consumers are already correct in both (declared/snapshotted from
  // the typeHint during buildScopes), so they are skipped.
  //
  // This is a SEPARATE pass over all scopes (rather than patching inside the
  // compute loop above) so the global `ctx.matchExprTypes` table is fully
  // populated first: a module-level `const x = match(...)` is lowered to a call
  // into a synthesized init function, so its consumer lives in a DIFFERENT
  // scope from the match's yields and must not depend on scope processing order.
  for (const info of scopes) {
    ctx.withScope(info.scopeKey, () => {
      for (const { node, scopes: nodeScopes } of walkNodes(info.body)) {
        if (node.type !== "assignment" || !node.matchExprSource) continue;
        if (node.typeHint) continue;
        if (!isInScope(nodeScopes, info)) continue;
        const type = ctx.matchExprTypes[node.matchExprSource.matchId];
        if (type === undefined) continue;
        info.scope.declare(node.variableName, type, node.declKind === "const");
        const assignFlow = ctx.flowEnv?.matchConsumerAssignFlows?.get(node);
        if (assignFlow?.kind === "assign") {
          assignFlow.type = type;
        }
      }
    });
  }

  // Scope entries and flow-node types were rebound above. The declare() calls
  // bumped the scope-tree generation, so typeAt discards its stale memo on the
  // next query (see FlowMemo, flow.ts) — no manual reset needed.
}

/**
 * CHECKED-position assignability for an expression-position `match`: check EACH
 * arm's `matchYield` value against `expected` using the yield's UNWIDENED type,
 * anchoring any error on the offending arm's value. This is what makes
 * `const c: Category = match(x) { "go" => "a"; _ => "b" }` (with
 * `type Category = "a" | "b"`) type-check — the widened union `string` recorded
 * in `matchExprTypes` would falsely reject it. Use this whenever the consumer
 * supplies an expected type (annotation or declared return type); fall back to
 * the widened `matchExprTypes` union only in synthesis (unannotated) positions.
 * No-op if the match id has no recorded yields.
 */
export function checkMatchExprYields(
  matchId: number,
  expected: VariableType,
  context: string,
  ctx: TypeCheckerContext,
  fallbackLoc: SourceLocation | undefined,
): void {
  const yields = ctx.matchExprYieldTypes[matchId];
  if (!yields) return;
  // If ANY arm yields `any` the match's value type collapses to `any` (same
  // rule as `matchExprTypes`), which is assignable to anything — no error.
  const isAny = (t: VariableType | "any") => t === "any" || isAnyType(t);
  if (yields.some((y) => isAny(y.type))) return;
  // Report the FIRST arm whose UNWIDENED yield type is not assignable to the
  // expected type. Anchoring on that arm's value gives a precise location and
  // names the offending value; stopping after one keeps the diagnostic count
  // at one when several arms mismatch (matching the pre-per-yield behavior).
  for (const y of yields) {
    if (isAssignable(y.type as VariableType, expected, ctx.getTypeAliases())) {
      continue;
    }
    emitAssignabilityError(y.type, expected, y.loc ?? fallbackLoc, context, ctx);
    return;
  }
}
