import { AgencyNode, VariableType } from "../types.js";
import { formatTypeHint } from "../cli/util.js";
import { isAssignable } from "./assignability.js";
import { synthType } from "./synthesizer.js";
import { TypeCheckerContext } from "./types.js";
import { Scope } from "./scope.js";

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
  if (expr.type === "functionCall" && expr.functionName === "llm") return;

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
