import { AgencyNode, FunctionParameter, VariableType } from "../types.js";
import type { BlockType } from "../types/typeHints.js";
import { formatTypeHint } from "../utils/formatType.js";
import { isAssignable, resolveType } from "./assignability.js";
import { synthType } from "./synthesizer.js";
import { TypeCheckerContext } from "./types.js";
import { Scope } from "./scope.js";
import { visitTypes } from "./typeWalker.js";

/**
 * Look up the parameter list for a callable name across local defs, graph
 * nodes, and imported functions — the resolution order used at every call
 * site that needs to inspect a callee's signature.
 */
export function getParamsForNodeOrFunc(
  name: string,
  ctx: TypeCheckerContext,
): FunctionParameter[] | undefined {
  const def =
    ctx.functionDefs[name] ?? ctx.nodeDefs[name] ?? ctx.importedFunctions[name];
  return def?.parameters;
}

/**
 * If the named callable's last parameter is `blockType`, return that signature
 * — the slot a trailing/inline block fills. Returns undefined for callables
 * whose block param is untyped, `any`, or absent (block bodies in those cases
 * keep their literal annotations and aren't checked against a contract).
 */
export function getBlockSlot(
  name: string,
  ctx: TypeCheckerContext,
): BlockType | undefined {
  const params = getParamsForNodeOrFunc(name, ctx);
  if (!params || params.length === 0) return undefined;
  const last = params[params.length - 1];
  if (last.typeHint?.type !== "blockType") return undefined;
  return last.typeHint;
}

export function isAnyType(t: VariableType): boolean {
  return t.type === "primitiveType" && t.value === "any";
}

/**
 * The `regex` primitive isn't representable in JSON, so an LLM can't return
 * one as structured output. Walk the expected LLM-call type and reject any
 * regex usage with a clear diagnostic, rather than silently emitting a
 * z.instanceof(RegExp) schema the LLM can't satisfy.
 */
function rejectRegexInLlmType(
  t: VariableType,
  loc: AgencyNode["loc"],
  context: string,
  ctx: TypeCheckerContext,
): void {
  if (containsRegex(t)) {
    ctx.errors.push({
      message: `'regex' cannot appear in an llm() structured-output type (${context}); LLMs can't return regex values through JSON.`,
      loc,
    });
  }
}

function containsRegex(t: VariableType): boolean {
  return visitTypes(
    t,
    (n) => n.type === "primitiveType" && n.value === "regex",
  );
}

/**
 * Check mode (top-down): verify that an expression is compatible with expectedType.
 * Shared by scopes.ts (assignment checking) and checker.ts (return type checking).
 */
export function checkType(
  expr: AgencyNode,
  expectedType: VariableType,
  scope: Scope,
  context: string,
  ctx: TypeCheckerContext,
): void {
  if (expr.type === "functionCall" && expr.functionName === "llm") {
    rejectRegexInLlmType(expectedType, expr.loc, context, ctx);
    return;
  }

  const actualType = synthType(expr, scope, ctx);
  if (actualType === "any") return;

  const typeAliases = ctx.getTypeAliases();
  if (!isAssignable(actualType, expectedType, typeAliases)) {
    ctx.errors.push({
      message: `Type '${formatTypeHint(actualType)}' is not assignable to type '${formatTypeHint(expectedType)}' (${context}).`,
      expectedType: formatTypeHint(expectedType),
      actualType: formatTypeHint(actualType),
      loc: expr.loc,
    });
  }
  if (expr.type === "agencyObject") {
    checkExcessObjectProperties(expr, expectedType, context, ctx);
  }
}

/**
 * When an object literal meets an object-typed target, every key must
 * correspond to a declared property. Mirrors TypeScript's excess-property
 * check; without it, typos like `modle:` slip through structural
 * assignability. Splat entries are dynamic and skipped.
 */
export function checkExcessObjectProperties(
  literal: AgencyNode & { type: "agencyObject" },
  expectedType: VariableType,
  context: string,
  ctx: TypeCheckerContext,
): void {
  const resolved = resolveType(expectedType, ctx.getTypeAliases());
  if (resolved.type !== "objectType") return;
  const known = new Set(resolved.properties.map((p) => p.key));
  for (const entry of literal.entries) {
    if ("type" in entry) continue; // splat
    if (!known.has(entry.key)) {
      ctx.errors.push({
        message: `Unknown property '${entry.key}' on type '${formatTypeHint(expectedType)}' (${context}).`,
        loc: literal.loc,
      });
    }
  }
}
