import { isAnyType } from "./utils.js";
import type { AgencyNode, Expression } from "../types.js";
import type { BlockType } from "../types/typeHints.js";
import type { InterruptEffect } from "../symbolTable.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import { synthType } from "./synthesizer.js";
import { safeResolveType } from "./assignability.js";
import { resolveEffectSet } from "./effectSets.js";
import { collectRaisableEffects } from "./interruptAnalysis.js";
import { AGENCY_FUNCTION_METHOD_TYPES } from "./builtins.js";

/** The effects a function-valued expression may raise. `any` means "may raise
 *  anything" — a function type with no `raises` clause. `sourceName` is the base
 *  function's name when known, for the diagnostic. */
export type FnEffects = { any: boolean; labels: string[]; sourceName?: string };

type EffectMap = Record<string, InterruptEffect[]>;

const NO_EFFECTS: FnEffects = { any: false, labels: [] };

// -- One small function per kind of function value ---------------------------

/** A partial-application / `.preapprove()` / `.describe()` / `.rename()` chain
 *  raises exactly what the value it wraps raises. Such chains synth to `"any"`,
 *  so we return the wrapped base expression and let the caller recurse on it. */
function pfaBase(expr: Expression): Expression | null {
  if (expr.type !== "valueAccess") return null;
  const onlyPfaMethods = expr.chain.every(
    (element) =>
      element.kind === "methodCall" &&
      (element.functionCall.functionName === "partial" ||
        element.functionCall.functionName in AGENCY_FUNCTION_METHOD_TYPES),
  );
  return onlyPfaMethods ? (expr.base as Expression) : null;
}

/** A named function reference: its transitively-inferred effect set. */
function effectsOfNamedRef(name: string, effects: EffectMap): FnEffects {
  return {
    any: false,
    labels: (effects[name] ?? []).map((effect) => effect.effect),
    sourceName: name,
  };
}

/** A block value: the effects raised by its body. */
function effectsOfBlock(
  body: AgencyNode[],
  info: ScopeInfo,
  effects: EffectMap,
  ctx: TypeCheckerContext,
): FnEffects {
  return { any: false, labels: collectRaisableEffects(body, info, effects, ctx) };
}

/** An opaque function-typed value (a variable / parameter): only its type's
 *  clause is known. No clause means it may raise anything (the strict rule). */
function effectsOfFunctionType(type: BlockType, ctx: TypeCheckerContext): FnEffects {
  if (!type.raises) return { any: true, labels: [] };
  const resolved = resolveEffectSet(type.raises, ctx.getTypeAliases());
  return { any: resolved.any, labels: resolved.labels };
}

// -- Dispatch on which kind of function value this expression is -------------

export function functionValueEffects(
  expr: Expression,
  info: ScopeInfo,
  effects: EffectMap,
  ctx: TypeCheckerContext,
): FnEffects {
  if (expr.type === "blockArgument") {
    return effectsOfBlock(expr.body, info, effects, ctx);
  }

  const base = pfaBase(expr);
  if (base) {
    return functionValueEffects(base, info, effects, ctx);
  }

  const synthed = synthType(expr, info.scope, ctx);
  if (isAnyType(synthed)) {
    return NO_EFFECTS; // unknown type — claim nothing (the checker's fail-open convention)
  }

  const type = safeResolveType(synthed, ctx.getTypeAliases());
  if (type.type === "functionRefType") {
    return effectsOfNamedRef(type.name, effects);
  }
  if (type.type === "blockType") {
    return effectsOfFunctionType(type, ctx);
  }
  return NO_EFFECTS;
}
