import { AgencyNode, Expression, VariableType, ValueAccess, formatUnitLiteral } from "../types.js";
import type {
  NamedArgument,
  SplatExpression,
} from "../types/dataStructures.js";
import { formatTypeHint } from "../utils/formatType.js";
import { BUILTIN_FUNCTION_TYPES } from "./builtins.js";
import { isAssignable, resolveType } from "./assignability.js";
import { resultTypeForValidation } from "./validation.js";
import { TypeCheckerContext } from "./types.js";
import { Scope } from "./scope.js";
import { ANY_T, BOOLEAN_T, NUMBER_T, REGEX_T, STRING_T } from "./primitives.js";
import {
  lookupArrayCallbackMethod,
  lookupPrimitiveMember,
  resolvePropertyType,
  resolveSig,
  type ArrayCallbackKind,
} from "./primitiveMembers.js";
import type { BuiltinSignature } from "./types.js";
import { walkNodes } from "../utils/node.js";
import type { BlockArgument } from "../types/blockArgument.js";
import { UNDEFINED_T, VOID_T } from "./primitives.js";

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
      const scopeType = scope.lookup(expr.value);
      if (scopeType) return scopeType;
      const fnDef = ctx.functionDefs[expr.value];
      if (fnDef) {
        return {
          type: "functionRefType",
          name: expr.value,
          params: fnDef.parameters,
          returnType: fnDef.returnType ?? null,
          returnTypeValidated: fnDef.returnTypeValidated,
        };
      }
      const nodeDef = ctx.nodeDefs[expr.value];
      if (nodeDef) {
        return {
          type: "functionRefType",
          name: expr.value,
          params: nodeDef.parameters,
          returnType: nodeDef.returnType ?? null,
          returnTypeValidated: nodeDef.returnTypeValidated,
        };
      }
      const imported = ctx.importedFunctions[expr.value];
      if (imported) {
        return {
          type: "functionRefType",
          name: expr.value,
          params: imported.parameters,
          returnType: imported.returnType ?? null,
        };
      }
      return "any";
    }
    case "number":
    case "unitLiteral":
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
    case "schemaExpression":
      // `schema(Type)` is a language built-in that bridges *type space* and
      // *value space*: the parser captures `Type` as a VariableType (not as
      // a value expression — see schemaExpressionParser in parsers.ts), and
      // at runtime the SchemaExpression node compiles to a zod schema
      // constructed from that type.
      //
      // We synth it as `Schema<T>` so chained `.parse(...)` /
      // `.parseJSON(...)` calls can track the validated type through to a
      // `Result<T, any>` (see synthValueAccess for the method handling).
      //
      // `schema` is listed in RESERVED_FUNCTION_NAMES so users can't define
      // their own `def schema()` (which would create parse ambiguity).
      return { type: "schemaType", inner: expr.typeArg };
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
  // Unary `!` is desugared by the parser into a binOpExpression of the form
  // `{ op: "!", left: true, right: x }` (see unaryNotParser in parsers.ts).
  // It always yields a boolean.
  "!",
]);

const DIMENSION_CHECK_OPS = new Set(["+", "-", ">", "<", ">=", "<=", "==", "!="]);

function synthBinOp(
  expr: AgencyNode & { type: "binOpExpression" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  const op = expr.operator;
  if (op === "catch") return synthCatch(expr, scope, ctx);
  if (op === "|>") return synthPipe(expr, scope, ctx);

  // Dimension mismatch check: only when both sides are direct unit literals
  if (DIMENSION_CHECK_OPS.has(op) &&
      expr.left.type === "unitLiteral" && expr.right.type === "unitLiteral" &&
      expr.left.dimension !== expr.right.dimension) {
    ctx.errors.push({
      message: `Cannot ${op} values of different dimensions (${expr.left.dimension} and ${expr.right.dimension}): '${formatUnitLiteral(expr.left)}' and '${formatUnitLiteral(expr.right)}'.`,
      loc: expr.loc,
    });
  }

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
 * The RHS of `|>` may be a function reference — synthType now produces a
 * functionRefType for bare identifiers, so we extract the return type from
 * it and apply Result wrapping.
 */
function synthPipeRhs(
  rhs: AgencyNode,
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  const rhsType = synthType(rhs, scope, ctx);
  if (rhsType !== "any" && rhsType.type === "functionRefType") {
    const returnType =
      rhsType.returnType ??
      (ctx.inferredReturnTypes[rhsType.name] !== "any"
        ? (ctx.inferredReturnTypes[rhsType.name] as VariableType | undefined)
        : undefined);
    if (returnType) return resultTypeForValidation(returnType, rhsType.returnTypeValidated);
  }
  return rhsType;
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
  if (concreteTypes.length === 1) {
    return { type: "arrayType", elementType: concreteTypes[0] };
  }
  // Deduplicate structurally identical types
  const seen = new Map<string, VariableType>();
  for (const t of concreteTypes) {
    const key = JSON.stringify(t);
    if (!seen.has(key)) seen.set(key, t);
  }
  const unique = Array.from(seen.values());
  const elementType = unique.length === 1
    ? unique[0]
    : { type: "unionType" as const, types: unique };
  return { type: "arrayType", elementType };
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

function validateAgencyFunctionMethod(
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
    if (!params) return;
    const paramNames = new Set(params.map((p) => p.name));
    const namedArgs = args.filter(
      (a: any) => "type" in a && a.type === "namedArgument",
    );
    for (const arg of namedArgs) {
      if (!paramNames.has(arg.name)) {
        ctx.errors.push({
          message: `Unknown parameter '${arg.name}' in .partial() call. '${baseName}' has parameters: ${[...paramNames].join(", ")}.`,
          loc: expr.loc,
        });
        continue;
      }
      const param = params.find((p) => p.name === arg.name);
      if (param?.variadic) {
        ctx.errors.push({
          message: `Variadic parameter '${arg.name}' cannot be bound in .partial().`,
          loc: expr.loc,
        });
      }
    }
    return;
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

  if (methodName === "preapprove") {
    const args = element.functionCall.arguments;
    if (args.length > 0) {
      ctx.errors.push({
        message: `.preapprove() takes no arguments.`,
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
      if (methodName === "partial" || methodName === "describe" || methodName === "preapprove") {
        validateAgencyFunctionMethod(expr, element, methodName, ctx);
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
        } else {
          // Built-in member on a primitive (string.length, array.length, …)?
          const member = lookupPrimitiveMember(resolved, element.name);
          if (member && member.kind === "property") {
            currentType = resolvePropertyType(member.type, resolved);
            break;
          }
          ctx.errors.push({
            message: `Property '${element.name}' does not exist on type '${formatTypeHint(resolved)}'.`,
            loc: expr.loc,
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
        // `schema(T).parse(x)` and `.parseJSON(s)` both return Result<T, any>
        // at runtime (see lib/runtime/schema.ts). Track the inner type
        // through the chain so callers can use `.value` / `catch` / pipes.
        if (resolved.type === "schemaType") {
          const methodName = element.functionCall.functionName;
          if (methodName === "parse" || methodName === "parseJSON") {
            currentType = {
              type: "resultType",
              successType: resolved.inner,
              failureType: ANY_T,
            };
            break;
          }
        }
        // Array callback methods: `xs.map(\(x) -> ...)`, `xs.filter(fn)`, …
        // Handled separately from the simple BuiltinSignature path because
        // their result types depend on a callback's return type, which we
        // synth from the block body or function-ref argument.
        if (resolved.type === "arrayType") {
          const cbKind = lookupArrayCallbackMethod(
            element.functionCall.functionName,
          );
          if (cbKind !== null) {
            currentType = synthArrayCallbackMethod(
              resolved,
              cbKind,
              element.functionCall,
              scope,
              ctx,
            );
            break;
          }
        }
        // Built-in method on a primitive receiver? (`s.toUpperCase()`,
        // `xs.slice(1, 3)`, …) — see primitiveMembers.ts.
        const member = lookupPrimitiveMember(
          resolved,
          element.functionCall.functionName,
        );
        if (member && member.kind === "method") {
          const sig = resolveSig(member.sig, resolved);
          validatePrimitiveMethodCall(expr, element.functionCall, sig, scope, ctx);
          currentType = sig.returnType === "any" ? ANY_T : sig.returnType;
          break;
        }
        return "any";
      }
    }
  }

  return currentType;
}

/**
 * Validate a built-in primitive method call (`s.toUpperCase()`,
 * `xs.indexOf(x)`, …) against a {@link BuiltinSignature}: rejects named
 * args / blocks (primitives have no parameter names), enforces arity, and
 * checks each positional arg against its slot. Splat args bypass arity.
 *
 * Mirrors the shape of `checkCallAgainstBuiltinSig` in checker.ts but
 * lives here to avoid a circular import — synth runs eagerly inside
 * checkExpressionsInScope, and adding errors here keeps validation local
 * to the place that already knows the receiver type.
 */
function validatePrimitiveMethodCall(
  expr: ValueAccess,
  call: { functionName: string; arguments: AgencyNode[] | (Expression | SplatExpression | NamedArgument)[] },
  sig: BuiltinSignature,
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  const args = call.arguments as (Expression | SplatExpression | NamedArgument)[];
  if (args.some((a) => "type" in a && a.type === "namedArgument")) {
    ctx.errors.push({
      message: `Named arguments are not supported on built-in method '.${call.functionName}()'.`,
      loc: expr.loc,
    });
    return;
  }
  const hasSplat = args.some((a) => "type" in a && a.type === "splat");
  if (!hasSplat) {
    const minArgs = sig.minParams ?? sig.params.length;
    const hasRest = sig.restParam !== undefined;
    const maxArgs = hasRest ? Infinity : sig.params.length;
    if (args.length < minArgs || args.length > maxArgs) {
      const expected =
        minArgs === maxArgs
          ? `${minArgs}`
          : maxArgs === Infinity
            ? `at least ${minArgs}`
            : `${minArgs}–${maxArgs}`;
      ctx.errors.push({
        message: `Method '.${call.functionName}()' expects ${expected} argument(s), got ${args.length}.`,
        loc: expr.loc,
      });
      return;
    }
  }
  const typeAliases = ctx.getTypeAliases();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ("type" in arg && arg.type === "splat") continue; // skip splat element check for primitives
    const slotType =
      i < sig.params.length ? sig.params[i] : (sig.restParam as VariableType | "any" | undefined);
    if (slotType === undefined || slotType === "any") continue;
    const argType = synthType(arg as AgencyNode, scope, ctx);
    if (argType === "any") continue;
    if (!isAssignable(argType, slotType, typeAliases)) {
      ctx.errors.push({
        message: `Argument type '${formatTypeHint(argType)}' is not assignable to parameter type '${formatTypeHint(slotType)}' in call to '.${call.functionName}()'.`,
        expectedType: formatTypeHint(slotType),
        actualType: formatTypeHint(argType),
        loc: expr.loc,
      });
    }
  }
}

/**
 * Compute the result type of a known callback-taking array method
 * (`map` / `filter` / `forEach` / …) on an `Array<T>` receiver. Best-effort:
 *
 *   - For block callbacks (`xs.map(\(x) -> body)`), bind the block's params
 *     to the element type in a child scope, then walk the body's
 *     `returnStatement`s and synth-union their values.
 *   - For function-ref args (`xs.map(myFn)`), use the synth'd argument's
 *     `functionRefType.returnType`.
 *   - On anything we can't recognize, the callback return is "any" and
 *     methods that depend on it (`map`/`reduce`/`flatMap`) propagate that.
 *
 * Callback signature validation (arity, body return type vs. expected
 * slot) is intentionally deferred — Phase 3.
 */
function synthArrayCallbackMethod(
  receiver: VariableType & { type: "arrayType" },
  cbKind: ArrayCallbackKind,
  call: { functionName: string; arguments: AgencyNode[] | unknown[]; block?: BlockArgument },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  const elementT = receiver.elementType;
  if (cbKind === "sameArray") return receiver;
  if (cbKind === "void") return VOID_T;
  if (cbKind === "boolean") return BOOLEAN_T;
  if (cbKind === "elementOrUndef") {
    return { type: "unionType", types: [elementT, UNDEFINED_T] };
  }

  // The remaining kinds (`arrayU`, `flatten`, `reduce`) all need the
  // callback's return type. Synth it from whichever shape was provided.
  const cbReturn = synthCallbackReturnType(call, elementT, scope, ctx);

  if (cbKind === "arrayU") {
    if (cbReturn === "any") return ANY_T;
    return { type: "arrayType", elementType: cbReturn };
  }
  if (cbKind === "flatten") {
    if (cbReturn === "any") return ANY_T;
    // `flatMap`'s callback returns `Array<U>`; we unwrap one level.
    if (cbReturn.type === "arrayType") return cbReturn;
    // Callback returned a non-array — flatMap silently treats it as a
    // single-element wrap at runtime; type as `Array<U>`.
    return { type: "arrayType", elementType: cbReturn };
  }
  if (cbKind === "reduce") {
    // Prefer the explicit accumulator initializer (2nd arg) if available;
    // otherwise fall back to the callback's return type. Both signatures
    // are common — `xs.reduce(\(acc, x) -> acc + x, 0)` and the rarer
    // `xs.reduce(\(acc, x) -> acc + x)`.
    const args = (call.arguments as AgencyNode[]) ?? [];
    const init = args[1];
    if (init) {
      const initType = synthType(init, scope, ctx);
      return initType;
    }
    return cbReturn;
  }
  return "any";
}

/**
 * Pull the callback's return type out of a method call. The callback may be:
 *
 *   - A trailing/inline block (`\(x) -> body` or `as { … }`): we walk all
 *     `returnStatement`s in the body, synth each value's type, and union
 *     the distinct results.
 *   - The first positional argument as a function reference (`xs.map(myFn)`):
 *     synth it; if the result is a `functionRefType`, take its `returnType`.
 *
 * Returns "any" when neither shape applies.
 */
function synthCallbackReturnType(
  call: { arguments: AgencyNode[] | unknown[]; block?: BlockArgument },
  elementT: VariableType,
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  if (call.block) {
    return synthBlockReturnType(call.block, elementT, scope, ctx);
  }
  const args = (call.arguments as AgencyNode[]) ?? [];
  if (args.length === 0) return "any";
  const cbType = synthType(args[0], scope, ctx);
  if (cbType === "any") return "any";
  if (cbType.type === "functionRefType") return cbType.returnType ?? "any";
  if (cbType.type === "blockType") return cbType.returnType;
  return "any";
}

/**
 * Synth a block callback's return type. The block introduces its
 * parameters into a child scope (`declareLocal`) bound to the element
 * type, so that body references like `x.foo` resolve through `T`'s
 * member shape rather than degrading to `any`.
 *
 * Walks every `returnStatement.value` descendant in the block body,
 * synths each, dedupes by structural identity, and unions the distinct
 * results. An empty block (no `return`) yields "any".
 */
function synthBlockReturnType(
  block: BlockArgument,
  elementT: VariableType,
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  const child = scope.child();
  // First param is the element; second (if present) is the index for
  // most array iteration methods. We don't try to special-case `reduce`
  // (param 0 = acc) — the resulting param types are best-effort and the
  // body can still infer through binOps and literals.
  block.params.forEach((p, i) => {
    if (i === 0) child.declareLocal(p.name, elementT);
    else if (i === 1) child.declareLocal(p.name, NUMBER_T);
    else child.declareLocal(p.name, "any");
  });

  const returnTypes: (VariableType | "any")[] = [];
  for (const { node } of walkNodes(block.body)) {
    if (node.type === "returnStatement" && node.value) {
      returnTypes.push(synthType(node.value, child, ctx));
    }
  }
  if (returnTypes.length === 0) return "any";
  const concrete = returnTypes.filter((t): t is VariableType => t !== "any");
  if (concrete.length === 0) return "any";
  if (concrete.length === 1) return concrete[0];
  // Dedupe structurally identical types.
  const seen = new Map<string, VariableType>();
  for (const t of concrete) {
    const key = JSON.stringify(t);
    if (!seen.has(key)) seen.set(key, t);
  }
  const unique = Array.from(seen.values());
  return unique.length === 1
    ? unique[0]
    : { type: "unionType", types: unique };
}
