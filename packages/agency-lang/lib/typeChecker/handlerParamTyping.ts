import type { AgencyNode, VariableType } from "../types.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import type { InterruptEffect } from "../symbolTable.js";
import type { ObjectType } from "../types/typeHints.js";
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
 * The type of an inline handler param whose body raises `kinds`, as a
 * DISCRIMINATED UNION: one member per effect kind,
 *   { effect: "<kind>", data: <declared payload | any>, message: any, origin: any },
 * matching the runtime interrupt object (interrupts.ts). The `effect` literal is
 * the discriminant, so `if (e.effect == "<kind>")` / `match (e)` narrows `e` to a
 * single member whose `data` carries that effect's declared payload — H3 payload
 * safety falls out of discriminated-union narrowing (D1) + member-path narrowing
 * (M2). `match (e.effect)` remains a value-track literal-union match (B1). A single
 * kind is a single member (no union wrapper). An effect with no registry entry
 * (undeclared, or dropped as conflicting) gets `data: any`.
 *
 * NOTE: this pass runs BEFORE `checkScopes`, so re-typing `e` to a closed object
 * DOES make `e.<unknown-field>` a "does not exist" error during `checkScopes` —
 * intended, since the interrupt object has exactly `{ effect, message, data, origin }`.
 */
function handlerParamType(
  kinds: string[],
  registry: Record<string, ObjectType>,
): VariableType {
  // Own-property guard: effect kinds are user-controlled strings, so a reserved
  // key ("__proto__"/"toString"/…) must not resolve a payload via Object.prototype.
  const payloadFor = (kind: string): VariableType =>
    Object.prototype.hasOwnProperty.call(registry, kind) ? registry[kind] : ANY_T;
  const member = (kind: string): VariableType => ({
    type: "objectType",
    properties: [
      { key: "effect", value: stringLiteral(kind) },
      { key: "data", value: payloadFor(kind) },
      { key: "message", value: ANY_T },
      { key: "origin", value: ANY_T },
    ],
  });
  return kinds.length === 1
    ? member(kinds[0])
    : { type: "unionType", types: kinds.map(member) };
}

/**
 * TYPE-ONLY pass (runs after the interrupt effect analysis, BEFORE `buildFlowGraphs`
 * / `checkScopes`): re-declare each eligible inline handler param as
 * `handlerParamType(kinds, registry)` — a per-effect discriminated union carrying
 * each effect's declared payload as `data`. Does NOT touch handler
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
  registry: Record<string, ObjectType>,
): void {
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
        info.scope.declare(h.name, handlerParamType(kinds, registry));
      }
    });
  }
  // No flow-env memo reset needed: this pass runs BEFORE `buildFlowGraphs`, so
  // the flow graph's `typeAt` oracle is seeded from the refined scope from the
  // start — there is no stale `e`-is-`any` cache to discard.
}
