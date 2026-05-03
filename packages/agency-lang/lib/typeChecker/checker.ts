import {
  AgencyNode,
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
  // A splat can expand to any number of positional args, so skip arity
  // checking when one is present. The splat element-type check still runs.
  const hasSplatArg = call.arguments.some((a) => a.type === "splat");

  if (call.functionName in BUILTIN_FUNCTION_TYPES) {
    const sig = BUILTIN_FUNCTION_TYPES[call.functionName];
    const minArgs = sig.minParams ?? sig.params.length;
    const hasRest = sig.restParam !== undefined;
    const maxArgs = hasRest ? Infinity : sig.params.length;
    if (
      !hasSplatArg &&
      (call.arguments.length < minArgs || call.arguments.length > maxArgs)
    ) {
      const expected = hasRest
        ? `at least ${minArgs}`
        : minArgs === maxArgs
          ? `${minArgs}`
          : `${minArgs}-${maxArgs}`;
      ctx.errors.push({
        message: `Expected ${expected} argument(s) for '${call.functionName}', but got ${call.arguments.length}.`,
      });
      return;
    }
    const paramTypes: (VariableType | "any" | undefined)[] = [...sig.params];
    if (hasRest) {
      while (paramTypes.length < call.arguments.length) {
        paramTypes.push(sig.restParam!);
      }
    }
    checkArgsAgainstParams(call, paramTypes, scope, ctx);
    return;
  }

  const def = ctx.functionDefs[call.functionName] ?? ctx.nodeDefs[call.functionName];
  if (!def) return;

  if (!hasSplatArg && call.arguments.length !== def.parameters.length) {
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
 * For splat args, verify the splat is an array and that its element type
 * is assignable to each remaining positional param. We then stop checking
 * subsequent fixed args, since we can't tell statically how many positions
 * the splat consumes.
 */
function checkArgsAgainstParams(
  call: FunctionCall,
  paramTypes: (VariableType | "any" | undefined)[],
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  const typeAliases = ctx.getTypeAliases();
  for (let argIndex = 0; argIndex < call.arguments.length; argIndex++) {
    const arg = call.arguments[argIndex];
    if (arg.type === "splat") {
      checkSplatAgainstRemainingParams(call, arg.value, argIndex, paramTypes, scope, ctx);
      return;
    }
    const innerArg = arg.type === "namedArgument" ? arg.value : arg;
    const argType = synthType(innerArg, scope, ctx);
    const paramType = paramTypes[argIndex];
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

/**
 * Check a splat argument against the remaining positional params. The splat's
 * source must synth to an array, and its element type must be assignable to
 * each remaining param.
 */
function checkSplatAgainstRemainingParams(
  call: FunctionCall,
  splatSource: AgencyNode,
  splatIndex: number,
  paramTypes: (VariableType | "any" | undefined)[],
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  const splatType = synthType(splatSource, scope, ctx);
  if (splatType === "any") return;
  if (splatType.type !== "arrayType") {
    const splatStr = formatTypeHint(splatType);
    ctx.errors.push({
      message: `Splat argument must be an array, got '${splatStr}' in call to '${call.functionName}'.`,
      actualType: splatStr,
    });
    return;
  }
  const elementType = splatType.elementType;
  const elementStr = formatTypeHint(elementType);
  const typeAliases = ctx.getTypeAliases();
  for (const remainingParam of paramTypes.slice(splatIndex)) {
    if (remainingParam === undefined || remainingParam === "any") continue;
    if (isAssignable(elementType, remainingParam, typeAliases)) continue;
    const paramStr = formatTypeHint(remainingParam);
    ctx.errors.push({
      message: `Splat element type '${elementStr}' is not assignable to parameter type '${paramStr}' in call to '${call.functionName}'.`,
      expectedType: paramStr,
      actualType: elementStr,
    });
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

const BOOLEAN_TYPE: VariableType = { type: "primitiveType", value: "boolean" };

function checkExpressionsInScope(
  info: ScopeInfo,
  ctx: TypeCheckerContext,
): void {
  for (const { node } of walkNodes(info.body)) {
    if (node.type === "valueAccess") {
      synthType(node, info.scope, ctx);
    } else if (node.type === "returnStatement" && node.value) {
      synthType(node.value, info.scope, ctx);
    } else if (node.type === "ifElse" || node.type === "whileLoop") {
      checkType(node.condition, BOOLEAN_TYPE, info.scope, "condition", ctx);
    }
  }
}
