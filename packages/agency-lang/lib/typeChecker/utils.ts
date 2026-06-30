import { AgencyNode, FunctionParameter, VariableType } from "../types.js";
import type { BlockType } from "../types/typeHints.js";
import { formatTypeHint } from "../utils/formatType.js";
import {
  isAssignable,
  isOptionalType,
  safeResolveType,
} from "./assignability.js";
import { BOOLEAN_T } from "./primitives.js";
import { synthType } from "./synthesizer.js";
import { TypeCheckerContext } from "./types.js";
import { Scope } from "./scope.js";
import { visitTypes } from "./typeWalker.js";

/**
 * Look up the parameter list for a callable name across local defs, graph
 * nodes, and imported functions — the resolution order used at every call
 * site that needs to inspect a callee's signature.
 */
export function getParamsForNodeOrFunc(
  name: string,
  ctx: TypeCheckerContext,
): FunctionParameter[] | undefined {
  const def =
    ctx.functionDefs[name] ?? ctx.nodeDefs[name] ?? ctx.importedFunctions[name];
  return def?.parameters;
}

/**
 * If the named callable's last parameter is `blockType`, return that signature
 * — the slot a trailing/inline block fills. Returns undefined for callables
 * whose block param is untyped, `any`, or absent (block bodies in those cases
 * keep their literal annotations and aren't checked against a contract).
 */
export function getBlockSlot(
  name: string,
  ctx: TypeCheckerContext,
): BlockType | undefined {
  const params = getParamsForNodeOrFunc(name, ctx);
  if (!params || params.length === 0) return undefined;
  const last = params[params.length - 1];
  if (last.typeHint?.type !== "blockType") return undefined;
  return last.typeHint;
}

export function isAnyType(t: VariableType): boolean {
  return t.type === "primitiveType" && t.value === "any";
}

/**
 * Returns true when the parameter's declared type cannot be filled in by an
 * LLM through a JSON schema — i.e. it is (or contains) a function type.
 *
 * Single source of truth used by:
 *   - the tool-position binding validator (lib/typeChecker/toolBlockBinding.ts)
 *   - the tool schema generator (lib/backends/typescriptBuilder.ts :: buildToolDefinition)
 *   - the runtime backstop (validateToolForLLM)
 *
 * Rules:
 *   - A `blockType` (Agency's "(X) => Y") is function-typed.
 *   - A `unionType` is function-typed if *any* arm is function-typed.
 *     (Conservative — see docs/superpowers/specs/2026-06-03 §"Out of scope".)
 *   - A variadic param `...xs: T[]` is function-typed iff the element type
 *     `T` is function-typed (the LLM cannot fill an array of functions).
 *   - `any` is NOT function-typed (accepted limitation; see spec §2 "any-typed
 *     parameters").
 */
export function isFunctionTyped(param: FunctionParameter): boolean {
  const hint = param.typeHint;
  if (!hint) return false;
  if (param.variadic) {
    // For `...xs: T[]`, the typeHint shape is an arrayType wrapping the element.
    // We check the element type. If the hint isn't an arrayType (e.g. untyped),
    // it's not function-typed.
    if (hint.type !== "arrayType") return false;
    return typeContainsFunction(hint.elementType);
  }
  return typeContainsFunction(hint);
}

function typeContainsFunction(t: VariableType): boolean {
  if (t.type === "blockType") return true;
  if (t.type === "unionType") return t.types.some(typeContainsFunction);
  return false;
}

/**
 * The `regex` primitive isn't representable in JSON, so an LLM can't return
 * one as structured output. Walk the expected LLM-call type and reject any
 * regex usage with a clear diagnostic, rather than silently emitting a
 * z.instanceof(RegExp) schema the LLM can't satisfy.
 */
function rejectRegexInLlmType(
  t: VariableType,
  loc: AgencyNode["loc"],
  context: string,
  ctx: TypeCheckerContext,
): void {
  if (containsRegex(t)) {
    ctx.errors.push({
      message: `'regex' cannot appear in an llm() structured-output type (${context}); LLMs can't return regex values through JSON.`,
      loc,
    });
  }
}

function containsRegex(t: VariableType): boolean {
  return visitTypes(
    t,
    (n) => n.type === "primitiveType" && n.value === "regex",
  );
}

/**
 * Check mode (top-down): verify that an expression is compatible with expectedType.
 * Shared by scopes.ts (assignment checking) and checker.ts (return type checking).
 */
export function checkType(
  expr: AgencyNode,
  expectedType: VariableType,
  scope: Scope,
  context: string,
  ctx: TypeCheckerContext,
): void {
  if (expr.type === "functionCall" && expr.functionName === "llm") {
    rejectRegexInLlmType(expectedType, expr.loc, context, ctx);
    return;
  }

  const actualType = synthType(expr, scope, ctx);
  if (actualType === "any") return;

  const typeAliases = ctx.getTypeAliases();
  if (!isAssignable(actualType, expectedType, typeAliases)) {
    ctx.errors.push({
      message: `Type '${formatTypeHint(actualType)}' is not assignable to type '${formatTypeHint(expectedType)}' (${context}).`,
      expectedType: formatTypeHint(expectedType),
      actualType: formatTypeHint(actualType),
      loc: expr.loc,
    });
  }
  if (expr.type === "agencyObject") {
    checkExcessObjectProperties(expr, expectedType, context, ctx);
  }
}

/**
 * Check an `if` / `while` condition. Conditions must be `boolean`, EXCEPT an
 * optional (`T | null`) is accepted as a presence test (`if (x)` ⇒ x is non-null
 * in the then-branch — see null/truthiness narrowing). Synthesizes the condition
 * once (no double-report) and mirrors `checkType`'s "(condition)" diagnostic.
 */
export function checkConditionType(
  condition: AgencyNode,
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  const actualType = synthType(condition, scope, ctx);
  if (actualType === "any") {
    return;
  }
  const typeAliases = ctx.getTypeAliases();
  if (isOptionalType(actualType, typeAliases)) {
    return;
  }
  if (isAssignable(actualType, BOOLEAN_T, typeAliases)) {
    return;
  }
  ctx.errors.push({
    message: `Type '${formatTypeHint(actualType)}' is not assignable to type 'boolean' (condition).`,
    expectedType: formatTypeHint(BOOLEAN_T),
    actualType: formatTypeHint(actualType),
    loc: condition.loc,
  });
}

/**
 * When an object literal meets an object-typed target, every key must
 * correspond to a declared property. Mirrors TypeScript's excess-property
 * check; without it, typos like `modle:` slip through structural
 * assignability. Splat entries are dynamic and skipped.
 */
export function checkExcessObjectProperties(
  literal: AgencyNode & { type: "agencyObject" },
  expectedType: VariableType,
  context: string,
  ctx: TypeCheckerContext,
): void {
  const resolved = safeResolveType(expectedType, ctx.getTypeAliases());
  if (resolved.type !== "objectType") return;
  const known = new Set(resolved.properties.map((p) => p.key));
  for (const entry of literal.entries) {
    if ("type" in entry) continue; // splat
    if (entry.computedKey) continue; // computed key — can't statically check
    if (!known.has(entry.key)) {
      ctx.errors.push({
        message: `Unknown property '${entry.key}' on type '${formatTypeHint(expectedType)}' (${context}).`,
        loc: literal.loc,
      });
    }
  }
}
