import type { Expression, NamedArgument, SplatExpression } from "../../types.js";
import type { FunctionCall, FunctionParameter } from "../../types/function.js";

/**
 * Lower a function call's argument list from "positional + named" form
 * into pure positional form aligned to the callee's parameter list.
 *
 * Used only for Agency-defined functions, which are the only callees whose
 * parameter list is statically known at emit time. Imported / built-in
 * functions go through a different code path.
 *
 * Returns the args unwrapped (no `NamedArgument` wrappers) in the order
 * matching the callee's non-variadic, non-block parameters. Skipped
 * optional parameters in the middle of the list are filled with a `null`
 * literal placeholder; trailing skipped params are simply omitted (the
 * caller pads with `undefined`/`null` later, in `emitDirectFunctionCall`
 * and friends).
 *
 * Rules (Python-style):
 * - Positional args must come before named args.
 * - Named args can appear in any order.
 * - Named args can skip optional params (those with default values).
 * - Named args are only supported for Agency-defined functions.
 *
 * Throws if any of those rules are violated, or if a named arg refers to
 * an unknown / required-but-omitted parameter, or if there are duplicate
 * named args.
 */
export function resolveNamedArgs(
  node: FunctionCall,
  paramList: FunctionParameter[] | undefined,
  isAgencyFunction: boolean,
): (Expression | SplatExpression)[] {
  const args = node.arguments;
  const hasNamedArgs = args.some((a) => a.type === "namedArgument");

  if (!hasNamedArgs) {
    return args as (Expression | SplatExpression)[];
  }

  if (!isAgencyFunction || !paramList || paramList.length === 0) {
    throw new Error(
      `Named arguments can only be used with Agency-defined functions, not '${node.functionName}'`,
    );
  }

  // Find where named args start.
  const namedStartIdx = args.findIndex((a) => a.type === "namedArgument");

  // Positional must not appear after the first named arg.
  for (let i = namedStartIdx + 1; i < args.length; i++) {
    if (args[i].type !== "namedArgument") {
      throw new Error(
        `Positional argument cannot follow a named argument in call to '${node.functionName}'`,
      );
    }
  }

  // Collect named args, checking for duplicates and unknown names. All
  // declared params — including variadics and block-typed — may be named.
  // For variadic, the supplied value is the whole spread array (not
  // element-wise). The mixed-rule (positional cannot feed a named-bound
  // variadic) is enforced below. Keep in sync with the runtime resolver
  // in `lib/runtime/agencyFunction.ts :: resolveNamed`.
  const nonVariadicParams = paramList.filter((p) => !p.variadic);
  const variadicParam = paramList.find((p) => p.variadic);
  const namedArgMap = new Map<string, Expression>();
  for (let i = namedStartIdx; i < args.length; i++) {
    const arg = args[i] as NamedArgument;
    if (namedArgMap.has(arg.name)) {
      throw new Error(
        `Duplicate named argument '${arg.name}' in call to '${node.functionName}'`,
      );
    }
    const paramIdx = paramList.findIndex((p) => p.name === arg.name);
    if (paramIdx === -1) {
      throw new Error(
        `Unknown named argument '${arg.name}' in call to '${node.functionName}'`,
      );
    }
    // Conflict check applies to fixed params only; variadic conflicts are
    // handled below by the mixed-rule check (the wording is more
    // actionable: "positional cannot feed variadic" vs the generic
    // "conflicts" message).
    const isVariadic = variadicParam?.name === arg.name;
    if (!isVariadic && paramIdx < namedStartIdx) {
      throw new Error(
        `Named argument '${arg.name}' conflicts with positional argument at position ${paramIdx + 1} in call to '${node.functionName}'`,
      );
    }
    namedArgMap.set(arg.name, arg.value);
  }

  // Mixed positional + named-variadic rule: when the variadic is bound by
  // name, no positional argument may exist past the fixed (non-variadic)
  // parameter count. Keep in sync with `checkNamedArgStructure`.
  if (variadicParam && namedArgMap.has(variadicParam.name)) {
    if (namedStartIdx > nonVariadicParams.length) {
      throw new Error(
        `Positional argument cannot feed variadic parameter '${variadicParam.name}' when it is also bound by name in call to '${node.functionName}'`,
      );
    }
  }

  // Positional args stay in place (unwrapped).
  const result: (Expression | SplatExpression)[] = [];
  for (let i = 0; i < namedStartIdx; i++) {
    const a = args[i];
    result.push(a.type === "namedArgument" ? a.value : a);
  }

  // Fill remaining non-variadic parameter slots from named args.
  for (let i = namedStartIdx; i < nonVariadicParams.length; i++) {
    const param = nonVariadicParams[i];
    if (namedArgMap.has(param.name)) {
      result.push(namedArgMap.get(param.name)!);
      namedArgMap.delete(param.name);
    } else if (param.defaultValue) {
      // Insert `null` placeholder only if a later param has a named arg;
      // otherwise we are at the trailing-optional tail and the call-site
      // pad logic will fill the rest.
      const hasLaterNamedArg = nonVariadicParams
        .slice(i + 1)
        .some((p) => namedArgMap.has(p.name));
      if (hasLaterNamedArg) {
        result.push({ type: "null" } as Expression);
      } else {
        break;
      }
    } else {
      throw new Error(
        `Missing required argument '${param.name}' in call to '${node.functionName}'`,
      );
    }
  }

  // If the variadic was bound by name, splat its value array into the
  // trailing argument slot. Emit as a SplatExpression so the existing
  // call-site lowering treats it as a normal spread — the variadic-collect
  // logic in `agencyFunction.ts :: resolvePositional` then gathers it back
  // into a single array parameter. This is the simplest way to make the
  // named-array form work end-to-end without a new emission path.
  if (variadicParam && namedArgMap.has(variadicParam.name)) {
    result.push({
      type: "splat",
      value: namedArgMap.get(variadicParam.name)!,
    } as SplatExpression);
    namedArgMap.delete(variadicParam.name);
  }

  return result;
}
