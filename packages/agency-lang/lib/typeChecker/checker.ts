import {
  FunctionCall,
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
      checkAssignmentsInScope(scope, ctx);
      checkFunctionCallsInScope(scope, ctx);
      if (scope.returnType !== undefined) {
        checkReturnTypesInScope(scope, ctx);
      }
      checkExpressionsInScope(scope, ctx);
    });
  }
}

/**
 * Verify that each assignment's value is compatible with the binding's
 * declared type. Re-declaration incompatibility (annotation vs. annotation)
 * is reported earlier in declareVariable, where statement order is preserved.
 */
function checkAssignmentsInScope(
  info: ScopeInfo,
  ctx: TypeCheckerContext,
): void {
  const typeAliases = ctx.getTypeAliases();
  for (const { node } of walkNodes(info.body)) {
    if (node.type !== "assignment") continue;
    const existingType = info.scope.lookup(node.variableName);
    const newType = node.typeHint;
    const loc = node.loc;

    if (newType) {
      checkType(
        node.value,
        newType,
        info.scope,
        `assignment to '${node.variableName}'`,
        ctx,
      );
    } else if (existingType) {
      const valueType = synthType(node.value, info.scope, ctx);
      if (
        valueType !== "any" &&
        existingType !== "any" &&
        !isAssignable(valueType, existingType, typeAliases)
      ) {
        ctx.errors.push({
          message: `Type '${typeof valueType === "string" ? valueType : formatTypeHint(valueType)}' is not assignable to type '${formatTypeHint(existingType)}'.`,
          variableName: node.variableName,
          expectedType: formatTypeHint(existingType),
          actualType:
            typeof valueType === "string"
              ? valueType
              : formatTypeHint(valueType),
          loc,
        });
      }
    }
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
  const typeAliases = ctx.getTypeAliases();

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
      const argType = synthType(innerArg, scope, ctx);
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
    const argType = synthType(innerArg, scope, ctx);
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
