import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import type { VariableType } from "../types.js";
import type { FinalizeBlock } from "../types/finalizeBlock.js";
import { walkNodes } from "../utils/node.js";
import { isInScope } from "./checker.js";
import { diagnostic } from "./diagnostics.js";
import { ANY_T, NULL_T } from "./primitives.js";

/** The binder's type: T | null, where T is the explicit annotation
 *  when written (`finalize as d: Report` — explicit annotation wins,
 *  the handler-param rule), else the scope's DECLARED return type
 *  (the slot is empty until the first saveDraft, hence the null arm).
 *  Neither present means `any` — inferred return types are out of
 *  scope for v1, the same rule the saveDraft tool schema follows
 *  (spec Part 5). */
function binderType(
  typeHint: VariableType | undefined,
  returnType: VariableType | null | undefined,
): VariableType {
  const t = typeHint ?? returnType;
  if (t === undefined || t === null) return ANY_T;
  // Build the union FLAT. The finalize flow rule re-unions this type
  // with null (uniteTypes, which dedupes but does not flatten), and
  // presence narrowing only drops TOP-LEVEL null members — a nested
  // `(T | null) | null` would keep its inner null through an
  // `if (d != null)` guard.
  const members = t.type === "unionType" ? t.types : [t];
  const hasNull = members.some(
    (m) => m.type === "primitiveType" && m.value === "null",
  );
  if (hasNull) return t;
  return { type: "unionType", types: [...members, NULL_T] };
}

/**
 * Declare each `finalize as <name>` binder into its scope, typed
 * `T | null`. A sibling of refineInlineHandlerParams: runs pre-flow so
 * checkScopes and the flow passes see the binding, and declares into
 * the FUNCTION scope (the finalize body has no scope of its own).
 *
 * A binder that collides with an existing name is an error (AG6037),
 * not a shadow: the binder compiles to a bare closure parameter, and a
 * colliding reference would resolve to `__stack.locals.<name>` — the
 * local — instead. The collision rule is what makes the codegen sound.
 * The check is deliberately `lookupInFunction`, not `has`: the hazard
 * is a same-frame local or param, and `has` walks into the module
 * scope, where a global-named binder is NOT a hazard (globals compile
 * through `__globals()`, not the frame).
 *
 * Accepted limitation (mirrors inline handler params, scopes.ts): the
 * declaration is function-wide, so a reference to the binder OUTSIDE
 * the finalize is not flagged as undefined here.
 */
export function declareFinalizeBinders(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): void {
  for (const info of scopes) {
    ctx.withScope(info.scopeKey, () => {
      for (const { node, scopes: nodeScopes } of walkNodes(info.body)) {
        if (!isInScope(nodeScopes, info)) continue;
        if (node.type !== "finalizeBlock") continue;
        const fin = node as FinalizeBlock;
        if (fin.params.length === 0) continue;
        if (fin.params.length > 1) {
          ctx.errors.push(
            diagnostic(
              "finalizeBinderArity",
              { name: fin.params[0].name },
              fin.loc ?? null,
            ),
          );
          continue;
        }
        const binder = fin.params[0];
        if (info.scope.lookupInFunction(binder.name) !== undefined) {
          ctx.errors.push(
            diagnostic(
              "finalizeBinderCollision",
              { name: binder.name },
              fin.loc ?? null,
            ),
          );
          continue;
        }
        info.scope.declare(
          binder.name,
          binderType(binder.typeHint, info.returnType),
        );
      }
    });
  }
}
