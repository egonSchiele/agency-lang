import type { VariableType } from "../types.js";
import type { MatchYield } from "../types/matchYield.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import { walkNodes } from "../utils/node.js";
import { isInScope } from "./checker.js";
import { synthType } from "./synthesizer.js";
import { widenType } from "./assignability.js";
import { isAnyType } from "./utils.js";
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
 * After the table is built for a scope, the recorded scope type of every
 * consumer variable (`const x = match(...)` → tagged `matchExprSource`) is
 * patched to the match's value type when the assignment had no explicit
 * annotation. buildScopes ran before this pass and synthed the `__matchval_`
 * ref to "any" (the table was empty then), so without this patch a downstream
 * `const y = x` would see `x` as "any".
 */
export function computeMatchExprTypes(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): void {
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
        const types = yieldsByMatch[id].map((y) =>
          y.value ? synthType(y.value, info.scope, ctx) : "any",
        );
        // A yield of `any` (the sentinel string OR the `any` primitive) makes
        // the whole match's value type `any` — the union can't be narrowed.
        const isAny = (t: VariableType | "any") => t === "any" || isAnyType(t);
        ctx.matchExprTypes[id] = types.some(isAny)
          ? "any"
          : unionTypes(
              (types as VariableType[]).map((t) => widenType(t) as VariableType),
            );
      }

      // Patch each un-annotated consumer binding (`const x = match(...)`) so
      // downstream uses see the match's value type instead of the "any"
      // recorded before this pass ran. Two stale copies exist, both eager
      // snapshots:
      //  1. the scope entry (buildScopes synthed the `__matchval_` ref to
      //     "any" while the table was empty), and
      //  2. the `assign` flow node (buildFlowGraphs snapshotted
      //     `scope.lookup(...)` at graph-build time — see the flow builder's
      //     assignment rule / FlowEnvironment.matchConsumerAssignFlows).
      // Annotated consumers are already correct in both (declared/snapshotted
      // from the typeHint during buildScopes), so they are skipped.
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

  // Scope entries and flow-node types were rebound above; per the
  // FlowEnvironment soundness contract, any typeAt result memoized during this
  // pass (yield synthesis walks the flow graph) may now be stale. Drop the
  // memo — checkScopes recomputes on demand.
  if (ctx.flowEnv) {
    ctx.flowEnv.memo = new WeakMap();
  }
}
