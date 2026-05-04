import {
  AgencyNode,
  FunctionCall,
  FunctionParameter,
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

/**
 * Derive arity bounds and per-position param types from a parameter list,
 * honoring optional (`defaultValue`) and rest (`variadic`) parameters.
 *
 * For a variadic last parameter declared as `...xs: T[]`, every arg at or
 * past its position is checked against the array's element type `T`.
 */
/**
 * Per-arg type for a variadic param. `...xs: T[]` means each incoming arg
 * is a `T`; if the typeHint isn't an arrayType (e.g. untyped `...args`),
 * fall back to its raw hint or "any".
 */
function variadicElementType(
  param: FunctionParameter,
): VariableType | "any" | undefined {
  if (param.typeHint?.type === "arrayType") return param.typeHint.elementType;
  return param.typeHint ?? "any";
}

type ParamSlot = {
  type: VariableType | "any" | undefined;
  validated: boolean;
};

function paramListSignature(params: FunctionParameter[], argCount: number): {
  minArgs: number;
  maxArgs: number;
  slots: ParamSlot[];
} {
  const lastParam = params[params.length - 1];
  const hasRest = lastParam?.variadic === true;
  const minArgs = params.filter(
    (p) => p.defaultValue === undefined && !p.variadic,
  ).length;
  const maxArgs = hasRest ? Infinity : params.length;

  const slots: ParamSlot[] = params.map((p) => ({
    type: p.typeHint,
    validated: !!p.validated,
  }));
  if (hasRest) {
    // Replace the variadic slot's array type with the element type, so a
    // single arg at that position is checked element-wise. Then extend to
    // cover any extra args.
    const elementType = variadicElementType(lastParam);
    const restSlot: ParamSlot = {
      type: elementType,
      validated: slots[slots.length - 1]?.validated ?? false,
    };
    slots[slots.length - 1] = restSlot;
    while (slots.length < argCount) slots.push(restSlot);
  }
  return { minArgs, maxArgs, slots };
}

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

  // Resolution order: local definition → imported (cross-file) → builtin
  // fallback. Importeds take precedence over builtins so a real stdlib
  // function shadows a hardcoded signature when SymbolTable info is wired in.
  const def = ctx.functionDefs[call.functionName] ?? ctx.nodeDefs[call.functionName];
  const importedSig = ctx.importedFunctions[call.functionName];
  const params = def?.parameters ?? importedSig?.parameters;

  if (params) {
    if (!checkNamedArgStructure(call, params, ctx)) return;
    const { minArgs, maxArgs, slots } = paramListSignature(
      params,
      call.arguments.length,
    );
    if (!checkArity(call, minArgs, maxArgs, hasSplatArg, ctx)) return;
    checkArgsAgainstParams(call, slots, scope, ctx, params);
    return;
  }

  if (call.functionName in BUILTIN_FUNCTION_TYPES) {
    const sig = BUILTIN_FUNCTION_TYPES[call.functionName];
    const minArgs = sig.minParams ?? sig.params.length;
    const hasRest = sig.restParam !== undefined;
    const maxArgs = hasRest ? Infinity : sig.params.length;
    if (!checkArity(call, minArgs, maxArgs, hasSplatArg, ctx)) return;
    const slots: ParamSlot[] = sig.params.map((type) => ({ type, validated: false }));
    if (hasRest) {
      while (slots.length < call.arguments.length) {
        slots.push({ type: sig.restParam!, validated: false });
      }
    }
    checkArgsAgainstParams(call, slots, scope, ctx, undefined);
  }
}

/**
 * Catch structural mistakes in named-arg usage that have nothing to do with
 * types: duplicates, positionals after named, and named args that target a
 * slot already filled positionally. Mirrors what the backend rejects at
 * codegen time (typescriptBuilder.ts), but earlier with proper diagnostics.
 *
 * Returns false to signal the caller to bail before per-arg type checking —
 * once arg/slot alignment is broken, type errors would be misleading.
 */
function checkNamedArgStructure(
  call: FunctionCall,
  params: FunctionParameter[],
  ctx: TypeCheckerContext,
): boolean {
  const namedStartIdx = call.arguments.findIndex((a) => a.type === "namedArgument");
  if (namedStartIdx < 0) return true;

  let ok = true;

  for (let i = namedStartIdx + 1; i < call.arguments.length; i++) {
    const a = call.arguments[i];
    if (a.type !== "namedArgument" && a.type !== "splat") {
      ctx.errors.push({
        message: `Positional argument cannot follow a named argument in call to '${call.functionName}'.`,
        loc: call.loc,
      });
      ok = false;
      break;
    }
  }

  // Variadic and block params can't be passed by name (matches backend).
  const nameableParams = params.filter(
    (p) => !p.variadic && p.typeHint?.type !== "blockType",
  );
  const seen = new Set<string>();
  for (let i = namedStartIdx; i < call.arguments.length; i++) {
    const arg = call.arguments[i];
    if (arg.type !== "namedArgument") continue;
    if (seen.has(arg.name)) {
      ctx.errors.push({
        message: `Duplicate named argument '${arg.name}' in call to '${call.functionName}'.`,
        loc: call.loc,
      });
      ok = false;
      continue;
    }
    seen.add(arg.name);
    const paramIdx = nameableParams.findIndex((p) => p.name === arg.name);
    // Unknown-name errors are emitted later in checkArgsAgainstParams.
    if (paramIdx < 0) continue;
    if (paramIdx < namedStartIdx) {
      ctx.errors.push({
        message: `Named argument '${arg.name}' conflicts with positional argument at position ${paramIdx + 1} in call to '${call.functionName}'.`,
        loc: call.loc,
      });
      ok = false;
    }
  }

  return ok;
}

/**
 * Validate arg count against [minArgs, maxArgs]. Pushes an error and returns
 * `false` (caller should bail) when arity is wrong and there's no splat. With
 * a splat present we can't tell the count statically, so always return `true`
 * and let the splat element-type check run.
 */
function checkArity(
  call: FunctionCall,
  minArgs: number,
  maxArgs: number,
  hasSplatArg: boolean,
  ctx: TypeCheckerContext,
): boolean {
  if (hasSplatArg) return true;
  if (call.arguments.length >= minArgs && call.arguments.length <= maxArgs) return true;
  ctx.errors.push({
    message: `Expected ${formatArity(minArgs, maxArgs)} argument(s) for '${call.functionName}', but got ${call.arguments.length}.`,
    loc: call.loc,
  });
  return false;
}

function formatArity(minArgs: number, maxArgs: number): string {
  if (maxArgs === Infinity) return `at least ${minArgs}`;
  if (minArgs === maxArgs) return `${minArgs}`;
  return `${minArgs}-${maxArgs}`;
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
  slots: ParamSlot[],
  scope: Scope,
  ctx: TypeCheckerContext,
  params: FunctionParameter[] | undefined,
): void {
  const typeAliases = ctx.getTypeAliases();
  for (let argIndex = 0; argIndex < call.arguments.length; argIndex++) {
    const arg = call.arguments[argIndex];
    if (arg.type === "splat") {
      checkSplatAgainstRemainingParams(call, arg.value, argIndex, slots, scope, ctx);
      return;
    }
    let slot: ParamSlot | undefined;
    let innerArg: AgencyNode;
    if (arg.type === "namedArgument") {
      // Resolve the slot by parameter name. Builtins (no `params`) can't
      // express named args; the runtime / backend rejects those, but we
      // skip the type check here rather than emit a confusing error.
      const paramIdx = params?.findIndex((p) => p.name === arg.name) ?? -1;
      if (params && paramIdx < 0) {
        ctx.errors.push({
          message: `Unknown named argument '${arg.name}' in call to '${call.functionName}'.`,
          loc: call.loc,
        });
        continue;
      }
      slot = paramIdx >= 0 ? slots[paramIdx] : undefined;
      innerArg = arg.value;
    } else {
      slot = slots[argIndex];
      innerArg = arg;
    }
    const argType = synthType(innerArg, scope, ctx);
    const paramType = slot?.type;
    if (paramType === undefined || paramType === "any" || argType === "any") {
      continue;
    }
    // Validated params accept either the un-bang'd type T or any Result —
    // failures pass through unvalidated per docs-new/guide/schemas.md.
    if (slot?.validated && argType.type === "resultType") {
      continue;
    }
    if (!isAssignable(argType, paramType, typeAliases)) {
      ctx.errors.push({
        message: `Argument type '${formatTypeHint(argType)}' is not assignable to parameter type '${formatTypeHint(paramType)}' in call to '${call.functionName}'.`,
        expectedType: formatTypeHint(paramType),
        actualType: formatTypeHint(argType),
        loc: call.loc,
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
  slots: ParamSlot[],
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
      loc: call.loc,
    });
    return;
  }
  const elementType = splatType.elementType;
  const elementStr = formatTypeHint(elementType);
  const typeAliases = ctx.getTypeAliases();
  for (const slot of slots.slice(splatIndex)) {
    const paramType = slot.type;
    if (paramType === undefined || paramType === "any") continue;
    if (isAssignable(elementType, paramType, typeAliases)) continue;
    const paramStr = formatTypeHint(paramType);
    ctx.errors.push({
      message: `Splat element type '${elementStr}' is not assignable to parameter type '${paramStr}' in call to '${call.functionName}'.`,
      expectedType: paramStr,
      actualType: elementStr,
      loc: call.loc,
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
    } else if (node.type === "binOpExpression" && node.operator === "catch") {
      checkCatchDefaultType(node, info.scope, ctx);
    } else if (
      node.type === "binOpExpression" &&
      (node.operator === "=~" || node.operator === "!~")
    ) {
      checkRegexMatch(node, info.scope, ctx);
    } else if (node.type === "binOpExpression" && node.operator === "|>") {
      // synth runs validatePipeArg as a side effect; needed so a pipe whose
      // result is discarded (or used purely for its short-circuit behavior)
      // still gets its slot-type check.
      synthType(node, info.scope, ctx);
    }
  }
}

/**
 * `expr catch default`: the default arm replaces the value on failure, so
 * its type must be assignable to whatever `expr` evaluates to. When `expr`
 * is a Result<T>, that's `T`; otherwise (catch on a non-Result is a no-op
 * at runtime) it's the left's own type.
 */
/**
 * `s =~ /re/` and `s !~ /re/` compile to `/re/.test(s)`. The left operand
 * must be a string, the right must be a regex literal (or value of `regex`
 * type). Catching this at compile time avoids runtime "X.test is not a
 * function" surprises when a user forgets the regex literal syntax.
 */
function checkRegexMatch(
  node: AgencyNode & { type: "binOpExpression" },
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  const STRING: VariableType = { type: "primitiveType", value: "string" };
  const REGEX: VariableType = { type: "primitiveType", value: "regex" };
  checkType(node.left, STRING, scope, `left of '${node.operator}'`, ctx);
  checkType(node.right, REGEX, scope, `right of '${node.operator}'`, ctx);
}

function checkCatchDefaultType(
  node: AgencyNode & { type: "binOpExpression" },
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  const left = synthType(node.left, scope, ctx);
  if (left === "any") return;
  const expected = left.type === "resultType" ? left.successType : left;
  checkType(node.right, expected, scope, "catch default", ctx);
}
