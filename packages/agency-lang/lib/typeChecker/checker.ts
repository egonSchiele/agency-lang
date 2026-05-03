import {
  FunctionCall,
  VariableType,
} from "../types.js";
import { walkNodes } from "../utils/node.js";
import { formatTypeHint } from "../cli/util.js";
import { BUILTIN_FUNCTION_TYPES } from "./builtins.js";
import { isAssignable } from "./assignability.js";
import { synthType } from "./synthesizer.js";
import { ScopeInfo } from "./types.js";
import type { TypeCheckerContext } from "./types.js";
import { checkType } from "./utils.js";
import { Scope } from "./scope.js";

export function checkScopes(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): void {
  for (const scope of scopes) {
    ctx.withScope(scope.scopeKey, () => {
      checkFunctionCallsInScope(scope, ctx);
      if (scope.returnType !== undefined) {
        checkReturnTypesInScope(scope, ctx);
      }
      checkExpressionsInScope(scope, ctx);
    });
  }
}

function checkFunctionCallsInScope(
  info: ScopeInfo,
  ctx: TypeCheckerContext,
): void {
  for (const { node } of walkNodes(info.body)) {
    if (node.type === "functionCall") {
      checkSingleFunctionCall(node, info.scope, ctx);
    }
  }
}

function checkSingleFunctionCall(
  call: FunctionCall,
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  if (call.functionName in BUILTIN_FUNCTION_TYPES) {
    const sig = BUILTIN_FUNCTION_TYPES[call.functionName];
    const minArgs = sig.minParams ?? sig.params.length;
    const maxArgs = sig.params.length;
    if (call.arguments.length < minArgs || call.arguments.length > maxArgs) {
      const expected =
        minArgs === maxArgs ? `${minArgs}` : `${minArgs}-${maxArgs}`;
      ctx.errors.push({
        message: `Expected ${expected} argument(s) for '${call.functionName}', but got ${call.arguments.length}.`,
      });
      return;
    }
    checkArgsAgainstParams(call, sig.params, scope, ctx);
    return;
  }

  const def = ctx.functionDefs[call.functionName] ?? ctx.nodeDefs[call.functionName];
  if (!def) return;

  if (call.arguments.length !== def.parameters.length) {
    ctx.errors.push({
      message: `Expected ${def.parameters.length} argument(s) for '${call.functionName}', but got ${call.arguments.length}.`,
    });
    return;
  }
  checkArgsAgainstParams(
    call,
    def.parameters.map((p) => p.typeHint),
    scope,
    ctx,
  );
}

/**
 * Type-check each positional arg against the parameter type at the same
 * index. `undefined` paramType (user-defined functions without an
 * annotation) and `"any"` paramType (lenient builtins) are skipped.
 *
 * NOTE: splat args are skipped — we don't yet check that the splat's
 * element type satisfies the remaining positional params. See follow-up.
 */
function checkArgsAgainstParams(
  call: FunctionCall,
  paramTypes: (VariableType | "any" | undefined)[],
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  const typeAliases = ctx.getTypeAliases();
  for (let i = 0; i < call.arguments.length; i++) {
    const arg = call.arguments[i];
    if (arg.type === "splat") continue;
    const innerArg = arg.type === "namedArgument" ? arg.value : arg;
    const argType = synthType(innerArg, scope, ctx);
    const paramType = paramTypes[i];
    if (paramType === undefined || paramType === "any" || argType === "any") {
      continue;
    }
    if (!isAssignable(argType, paramType, typeAliases)) {
      ctx.errors.push({
        message: `Argument type '${formatTypeHint(argType)}' is not assignable to parameter type '${formatTypeHint(paramType)}' in call to '${call.functionName}'.`,
        expectedType: formatTypeHint(paramType),
        actualType: formatTypeHint(argType),
      });
    }
  }
}

function checkReturnTypesInScope(
  info: ScopeInfo,
  ctx: TypeCheckerContext,
): void {
  if (!info.returnType) return;

  for (const { node } of walkNodes(info.body)) {
    if (node.type === "returnStatement" && node.value) {
      checkType(
        node.value,
        info.returnType,
        info.scope,
        `return in '${info.name}'`,
        ctx,
      );
    }
  }
}

function checkExpressionsInScope(
  info: ScopeInfo,
  ctx: TypeCheckerContext,
): void {
  for (const { node } of walkNodes(info.body)) {
    if (node.type === "valueAccess") {
      synthType(node, info.scope, ctx);
    } else if (node.type === "returnStatement" && node.value) {
      synthType(node.value, info.scope, ctx);
    }
  }
}
