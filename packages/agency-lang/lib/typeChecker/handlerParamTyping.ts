import type { AgencyNode, VariableType } from "../types.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import type { InterruptEffect } from "../symbolTable.js";
import { collectRaisableEffects } from "./interruptAnalysis.js";
import { walkNodes } from "../utils/node.js";
import { isInScope } from "./checker.js";
import { ANY_T } from "./primitives.js";

const stringLiteral = (value: string): VariableType => ({ type: "stringLiteralType", value });

/** True if `body` contains a nested `handle` block (whose handler would catch
 *  some of the effects, making the outer raisable set an over-count). */
function bodyHasNestedHandle(body: AgencyNode[]): boolean {
  for (const { node } of walkNodes(body)) {
    if (node.type === "handleBlock") return true;
  }
  return false;
}

/**
 * The type of an inline handler param whose body raises `kinds`. Matches the
 * runtime interrupt object `{ effect, message, data, origin }` (interrupts.ts).
 * Only `effect` is refined (the literal union of raisable kinds), so
 * `match (e.effect)` is a value-track literal-union match (checked by
 * match-exhaustiveness B1). The other 3 fields stay `any`.
 *
 * NOTE: although this is a closed `objectType`, it does NOT make `e.<field>` a
 * "does not exist" error — field-access checking runs in `checkScopes`, BEFORE
 * this pass re-types the param, so the refined type only ever reaches
 * `checkMatchExhaustiveness`. A single kind stays a bare literal (a one-member
 * match is not exhaustiveness-checked, which is fine). Payload typing on `.data`
 * per effect is H3.
 */
function handlerParamType(kinds: string[]): VariableType {
  const effect: VariableType =
    kinds.length === 1
      ? stringLiteral(kinds[0])
      : { type: "unionType", types: kinds.map(stringLiteral) };
  return {
    type: "objectType",
    properties: [
      { key: "effect", value: effect },
      { key: "message", value: ANY_T },
      { key: "data", value: ANY_T },
      { key: "origin", value: ANY_T },
    ],
  };
}

/**
 * TYPE-ONLY pass (runs after the interrupt call-graph is built): re-declare each
 * eligible inline handler param as `handlerParamType(kinds)`, refining `.effect`
 * from `any` to the literal union of raisable kinds. Does NOT touch handler
 * registration/execution — it only calls `info.scope.declare`.
 *
 * Eligibility: inline handler, no explicit `with (e: T)` annotation, non-empty
 * known raisable-effect set, and no nested `handle` in the body. Otherwise the
 * param stays `any` (already declared by buildScopes) → conservative.
 *
 * SOUNDNESS — colliding param names. `Scope.declare` writes to the FUNCTION scope
 * and overwrites, so an inline handler param clobbers ANY same-named inline
 * handler param in the same function scope (including one with an explicit
 * annotation or one skipped for a nested handle). We count EVERY inline handler
 * param name in the scope and skip any name used more than once → those stay as
 * declared by buildScopes (a missed warning, never a wrong one).
 *
 * SOUNDNESS — nested handles. `collectRaisableEffects` walks the whole body,
 * including inside a nested `handle`, so it counts effects the inner handler
 * already catches → over-reporting → a false "missing case". Handlers whose body
 * contains a nested handle are not eligible (fall back to `any`).
 *
 * Runs each scope under `ctx.withScope(info.scopeKey, …)` so `collectRaisableEffects`
 * → `synthType` resolves scope-local type aliases against the right scope (mirrors
 * `checkHandlerBodyInterrupts`).
 */
export function refineInlineHandlerParams(
  scopes: ScopeInfo[],
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
  ctx: TypeCheckerContext,
): void {
  let changed = false;
  for (const info of scopes) {
    ctx.withScope(info.scopeKey, () => {
      // Count EVERY inline handler param name (eligible or not) — a shared name
      // means typing one would clobber the other's function-scoped binding.
      const nameCount = new Map<string, number>();
      const eligible: { node: Extract<AgencyNode, { type: "handleBlock" }>; name: string }[] = [];
      for (const { node, scopes: nodeScopes } of walkNodes(info.body)) {
        if (!isInScope(nodeScopes, info)) continue;
        if (node.type !== "handleBlock" || node.handler.kind !== "inline") continue;
        const name = node.handler.param.name;
        nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
        if (node.handler.param.typeHint) continue; // explicit annotation wins
        if (bodyHasNestedHandle(node.body)) continue; // nested handle → over-count
        eligible.push({ node, name });
      }

      for (const h of eligible) {
        if ((nameCount.get(h.name) ?? 0) > 1) continue; // shared name → leave as-is
        const kinds = collectRaisableEffects(h.node.body, info, interruptEffectsByFunction, ctx);
        if (kinds.length === 0) continue; // fall back to `any`
        info.scope.declare(h.name, handlerParamType(kinds));
        changed = true;
      }
    });
  }
  // We mutated scope types after the flow graph + its `typeAt` memo were built,
  // so any cached `e`-is-`any` result is now stale. The flow env's soundness
  // contract requires discarding the memo when scope contents change; otherwise
  // `checkMatchExhaustiveness` reads the pre-refinement `any` for `e.effect`.
  if (changed && ctx.flowEnv) ctx.flowEnv.memo = new WeakMap();
}
