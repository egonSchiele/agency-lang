import type { FunctionDefinition, GraphNodeDefinition } from "../types.js";
import { AgencyNode, VariableType } from "../types.js";
import { formatTypeHint } from "../cli/util.js";
import { isAssignable } from "./assignability.js";
import { synthType, SynthContext } from "./synthesizer.js";
import { TypeCheckerContext } from "./types.js";

/**
 * Check mode (top-down): verify that an expression is compatible with expectedType.
 * Shared by scopes.ts (assignment checking) and checker.ts (return type checking).
 */
export function checkType(
  expr: AgencyNode,
  expectedType: VariableType,
  scopeVars: Record<string, VariableType | "any">,
  context: string,
  ctx: SynthContext,
): void {
  if (expr.type === "functionCall" && expr.functionName === "llm") return;

  const actualType = synthType(expr, scopeVars, ctx);
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

/**
 * Create a SynthContext from a TypeCheckerContext.
 * Broken out to avoid circular dependencies between inference.ts and scopes.ts.
 */
export function makeSynthContext(
  ctx: TypeCheckerContext,
  inferReturnTypeFor: (name: string, def: FunctionDefinition | GraphNodeDefinition) => VariableType | "any",
): SynthContext {
  return {
    functionDefs: ctx.functionDefs,
    nodeDefs: ctx.nodeDefs,
    inferredReturnTypes: ctx.inferredReturnTypes,
    inferringReturnType: ctx.inferringReturnType,
    errors: ctx.errors,
    config: ctx.config,
    getTypeAliases: () => ctx.getTypeAliases(),
    inferReturnTypeFor,
  };
}
