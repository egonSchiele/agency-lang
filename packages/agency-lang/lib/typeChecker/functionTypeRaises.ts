import { diagnostic } from "./diagnostics.js";
import type { SourceLocation } from "../types/base.js";
import type { TypeCheckError } from "./types.js";
import type {
  VariableType,
  Expression,
  Assignment,
  ReturnStatement,
  FunctionCall,
  FunctionParameter,
  AgencyNode,
} from "../types.js";
import type { InterruptEffect } from "../symbolTable.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import { walkNodes, isInsideBlock, type WalkAncestor } from "../utils/node.js";
import { safeResolveType } from "./assignability.js";
import { resolveEffectSet } from "./effectSets.js";
import { formatTypeHint } from "../utils/formatType.js";
import { paramListSignature } from "./checker.js";
import { checkRaisesDeclarations } from "./raisesDiagnostic.js";
import { functionValueEffects, type FnEffects } from "./functionValueEffects.js";

/**
 * Enforce a `raises` clause on a function TYPE. When a function value flows into
 * a function type that declares a `raises` clause, the value may not raise more
 * than the clause allows. Assignability stays purely structural; this pass owns
 * the effect comparison so the message can name the offending effect.
 *
 * The pass reads top-down: `valueFlows` says WHERE a function value meets a
 * function type; `targetAllowed` + `exceedances` say what counts as too much;
 * `functionValueEffects` (its own file) says what a given value raises.
 */

type EffectMap = Record<string, InterruptEffect[]>;

/** A function value flowing into a typed slot. `target` is the slot's declared
 *  type, or a nullish value when there is none (then there's nothing to check). */
type Flow = { source: Expression; target: VariableType | "any" | null | undefined };

// -- WHERE: the sites a node introduces --------------------------------------

/** `let cb: Callback = f` or a bare `cb = f`. Object-field targets are skipped. */
function assignmentFlows(node: Assignment, info: ScopeInfo): Flow[] {
  if (node.accessChain && node.accessChain.length > 0) return [];
  if (node.value.type === "messageThread") return [];
  const target = node.typeHint ?? info.scope.lookup(node.variableName);
  return [{ source: node.value, target }];
}

/** `return f`. A return inside a block belongs to the block, not the enclosing
 *  function, so its slot is a different clause and we skip it here. */
function returnFlows(
  node: ReturnStatement,
  ancestors: WalkAncestor[],
  info: ScopeInfo,
): Flow[] {
  if (isInsideBlock(ancestors)) return [];
  if (!node.value) return [];
  return [{ source: node.value, target: info.returnType }];
}

/** The callee's declared parameters — local `def`/`node` or imported — or null
 *  when the name isn't a resolvable function (a truthy inherited
 *  Object.prototype method like "constructor" has no `parameters`). */
function calleeParams(
  functionName: string,
  ctx: TypeCheckerContext,
): FunctionParameter[] | null {
  const def = ctx.functionDefs[functionName] ?? ctx.nodeDefs[functionName];
  const params = def?.parameters ?? ctx.importedFunctions[functionName]?.parameters;
  return Array.isArray(params) ? params : null;
}

/** Each function-valued call argument against its parameter's type. Positional
 *  pairing stops at the first splat, whose width is statically unknown. */
function argumentFlows(node: FunctionCall, params: FunctionParameter[]): Flow[] {
  const sig = paramListSignature(params, node.arguments.length);
  const flows: Flow[] = [];
  for (let i = 0; i < node.arguments.length; i++) {
    const arg = node.arguments[i];
    if (arg.type === "splat") break;
    const slot =
      arg.type === "namedArgument"
        ? sig.resolveSlot({ kind: "named", name: arg.name })
        : sig.resolveSlot({ kind: "positional", index: i });
    const source = arg.type === "namedArgument" ? arg.value : arg;
    flows.push({ source, target: slot?.type });
  }
  return flows;
}

/** A trailing block binds to the LAST parameter (the backend pushes it as the
 *  final positional argument). */
function blockFlow(node: FunctionCall, params: FunctionParameter[]): Flow[] {
  if (!node.block) return [];
  const last = params[params.length - 1];
  return [{ source: node.block, target: last?.typeHint }];
}

/** `f(reads)` / `runIt(cb: reads)` / `m(xs) as x { ... }`. A method call
 *  (`x.foo(...)`) resolves against the chain, not a same-named global def. */
function callFlows(
  node: FunctionCall,
  ancestors: WalkAncestor[],
  ctx: TypeCheckerContext,
): Flow[] {
  if (ancestors[ancestors.length - 1]?.type === "valueAccess") return [];
  const params = calleeParams(node.functionName, ctx);
  if (!params) return [];
  return [...argumentFlows(node, params), ...blockFlow(node, params)];
}

/** Every place a function value flows into a typed slot, for one AST node. */
function valueFlows(
  node: AgencyNode,
  ancestors: WalkAncestor[],
  info: ScopeInfo,
  ctx: TypeCheckerContext,
): Flow[] {
  if (node.type === "assignment") return assignmentFlows(node, info);
  if (node.type === "returnStatement") return returnFlows(node, ancestors, info);
  if (node.type === "functionCall") return callFlows(node, ancestors, ctx);
  return [];
}

// -- HOW MUCH: what the target allows, and what exceeds it --------------------

/** The effects a function-type target allows, or null for no constraint: not a
 *  function type, no `raises` clause, or `<*>` (which allows anything). */
function targetAllowed(
  target: VariableType | "any" | null | undefined,
  ctx: TypeCheckerContext,
): { labels: string[]; name: string } | null {
  if (!target || target === "any") return null;
  const resolved = safeResolveType(target, ctx.getTypeAliases());
  if (resolved.type !== "blockType" || !resolved.raises) return null;
  const allowed = resolveEffectSet(resolved.raises, ctx.getTypeAliases());
  if (allowed.any) return null;
  const name =
    target.type === "typeAliasVariable" ? target.aliasName : formatTypeHint(target);
  return { labels: allowed.labels, name };
}

/** The diagnostic(s) when `source` exceeds what `allowed` permits: one per
 *  offending effect, or a single one when the source may raise anything.
 *  {who} is a subject reference — a quoted name or "this value". */
function exceedances(
  source: FnEffects,
  allowed: { labels: string[]; name: string },
  loc: SourceLocation | null,
): TypeCheckError[] {
  const who = source.sourceName ? `'${source.sourceName}'` : "this value";
  const shared = { who, allowed: allowed.labels.join(", "), type: allowed.name };
  if (source.any) {
    return [diagnostic("valueMayRaiseAnyEffect", shared, loc)];
  }
  return source.labels
    .filter((effect) => !allowed.labels.includes(effect))
    .map((effect) =>
      diagnostic("valueEffectExceedsRaises", { ...shared, effect }, loc),
    );
}

// -- The pass ----------------------------------------------------------------

export function checkFunctionTypeRaises(
  scopes: ScopeInfo[],
  interruptEffectsByFunction: EffectMap,
  ctx: TypeCheckerContext,
): void {
  for (const info of scopes) {
    ctx.withScope(info.scopeKey, () => {
      for (const { node, ancestors } of walkNodes(info.body)) {
        for (const flow of valueFlows(node, ancestors, info, ctx)) {
          const allowed = targetAllowed(flow.target, ctx);
          if (!allowed) continue;
          const source = functionValueEffects(
            flow.source,
            info,
            interruptEffectsByFunction,
            ctx,
          );
          for (const err of exceedances(source, allowed, flow.source.loc ?? null)) {
            ctx.errors.push(err);
          }
        }
      }
    });
  }
}

/** Run both `raises`-enforcement passes: declared clauses on `def`/`node`
 *  (`checkRaisesDeclarations`) and clauses on function types (this file). */
export function checkAllRaises(
  scopes: ScopeInfo[],
  interruptEffectsByFunction: EffectMap,
  ctx: TypeCheckerContext,
): void {
  checkRaisesDeclarations(interruptEffectsByFunction, ctx);
  checkFunctionTypeRaises(scopes, interruptEffectsByFunction, ctx);
}
