import { AgencyNode, FunctionParameter, VariableType } from "../types.js";
import { formatTypeHint } from "../cli/util.js";
import { isAssignable } from "./assignability.js";
import { synthType } from "./synthesizer.js";
import { TypeCheckerContext } from "./types.js";
import { Scope } from "./scope.js";

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
  switch (t.type) {
    case "primitiveType":
      return t.value === "regex";
    case "arrayType":
      return containsRegex(t.elementType);
    case "unionType":
      return t.types.some(containsRegex);
    case "objectType":
      return t.properties.some((p) => containsRegex(p.value));
    case "resultType":
      return containsRegex(t.successType) || containsRegex(t.failureType);
    default:
      return false;
  }
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
}
