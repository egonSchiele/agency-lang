import {
  FunctionCall,
  VariableType,
} from "../types.js";
import { walkNodes } from "../utils/node.js";
import { formatTypeHint } from "../cli/util.js";
import { BUILTIN_FUNCTION_TYPES } from "./builtins.js";
import { isAssignable } from "./assignability.js";
import { synthType, SynthContext } from "./synthesizer.js";
import { ScopeInfo } from "./types.js";
import type { TypeCheckerContext } from "./types.js";
import { checkType } from "./utils.js";

export function checkScopes(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
  synthCtx: SynthContext,
): void {
  for (const scope of scopes) {
    ctx.withScope(scope.scopeKey, () => {
      checkFunctionCallsInScope(scope, synthCtx);
      if (scope.returnType !== undefined) {
        checkReturnTypesInScope(scope, synthCtx);
      }
      checkExpressionsInScope(scope, synthCtx);
    });
  }
}

function checkFunctionCallsInScope(
  scope: ScopeInfo,
  ctx: SynthContext,
): void {
  for (const { node } of walkNodes(scope.body)) {
    if (node.type === "functionCall") {
      checkSingleFunctionCall(node, scope.variableTypes, ctx);
    }
  }
}

function checkSingleFunctionCall(
  call: FunctionCall,
  scopeVars: Record<string, VariableType | "any">,
  ctx: SynthContext,
): void {
  const typeAliases = ctx.getTypeAliases();

  // Check builtins using their type signatures
  if (call.functionName in BUILTIN_FUNCTION_TYPES) {
    const sig = BUILTIN_FUNCTION_TYPES[call.functionName];

    const minArgs = sig.minParams ?? sig.params.length;
    const maxArgs = sig.params.length;
    if (call.arguments.length < minArgs || call.arguments.length > maxArgs) {
      const expected = minArgs === maxArgs ? `${minArgs}` : `${minArgs}–${maxArgs}`;
      ctx.errors.push({
        message: `Expected ${expected} argument(s) for '${call.functionName}', but got ${call.arguments.length}.`,
      });
      return;
    }

    for (let i = 0; i < call.arguments.length; i++) {
      const arg = call.arguments[i];
      if (arg.type === "splat") continue;
      const innerArg = arg.type === "namedArgument" ? arg.value : arg;
      const argType = synthType(innerArg, scopeVars, ctx);
      const paramType = sig.params[i];
      if (paramType === "any") continue;
      if (argType === "any") continue;

      if (!isAssignable(argType, paramType, typeAliases)) {
        ctx.errors.push({
          message: `Argument type '${formatTypeHint(argType)}' is not assignable to parameter type '${formatTypeHint(paramType)}' in call to '${call.functionName}'.`,
          expectedType: formatTypeHint(paramType),
          actualType: formatTypeHint(argType),
        });
      }
    }
    return;
  }

  const fn = ctx.functionDefs[call.functionName];
  const graphNode = ctx.nodeDefs[call.functionName];
  const def = fn ?? graphNode;
  if (!def) return;

  const params = def.parameters;

  if (call.arguments.length !== params.length) {
    ctx.errors.push({
      message: `Expected ${params.length} argument(s) for '${call.functionName}', but got ${call.arguments.length}.`,
    });
    return;
  }

  for (let i = 0; i < call.arguments.length; i++) {
    const arg = call.arguments[i];
    if (arg.type === "splat") continue;
    const innerArg = arg.type === "namedArgument" ? arg.value : arg;
    const argType = synthType(innerArg, scopeVars, ctx);
    const paramType = params[i].typeHint;
    if (!paramType) continue;
    if (argType === "any") continue;

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
  scope: ScopeInfo,
  ctx: SynthContext,
): void {
  if (!scope.returnType) return;

  for (const { node } of walkNodes(scope.body)) {
    if (node.type === "returnStatement" && node.value) {
      checkType(
        node.value,
        scope.returnType,
        scope.variableTypes,
        `return in '${scope.name}'`,
        ctx,
      );
    }
  }
}

function checkExpressionsInScope(
  scope: ScopeInfo,
  ctx: SynthContext,
): void {
  for (const { node } of walkNodes(scope.body)) {
    if (node.type === "valueAccess") {
      synthType(node, scope.variableTypes, ctx);
    } else if (node.type === "returnStatement" && node.value) {
      synthType(node.value, scope.variableTypes, ctx);
    }
  }
}
