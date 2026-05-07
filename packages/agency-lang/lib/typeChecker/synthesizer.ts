import { AgencyNode, Expression, VariableType, ValueAccess } from "../types.js";
import type {
  NamedArgument,
  SplatExpression,
} from "../types/dataStructures.js";
import { formatTypeHint } from "../cli/util.js";
import { BUILTIN_FUNCTION_TYPES } from "./builtins.js";
import { isAssignable, resolveType } from "./assignability.js";
import { resultTypeForValidation } from "./validation.js";
import { TypeCheckerContext } from "./types.js";
import { Scope } from "./scope.js";
import { ANY_T, BOOLEAN_T, NUMBER_T, REGEX_T, STRING_T } from "./primitives.js";

/** Names treated as Result constructors (synth parameterizes ResultType from arg). */
const RESULT_CONSTRUCTORS = new Set<string>(["success", "failure"]);

/** Runtime fields exposed on Success/Failure. See lib/runtime/result.ts. */
const RESULT_FIELDS = new Set<string>([
  "value",
  "error",
  "checkpoint",
  "functionName",
  "args",
  "retryable",
  "success",
]);

/**
 * `synthType` returns `VariableType | "any"` where `"any"` is the literal
 * string sentinel meaning "we don't know". When we want to embed that
 * result inside a structured VariableType (e.g. as ResultType.successType,
 * which is just `VariableType`), convert the sentinel into the equivalent
 * primitiveType("any") so the inner field is a real VariableType.
 */
function maybeAny(t: VariableType | "any"): VariableType {
  return t === "any" ? ANY_T : t;
}

/**
 * Return the inner expression for a plain positional argument, or undefined
 * for splat / named args. Synth-time special cases (success/failure) decline
 * to fire on those forms because the per-arg type isn't directly available.
 */
function asPositionalArg(
  arg: Expression | SplatExpression | NamedArgument,
): Expression | undefined {
  if (arg.type === "splat" || arg.type === "namedArgument") return undefined;
  return arg;
}

export function synthType(
  expr: AgencyNode,
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  switch (expr.type) {
    case "variableName": {
      return scope.lookup(expr.value) ?? "any";
    }
    case "number":
      return NUMBER_T;
    case "string": {
      if (expr.segments.length === 1 && expr.segments[0].type === "text") {
        return { type: "stringLiteralType", value: expr.segments[0].value };
      }
      return STRING_T;
    }
    case "multiLineString":
      return STRING_T;
    case "boolean":
      return BOOLEAN_T;
    case "regex":
      return REGEX_T;
    case "binOpExpression":
      return synthBinOp(expr, scope, ctx);
    case "functionCall":
      return synthFunctionCall(expr, scope, ctx);
    case "agencyArray":
      return synthArray(expr, scope, ctx);
    case "agencyObject":
      return synthObject(expr, scope, ctx);
    case "valueAccess":
      return synthValueAccess(expr, scope, ctx);
    case "tryExpression":
      return synthTryExpression(expr, scope, ctx);
    default:
      return "any";
  }
}

/**
 * `try expr` runs `expr` and converts a thrown error to a `failure(...)`.
 * If the inner call already returns a Result, pass it through (matches
 * runtime `__tryCall` behavior). Otherwise wrap as `Result<T, any>`.
 */
function synthTryExpression(
  expr: AgencyNode & { type: "tryExpression" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  const inner = synthType(expr.call, scope, ctx);
  if (inner === "any") return inner;
  if (inner.type === "resultType") return inner;
  return { type: "resultType", successType: inner, failureType: ANY_T };
}

const BOOLEAN_OPS = new Set([
  "==",
  "!=",
  "=~",
  "!~",
  "<",
  ">",
  "<=",
  ">=",
  "&&",
  "||",
]);

function synthBinOp(
  expr: AgencyNode & { type: "binOpExpression" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  const op = expr.operator;
  if (op === "catch") return synthCatch(expr, scope, ctx);
  if (op === "|>") return synthPipe(expr, scope, ctx);
  if (BOOLEAN_OPS.has(op)) return BOOLEAN_T;
  if (op === "+") {
    const leftType = synthType(expr.left, scope, ctx);
    const rightType = synthType(expr.right, scope, ctx);
    const isString = (t: VariableType | "any") =>
      t !== "any" &&
      ((t.type === "primitiveType" && t.value === "string") ||
        t.type === "stringLiteralType");
    if (isString(leftType) || isString(rightType)) {
      return STRING_T;
    }
  }
  return NUMBER_T;
}

/**
 * `expr catch default` unwraps a Result: returns the success value if
 * present, otherwise evaluates `default`. The synthed type is the
 * success type. (We don't union with default's type — agency runtime
 * returns the default as-is on failure, so callers get whichever
 * branch fires; downstream type-checking via checkExpressionsInScope
 * verifies default is assignable to the success type.)
 */
function synthCatch(
  expr: AgencyNode & { type: "binOpExpression" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  const left = synthType(expr.left, scope, ctx);
  if (left === "any") return left;
  if (left.type === "resultType") {
    // `catch` on a non-Result is a no-op at runtime — type is just left.
    return left.successType;
  }
  return left;
}

/**
 * `left |> right` chains: left's success value flows into right (a function
 * call or function reference). The chain short-circuits on failure, so the
 * result is always a Result wrapping right's return type. If right already
 * returns a Result, pass it through.
 *
 * Slot-type validation lives in checker.ts (`validatePipeArg`) — kept out of
 * synth so it doesn't fire twice when a pipe appears in an assignment/return
 * context that already synths the expression.
 */
function synthPipe(
  expr: AgencyNode & { type: "binOpExpression" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  const right = synthPipeRhs(expr.right, scope, ctx);
  if (right === "any") return right;
  if (right.type === "resultType") return right;
  return { type: "resultType", successType: right, failureType: ANY_T };
}

/**
 * The RHS of `|>` may be a function reference (`variableName`) — synthType
 * on a bare identifier only consults `scope.lookup`, which returns "any"
 * for top-level function names. Resolve via functionDefs / nodeDefs /
 * importedFunctions so `... |> half` types as `Result<halfReturn>` rather
 * than `any`. Other RHS forms (function calls, etc.) fall through to
 * regular synth.
 */
function synthPipeRhs(
  rhs: AgencyNode,
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  if (rhs.type === "variableName") {
    const name = rhs.value;
    const def = ctx.functionDefs[name] ?? ctx.nodeDefs[name];
    const importedSig = ctx.importedFunctions[name];
    // Pipes inherit Result wrapping like direct calls — apply the bang at
    // the call-site read so `... |> half` types as `Result<halfReturn>`.
    const fnReturn =
      (def?.returnType &&
        resultTypeForValidation(def.returnType, def.returnTypeValidated)) ??
      ctx.inferredReturnTypes[name] ??
      (importedSig?.returnType &&
        resultTypeForValidation(importedSig.returnType, undefined));
    if (fnReturn) return fnReturn;
  }
  return synthType(rhs, scope, ctx);
}

function synthFunctionCall(
  expr: AgencyNode & { type: "functionCall" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  // Result constructors: parameterize ResultType from the argument so callers
  // get `Result<T, any>` (success) or `Result<any, T>` (failure). The names
  // are reserved at the typechecker level (see RESERVED_FUNCTION_NAMES in
  // index.ts), so shadowing is impossible — no gating needed here.
  if (
    RESULT_CONSTRUCTORS.has(expr.functionName) &&
    expr.arguments.length >= 1
  ) {
    const inner = asPositionalArg(expr.arguments[0]);
    if (inner) {
      const innerType = maybeAny(synthType(inner, scope, ctx));
      return expr.functionName === "success"
        ? { type: "resultType", successType: innerType, failureType: ANY_T }
        : { type: "resultType", successType: ANY_T, failureType: innerType };
    }
  }
  const fn = ctx.functionDefs[expr.functionName];
  const graphNode = ctx.nodeDefs[expr.functionName];
  const def = fn ?? graphNode;
  if (def?.returnType)
    return resultTypeForValidation(def.returnType, def.returnTypeValidated);
  if (expr.functionName in ctx.inferredReturnTypes) {
    return ctx.inferredReturnTypes[expr.functionName];
  }
  if (def && !def.returnType && ctx.inferringReturnType.size > 0) {
    return ctx.inferReturnTypeFor(expr.functionName, def);
  }
  if (!def) {
    const imported = ctx.importedFunctions[expr.functionName];
    if (imported?.returnType) return imported.returnType;
    if (expr.functionName in BUILTIN_FUNCTION_TYPES) {
      return BUILTIN_FUNCTION_TYPES[expr.functionName].returnType;
    }
  }
  return "any";
}

function synthArray(
  expr: AgencyNode & { type: "agencyArray" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  if (expr.items.length === 0)
    return { type: "arrayType", elementType: ANY_T };
  const itemTypes: (VariableType | "any")[] = [];
  for (const item of expr.items) {
    if (item.type === "splat") {
      const splatType = synthType(item.value, scope, ctx);
      if (splatType === "any") return "any";
      if (splatType.type !== "arrayType") return "any";
      itemTypes.push(splatType.elementType);
      continue;
    }
    itemTypes.push(synthType(item, scope, ctx));
  }
  const concreteTypes = itemTypes.filter((t) => t !== "any");
  if (concreteTypes.length === 0) return "any";
  const typeAliases = ctx.getTypeAliases();
  const first = concreteTypes[0];
  const allSame = concreteTypes.every(
    (t) =>
      isAssignable(t, first, typeAliases) &&
      isAssignable(first, t, typeAliases),
  );
  if (allSame) {
    return { type: "arrayType", elementType: first };
  }
  return "any";
}

function synthObject(
  expr: AgencyNode & { type: "agencyObject" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  // Use a Map so later entries overwrite earlier ones (later-wins for splats
  // followed by explicit keys, e.g. { ...a, x: "new" } produces x's literal type).
  const properties = new Map<string, VariableType>();
  for (const entry of expr.entries) {
    if ("type" in entry && entry.type === "splat") {
      const splatType = synthType(entry.value, scope, ctx);
      if (splatType === "any") return "any";
      if (splatType.type !== "objectType") return "any";
      for (const prop of splatType.properties)
        properties.set(prop.key, prop.value);
      continue;
    }
    const kv = entry as { key: string; value: AgencyNode };
    const valueType = synthType(kv.value, scope, ctx);
    if (valueType === "any") {
      return "any";
    }
    properties.set(kv.key, valueType);
  }
  return {
    type: "objectType",
    properties: Array.from(properties, ([key, value]) => ({ key, value })),
  };
}

function validatePartialOrDescribe(
  expr: ValueAccess,
  element: { kind: "methodCall"; functionCall: { type: "functionCall"; functionName: string; arguments: any[] } },
  methodName: string,
  ctx: TypeCheckerContext,
): void {
  const baseName =
    expr.base.type === "variableName" ? (expr.base as any).value : null;
  const fnDef = baseName ? ctx.functionDefs[baseName] ?? null : null;
  const importedSig = baseName ? ctx.importedFunctions[baseName] ?? null : null;

  if (methodName === "partial") {
    const args = element.functionCall.arguments;
    const hasNonNamed = args.some(
      (a: any) => !("type" in a && a.type === "namedArgument"),
    );
    if (hasNonNamed) {
      ctx.errors.push({
        message: `.partial() requires named arguments, e.g. fn.partial(a: 5).`,
        loc: expr.loc,
      });
    }
    const params = fnDef?.parameters ?? importedSig?.parameters ?? null;
    if (params) {
      const paramNames = new Set(params.map((p) => p.name));
      for (const arg of args) {
        if ("type" in arg && arg.type === "namedArgument") {
          if (!paramNames.has(arg.name)) {
            ctx.errors.push({
              message: `Unknown parameter '${arg.name}' in .partial() call. '${baseName}' has parameters: ${[...paramNames].join(", ")}.`,
              loc: expr.loc,
            });
          } else {
            const param = params.find((p) => p.name === arg.name);
            if (param?.variadic) {
              ctx.errors.push({
                message: `Variadic parameter '${arg.name}' cannot be bound in .partial().`,
                loc: expr.loc,
              });
            }
          }
        }
      }
    }
  }

  if (methodName === "describe") {
    const args = element.functionCall.arguments;
    if (
      args.length !== 1 ||
      ("type" in args[0] && args[0].type === "namedArgument")
    ) {
      ctx.errors.push({
        message: `.describe() requires exactly one string argument.`,
        loc: expr.loc,
      });
    } else if (
      "type" in args[0] &&
      args[0].type !== "string" &&
      args[0].type !== "multiLineString" &&
      args[0].type !== "variableName"
    ) {
      ctx.errors.push({
        message: `.describe() argument must be a string, got ${args[0].type}.`,
        loc: expr.loc,
      });
    }
  }
}

export function synthValueAccess(
  expr: ValueAccess,
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  let currentType = synthType(expr.base, scope, ctx);
  const typeAliases = ctx.getTypeAliases();

  for (const element of expr.chain) {
    // Validate .partial()/.describe() even when the base type is unknown,
    // since we can check argument structure against the function definition.
    // Use continue (not return) so chained calls like fn.partial(a: 1).describe("x") are all validated.
    if (element.kind === "methodCall") {
      const methodName = element.functionCall.functionName;
      if (methodName === "partial" || methodName === "describe") {
        validatePartialOrDescribe(expr, element, methodName, ctx);
        currentType = "any";
        continue;
      }
    }

    if (currentType === "any") return "any";
    const resolved = resolveType(currentType, typeAliases);
    if (resolved.type === "primitiveType" && resolved.value === "any")
      return "any";

    switch (element.kind) {
      case "property": {
        // Result<T, E>: allow access to runtime fields without flow narrowing.
        // Until isSuccess/isFailure narrowing lands (Tier 2 PR B), users have
        // no way to safely unwrap a Result. Treating these field accesses as
        // `any` keeps real Result code from flooding with spurious "property
        // does not exist" errors. Once narrowing lands, this can be tightened
        // so .value is only valid on the Success branch and .error/etc. are
        // only valid on Failure.
        if (resolved.type === "resultType" && RESULT_FIELDS.has(element.name)) {
          return "any";
        }
        if (resolved.type === "unionType") {
          const propTypes: VariableType[] = [];
          for (const member of resolved.types) {
            const resolvedMember = resolveType(member, typeAliases);
            if (resolvedMember.type === "objectType") {
              const prop = resolvedMember.properties.find(
                (p) => p.key === element.name,
              );
              if (prop) propTypes.push(prop.value);
            }
          }
          if (propTypes.length > 0) {
            if (propTypes.length === 1) {
              currentType = propTypes[0];
            } else {
              currentType = { type: "unionType", types: propTypes };
            }
          } else {
            ctx.errors.push({
              message: `Property '${element.name}' does not exist on type '${formatTypeHint(resolved)}'.`,
              loc: expr.loc,
            });
            return "any";
          }
        } else if (resolved.type === "objectType") {
          const prop = resolved.properties.find((p) => p.key === element.name);
          if (prop) {
            currentType = prop.value;
          } else {
            ctx.errors.push({
              message: `Property '${element.name}' does not exist on type '${formatTypeHint(resolved)}'.`,
              loc: expr.loc,
            });
            return "any";
          }
        } else if (resolved.type === "arrayType" && element.name === "length") {
          currentType = NUMBER_T;
        } else {
          ctx.errors.push({
            message: `Property '${element.name}' does not exist on type '${formatTypeHint(resolved)}'.`,
          });
          return "any";
        }
        break;
      }
      case "index": {
        if (resolved.type === "arrayType") {
          currentType = resolved.elementType;
        } else {
          return "any";
        }
        break;
      }
      case "methodCall": {
        return "any";
      }
    }
  }

  return currentType;
}
