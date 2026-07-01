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
 * runtime interrupt object `{ effect, message, data, origin }` (interrupts.ts) —
 * ALL FOUR fields, so the common `e.message`/`e.data`/`e.origin` reads still
 * type-check. Only `effect` is refined (the literal union of raisable kinds), so
 * `match (e.effect)` is a value-track literal-union match (checked by
 * match-exhaustiveness B1). This is a closed object, so reading any OTHER field
 * is now a "does not exist" error (intended). A single kind stays a bare literal
 * (a one-member match is not exhaustiveness-checked, which is fine). Payload
 * safety on `.data` is H3.
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
 * and overwrites, so two inline handlers in the same function that share a param
 * name would clobber each other (the later type would win for the earlier
 * handler's `match (e.effect)`). We SKIP any param name used by >1 eligible
 * handler in the same scope → those stay `any` (a missed warning, never wrong).
 *
 * SOUNDNESS — nested handles. `collectRaisableEffects` walks the whole body,
 * including inside a nested `handle`, so it counts effects the inner handler
 * already catches → over-reporting → a false "missing case". Handlers whose body
 * contains a nested handle are skipped above (fall back to `any`).
 */
export function refineInlineHandlerParams(
  scopes: ScopeInfo[],
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
  ctx: TypeCheckerContext,
): void {
  let changed = false;
  for (const info of scopes) {
    const eligible: { node: Extract<AgencyNode, { type: "handleBlock" }>; name: string }[] = [];
    for (const { node, scopes: nodeScopes } of walkNodes(info.body)) {
      if (!isInScope(nodeScopes, info)) continue;
      if (node.type !== "handleBlock" || node.handler.kind !== "inline") continue;
      if (node.handler.param.typeHint) continue; // explicit annotation wins
      if (bodyHasNestedHandle(node.body)) continue; // nested handle → over-count
      eligible.push({ node, name: node.handler.param.name });
    }
    const nameCount = new Map<string, number>();
    for (const h of eligible) nameCount.set(h.name, (nameCount.get(h.name) ?? 0) + 1);

    for (const h of eligible) {
      if ((nameCount.get(h.name) ?? 0) > 1) continue; // colliding name → leave `any`
      const kinds = collectRaisableEffects(h.node.body, info, interruptEffectsByFunction, ctx);
      if (kinds.length === 0) continue; // fall back to `any`
      info.scope.declare(h.name, handlerParamType(kinds));
      changed = true;
    }
  }
  // We mutated scope types after the flow graph + its `typeAt` memo were built,
  // so any cached `e`-is-`any` result is now stale. The flow env's soundness
  // contract requires discarding the memo when scope contents change; otherwise
  // `checkMatchExhaustiveness` reads the pre-refinement `any` for `e.effect`.
  if (changed && ctx.flowEnv) ctx.flowEnv.memo = new WeakMap();
}
