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
import { checkType, isAnyType, getParamsForNodeOrFunc } from "./utils.js";
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
  /** Original parameter name. Absent for builtins (which can't take named args). */
  name?: string;
};

function paramListSignature(
  params: FunctionParameter[],
  argCount: number,
): {
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

  // Only nameable params (not variadic, not block-typed) get a `name` —
  // matching the backend's nameableParams filter (typescriptBuilder.ts).
  // Slots without names are unreachable by named-arg lookup, which is
  // exactly what we want for variadic/block slots.
  const isNameable = (p: FunctionParameter) =>
    !p.variadic && p.typeHint?.type !== "blockType";
  const slots: ParamSlot[] = params.map((p) => ({
    type: p.typeHint,
    validated: !!p.validated,
    name: isNameable(p) ? p.name : undefined,
  }));
  if (hasRest) {
    const elementType = variadicElementType(lastParam);
    const restSlot: ParamSlot = {
      type: elementType,
      validated: slots[slots.length - 1]?.validated ?? false,
      // Variadic by definition; not nameable.
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
  const def =
    ctx.functionDefs[call.functionName] ?? ctx.nodeDefs[call.functionName];
  const importedSig = ctx.importedFunctions[call.functionName];
  const params = def?.parameters ?? importedSig?.parameters;

  if (params) {
    if (!checkNamedArgStructure(call, params, ctx)) return;
    const { minArgs, maxArgs, slots } = paramListSignature(
      params,
      call.arguments.length,
    );
    if (!checkArity(call, minArgs, maxArgs, hasSplatArg, ctx)) return;
    checkArgsAgainstParams(call, slots, scope, ctx);
    return;
  }

  if (call.functionName in BUILTIN_FUNCTION_TYPES) {
    // Builtins don't have parameter names — named args have nowhere to bind.
    // The backend throws at codegen time (typescriptBuilder.ts); surface it
    // here with a proper diagnostic instead.
    if (call.arguments.some((a) => a.type === "namedArgument")) {
      ctx.errors.push({
        message: `Named arguments can only be used with Agency-defined functions, not '${call.functionName}'.`,
        loc: call.loc,
      });
      return;
    }
    const sig = BUILTIN_FUNCTION_TYPES[call.functionName];
    const minArgs = sig.minParams ?? sig.params.length;
    const hasRest = sig.restParam !== undefined;
    const maxArgs = hasRest ? Infinity : sig.params.length;
    if (!checkArity(call, minArgs, maxArgs, hasSplatArg, ctx)) return;
    const slots: ParamSlot[] = sig.params.map((type) => ({
      type,
      validated: false,
    }));
    if (hasRest) {
      while (slots.length < call.arguments.length) {
        slots.push({ type: sig.restParam!, validated: false });
      }
    }
    checkArgsAgainstParams(call, slots, scope, ctx);
  }
}

/**
 * Catch structural mistakes in named-arg usage (unknown names, duplicates,
 * positionals after named, name-conflicts-with-positional). Variadic and
 * block params can't be passed by name — same as the backend.
 *
 * Returns false when the arg/slot alignment is broken, so the caller bails
 * before per-arg type checks would emit misleading errors.
 */
function checkNamedArgStructure(
  call: FunctionCall,
  params: FunctionParameter[],
  ctx: TypeCheckerContext,
): boolean {
  const namedStartIdx = call.arguments.findIndex(
    (a) => a.type === "namedArgument",
  );
  if (namedStartIdx < 0) return true;

  let ok = true;
  const pushErr = (message: string) => {
    ctx.errors.push({ message, loc: call.loc });
    ok = false;
  };

  // Pass 1: positional args (other than splats) can't follow named args.
  for (let i = namedStartIdx + 1; i < call.arguments.length; i++) {
    const a = call.arguments[i];
    if (a.type !== "namedArgument" && a.type !== "splat") {
      pushErr(
        `Positional argument cannot follow a named argument in call to '${call.functionName}'.`,
      );
      break;
    }
  }

  // Pass 2: validate each named arg against the nameable params (variadic
  // and block-typed params can't be passed by name — same as the backend).
  const nameableParams = params.filter(
    (p) => !p.variadic && p.typeHint?.type !== "blockType",
  );
  const seen = new Set<string>();
  for (let i = namedStartIdx; i < call.arguments.length; i++) {
    const arg = call.arguments[i];
    if (arg.type !== "namedArgument") continue;
    if (seen.has(arg.name)) {
      pushErr(`Duplicate named argument '${arg.name}' in call to '${call.functionName}'.`);
      continue;
    }
    seen.add(arg.name);
    const paramIdx = nameableParams.findIndex((p) => p.name === arg.name);
    if (paramIdx < 0) {
      pushErr(`Unknown named argument '${arg.name}' in call to '${call.functionName}'.`);
    } else if (paramIdx < namedStartIdx) {
      pushErr(
        `Named argument '${arg.name}' conflicts with positional argument at position ${paramIdx + 1} in call to '${call.functionName}'.`,
      );
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
  if (call.arguments.length >= minArgs && call.arguments.length <= maxArgs)
    return true;
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
): void {
  const typeAliases = ctx.getTypeAliases();
  for (let argIndex = 0; argIndex < call.arguments.length; argIndex++) {
    const arg = call.arguments[argIndex];
    if (arg.type === "splat") {
      checkSplatAgainstRemainingParams(
        call,
        arg.value,
        argIndex,
        slots,
        scope,
        ctx,
      );
      return;
    }
    let slot: ParamSlot | undefined;
    let innerArg: AgencyNode;
    if (arg.type === "namedArgument") {
      // Unknown / variadic / block names are caught upstream in
      // checkNamedArgStructure; lookup here is best-effort.
      slot = slots.find((s) => s.name === arg.name);
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
      validatePipeArg(node, info.scope, ctx);
    }
  }
}

const STRING_T: VariableType = { type: "primitiveType", value: "string" };
const REGEX_T: VariableType = { type: "primitiveType", value: "regex" };

/**
 * Validate the LHS of `|>` against the slot it flows into on the RHS:
 * - bare variable RHS (`lhs |> half`) — slot is param 0
 * - functionCall RHS with `?` placeholder (`lhs |> add(?, 5)`) — slot is the placeholder's index
 *
 * The runtime auto-unwraps a Result LHS to its success value before passing
 * it to the next stage, so we compare against `lhs.successType` when LHS is
 * a Result.
 */
function validatePipeArg(
  expr: AgencyNode & { type: "binOpExpression" },
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  const slotType = pipeRhsSlotType(expr.right, ctx);
  if (slotType === undefined || slotType === "any") return;

  const leftType = synthType(expr.left, scope, ctx);
  if (leftType === "any") return;
  const flowingType =
    leftType.type === "resultType" ? leftType.successType : leftType;
  if (isAnyType(flowingType)) return;

  if (!isAssignable(flowingType, slotType, ctx.getTypeAliases())) {
    ctx.errors.push({
      message: `Type '${formatTypeHint(flowingType)}' is not assignable to pipe slot of type '${formatTypeHint(slotType)}'.`,
      expectedType: formatTypeHint(slotType),
      actualType: formatTypeHint(flowingType),
      loc: expr.loc,
    });
  }
}

function pipeRhsSlotType(
  rhs: AgencyNode,
  ctx: TypeCheckerContext,
): VariableType | "any" | undefined {
  if (rhs.type === "variableName") {
    const params = getParamsForNodeOrFunc(rhs.value, ctx);
    return params?.[0]?.typeHint;
  }
  if (rhs.type === "functionCall") {
    const params = getParamsForNodeOrFunc(rhs.functionName, ctx);
    if (!params) return undefined;
    // No placeholder = backend will reject; nothing to type-check here.
    const placeholderIdx = rhs.arguments.findIndex(
      (a) => a.type === "placeholder",
    );
    if (placeholderIdx < 0) return undefined;
    return params[placeholderIdx]?.typeHint;
  }
  return undefined;
}

function checkRegexMatch(
  node: AgencyNode & { type: "binOpExpression" },
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  checkType(node.left, STRING_T, scope, `left of '${node.operator}'`, ctx);
  checkType(node.right, REGEX_T, scope, `right of '${node.operator}'`, ctx);
}

/**
 * `expr catch default`: the default arm replaces the value on failure, so
 * its type must be assignable to whatever `expr` evaluates to. When `expr`
 * is a Result<T>, that's `T`; otherwise (catch on a non-Result is a no-op
 * at runtime) it's the left's own type.
 */
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
