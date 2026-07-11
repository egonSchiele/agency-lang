import type { VariableType, Expression } from "../types.js";
import type { InterruptEffect } from "../symbolTable.js";
import type { SourceLocation } from "../types/base.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import { walkNodes } from "../utils/node.js";
import { safeResolveType } from "./assignability.js";
import { resolveEffectSet } from "./effectSets.js";
import { formatTypeHint } from "../utils/formatType.js";
import { paramListSignature } from "./checker.js";
import { functionValueEffects } from "./functionValueEffects.js";
import { checkRaisesDeclarations } from "./raisesDiagnostic.js";

/**
 * Enforce a `raises` clause on a function type. When a function value flows into
 * a function type that declares a `raises` clause — via a declaration/
 * assignment, a call argument, or a return — the value may not raise more than
 * the clause allows. Runs after effect inference, next to
 * `checkRaisesDeclarations`. Assignability stays purely structural; this pass
 * owns the effect comparison so it can produce a precise message.
 */

// If `target` is a function type WITH a `raises` clause, return the effects it
// allows. Null means "no constraint": not a function type, no clause, or `<*>`.
function targetAllowed(
  target: VariableType | "any" | null | undefined,
  ctx: TypeCheckerContext,
): { labels: string[]; targetStr: string } | null {
  if (!target || target === "any") return null;
  const resolved = safeResolveType(target, ctx.getTypeAliases());
  if (resolved.type !== "blockType" || !resolved.raises) return null;
  const set = resolveEffectSet(resolved.raises, ctx.getTypeAliases());
  if (set.any) return null; // `<*>` allows anything
  const targetStr =
    target.type === "typeAliasVariable" ? target.aliasName : formatTypeHint(target);
  return { labels: set.labels, targetStr };
}

/** Run both `raises`-enforcement passes: declared clauses on `def`/`node`
 *  (`checkRaisesDeclarations`) and clauses on function types (this file). */
export function checkAllRaises(
  scopes: ScopeInfo[],
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
  ctx: TypeCheckerContext,
): void {
  checkRaisesDeclarations(interruptEffectsByFunction, ctx);
  checkFunctionTypeRaises(scopes, interruptEffectsByFunction, ctx);
}

export function checkFunctionTypeRaises(
  scopes: ScopeInfo[],
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
  ctx: TypeCheckerContext,
): void {
  const check = (
    src: Expression,
    target: VariableType | "any" | null | undefined,
    info: ScopeInfo,
    loc: SourceLocation | undefined,
  ): void => {
    const allowed = targetAllowed(target, ctx);
    if (!allowed) return;
    const e = functionValueEffects(src, info, interruptEffectsByFunction, ctx);
    const who = e.sourceName ? `'${e.sourceName}'` : "this value";
    const allow = `'raises <${allowed.labels.join(", ")}>' allowed by type '${allowed.targetStr}'`;
    if (e.any) {
      ctx.errors.push({
        message: `${who} may raise any effect (its type has no 'raises' clause), which exceeds the ${allow}. Add a 'raises' clause to the value's type.`,
        severity: "error",
        loc,
      });
      return;
    }
    for (const effect of e.labels) {
      if (!allowed.labels.includes(effect)) {
        ctx.errors.push({
          message: `${who} raises effect '${effect}', which exceeds the ${allow}. Add '${effect}' to the clause, or use a target type that allows it.`,
          severity: "error",
          loc,
        });
      }
    }
  };

  for (const info of scopes) {
    ctx.withScope(info.scopeKey, () => {
      for (const { node } of walkNodes(info.body)) {
        if (node.type === "assignment") {
          // Object-field targets (`x.y = f`) are out of scope.
          if (node.accessChain && node.accessChain.length > 0) continue;
          if (node.value.type === "messageThread") continue;
          // Annotated declaration uses the annotation; a bare re-assignment
          // (`cb = f`) uses the variable's declared type.
          const target = node.typeHint ?? info.scope.lookup(node.variableName);
          check(node.value, target, info, node.loc);
        } else if (node.type === "returnStatement") {
          if (node.value) check(node.value, info.returnType, info, node.loc);
        } else if (node.type === "functionCall") {
          const def = ctx.functionDefs[node.functionName] ?? ctx.nodeDefs[node.functionName];
          // `functionDefs` is a plain object, so a callee named "constructor" /
          // "toString" resolves to an inherited Object.prototype method — truthy
          // but with no `parameters`. Require a real parameter list.
          if (!def || !Array.isArray(def.parameters)) continue;
          const sig = paramListSignature(def.parameters, node.arguments.length);
          node.arguments.forEach((arg, i) => {
            if (arg.type === "splat") return;
            if (arg.type === "namedArgument") {
              const t = sig.resolveSlot({ kind: "named", name: arg.name })?.type;
              check(arg.value, t, info, node.loc);
            } else {
              const t = sig.resolveSlot({ kind: "positional", index: i })?.type;
              check(arg, t, info, node.loc);
            }
          });
          // A trailing block binds to the LAST parameter (the backend pushes it
          // as the final positional argument).
          if (node.block) {
            const last = def.parameters[def.parameters.length - 1];
            check(node.block, last?.typeHint, info, node.loc);
          }
        }
      }
    });
  }
}
