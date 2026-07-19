import { diagnostic } from "./diagnostics.js";
import type { InterruptEffect } from "../symbolTable.js";
import type { TypeCheckerContext } from "./types.js";
import { resolveEffectSet } from "./effectSets.js";
import type { VariableType } from "../types.js";
import type { SourceLocation } from "../types/base.js";

/**
 * For every function/node that declares a `raises` clause, verify that its
 * transitively-inferred effect set does not exceed the declared set
 * (inferred ⊆ declared). Emits a bespoke, effect-aware error per offending
 * effect. Also reports a `raises` clause that references a known type alias
 * which is not an effect set.
 *
 * Compares a declaration to an inferred set; raising inside handler
 * bodies is legal (the retired AG3010 once flagged it).
 *
 * IMPORTANT: do not suggest "handle it inside the function" as a fix.
 * Under Agency's handler-chain semantics every handler in the stack runs,
 * so a locally-handled interrupt is still observed by ancestor handlers
 * and remains part of the function's effect set (spec decision A).
 */
export function checkRaisesDeclarations(
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
  ctx: TypeCheckerContext,
): void {
  const aliases = ctx.getTypeAliases();

  const check = (
    name: string,
    raises: VariableType | undefined,
    loc: SourceLocation | undefined,
    kind: "Function" | "Node",
  ): void => {
    if (!raises) return; // no clause = unconstrained

    const declared = resolveEffectSet(raises, aliases);

    // A `raises` clause may only reference effect sets, not arbitrary type
    // aliases. Unknown bare names are fine (they are literal effects); only
    // a KNOWN alias of the wrong kind is an error.
    if (declared.nonEffectSetRefs.length > 0) {
      for (const ref of declared.nonEffectSetRefs) {
        ctx.errors.push(
          diagnostic("raisesNotAnEffectSet", { ref }, loc ?? null),
        );
      }
      return; // don't run the subset check against a malformed clause
    }

    if (declared.any) return; // `<*>` — no upper bound

    const inferred = (interruptEffectsByFunction[name] ?? []).map((e) => e.effect);
    const declaredStr = `<${declared.labels.join(", ")}>`;

    for (const effect of inferred) {
      if (!declared.labels.includes(effect)) {
        ctx.errors.push(
          diagnostic(
            "raisesExceeded",
            { kind, name, effect, declared: declaredStr },
            loc ?? null,
          ),
        );
      }
    }
  };

  for (const [name, def] of Object.entries(ctx.functionDefs)) {
    check(name, def.raises, def.loc, "Function");
  }
  for (const [name, def] of Object.entries(ctx.nodeDefs)) {
    check(name, def.raises, def.loc, "Node");
  }
}
