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

  // Collect named args, checking for duplicates and unknown names.
  const nonVariadicParams = paramList.filter(
    (p) => !p.variadic && p.typeHint?.type !== "blockType",
  );
  const namedArgMap = new Map<string, Expression>();
  for (let i = namedStartIdx; i < args.length; i++) {
    const arg = args[i] as NamedArgument;
    if (namedArgMap.has(arg.name)) {
      throw new Error(
        `Duplicate named argument '${arg.name}' in call to '${node.functionName}'`,
      );
    }
    const paramIdx = nonVariadicParams.findIndex((p) => p.name === arg.name);
    if (paramIdx === -1) {
      throw new Error(
        `Unknown named argument '${arg.name}' in call to '${node.functionName}'`,
      );
    }
    if (paramIdx < namedStartIdx) {
      throw new Error(
        `Named argument '${arg.name}' conflicts with positional argument at position ${paramIdx + 1} in call to '${node.functionName}'`,
      );
    }
    namedArgMap.set(arg.name, arg.value);
  }

  // Positional args stay in place (unwrapped).
  const result: (Expression | SplatExpression)[] = [];
  for (let i = 0; i < namedStartIdx; i++) {
    const a = args[i];
    result.push(a.type === "namedArgument" ? a.value : a);
  }

  // Fill remaining parameter slots from named args, in parameter order.
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

  return result;
}
