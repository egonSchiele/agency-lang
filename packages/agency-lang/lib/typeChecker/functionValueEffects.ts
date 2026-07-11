import type { Expression } from "../types.js";
import type { InterruptEffect } from "../symbolTable.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import { synthType } from "./synthesizer.js";
import { safeResolveType } from "./assignability.js";
import { resolveEffectSet } from "./effectSets.js";
import { collectRaisableEffects } from "./interruptAnalysis.js";
import { AGENCY_FUNCTION_METHOD_TYPES } from "./builtins.js";

/** The effects a function-valued expression may raise. `any: true` means "may
 *  raise anything" — a resolved function type with no `raises` clause.
 *  `sourceName` is the base function name when known, for the diagnostic. */
export type FnEffects = { any: boolean; labels: string[]; sourceName?: string };

/** If `expr` is a partial-application / preapprove / describe / rename chain
 *  on a named function, return that base function's name; else null. These
 *  chains synth to "any", so the name must be recovered syntactically. Effects
 *  are unchanged from the base (e.g. preapprove does not drop an effect). */
export function pfaBaseName(expr: Expression): string | null {
  if (expr.type !== "valueAccess") return null;
  if (expr.base.type !== "variableName") return null;
  const allPfaMethods = expr.chain.every(
    (el) =>
      el.kind === "methodCall" &&
      (el.functionCall.functionName === "partial" ||
        el.functionCall.functionName in AGENCY_FUNCTION_METHOD_TYPES),
  );
  return allPfaMethods ? expr.base.value : null;
}

function byName(
  name: string,
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
): FnEffects {
  const labels = (interruptEffectsByFunction[name] ?? []).map((e) => e.effect);
  return { any: false, labels, sourceName: name };
}

export function functionValueEffects(
  expr: Expression,
  info: ScopeInfo,
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
  ctx: TypeCheckerContext,
): FnEffects {
  // A block value: its effects are its body's effects. No name.
  if (expr.type === "blockArgument") {
    return {
      any: false,
      labels: collectRaisableEffects(expr.body, info, interruptEffectsByFunction, ctx),
    };
  }

  // A PFA / preapprove / describe / rename chain synths to "any"; recover the
  // base name and use the base function's effect set.
  const base = pfaBaseName(expr);
  if (base) return byName(base, interruptEffectsByFunction);

  const synthed = synthType(expr, info.scope, ctx);
  // "any" is the checker's unknown/fail-open value, NOT "raises anything". Claim
  // no effects so an untypeable expression never trips the check.
  if (synthed === "any") return { any: false, labels: [] };

  const t = safeResolveType(synthed, ctx.getTypeAliases());

  // A named function reference.
  if (t.type === "functionRefType") return byName(t.name, interruptEffectsByFunction);

  // An opaque function-typed value: only its type's clause is known. No clause
  // means it may raise anything (the strict rule).
  if (t.type === "blockType") {
    if (!t.raises) return { any: true, labels: [] };
    const resolved = resolveEffectSet(t.raises, ctx.getTypeAliases());
    return { any: resolved.any, labels: resolved.labels };
  }

  // Not a function value we can reason about → claim nothing.
  return { any: false, labels: [] };
}
