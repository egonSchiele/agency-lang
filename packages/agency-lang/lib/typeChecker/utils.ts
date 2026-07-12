import { diagnostic } from "./diagnostics.js";
import { AgencyNode, FunctionParameter, VariableType } from "../types.js";
import type { SourceLocation } from "../types/base.js";
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

// Accepts the string sentinel too, only during the #472 migration. Once every
// signature is narrowed to VariableType, the `| "any"` is removed again.
// A type predicate so callers narrow the string away in the false branch,
// exactly as the `x === "any"` comparisons it replaces did.
export function isAnyType(
  t: VariableType | "any",
): t is "any" | (VariableType & { type: "primitiveType"; value: "any" }) {
  return t === "any" || (t.type === "primitiveType" && t.value === "any");
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
 * Static half of the failure-propagation rule (spec:
 * docs/superpowers/specs/2026-07-08-failure-propagation-design.md).
 * Returns true when the parameter's declared type accepts Result values:
 * `Result`/`Result<...>`, explicit `any`, or a union containing either.
 *
 * Unannotated params return false — the strict rule. For a variadic
 * `...xs: T[]` the ELEMENT type decides, matching how the runtime checks
 * each gathered element. `typeAliasVariable` returns false (v1: aliases
 * are not resolved here; an alias of Result trips the runtime check and
 * the error message teaches the inline annotation).
 *
 * Emitted into FuncParam.acceptsResult by the typescript builder; consumed
 * by checkFailureArgs (lib/runtime/failurePropagation.ts).
 */
export function paramAcceptsFailure(param: FunctionParameter): boolean {
  const hint = param.typeHint;
  if (!hint) {
    return false;
  }
  if (param.variadic) {
    if (hint.type !== "arrayType") {
      return false;
    }
    return typeAcceptsResult(hint.elementType);
  }
  return typeAcceptsResult(hint);
}

function typeAcceptsResult(t: VariableType): boolean {
  if (t.type === "resultType") {
    return true;
  }
  if (t.type === "primitiveType" && t.value === "any") {
    return true;
  }
  if (t.type === "unionType") {
    return t.types.some(typeAcceptsResult);
  }
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
    ctx.errors.push(
      diagnostic("regexInStructuredOutput", { context }, loc ?? null),
    );
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
  fallbackLoc?: SourceLocation,
): void {
  if (expr.type === "functionCall" && expr.functionName === "llm") {
    rejectRegexInLlmType(expectedType, expr.loc ?? fallbackLoc, context, ctx);
    return;
  }

  const actualType = synthType(expr, scope, ctx);
  if (actualType === "any") return;

  // Literal value nodes may carry no loc of their own; anchor on the
  // enclosing statement when the caller supplied one.
  emitAssignabilityError(actualType, expectedType, expr.loc ?? fallbackLoc, context, ctx);
  if (expr.type === "agencyObject") {
    checkExcessObjectProperties(expr, expectedType, context, ctx);
  }
}

/**
 * The single "X is not assignable to Y" diagnostic construction site. No-op
 * when `actual` is `any` or already assignable to `expected`; otherwise pushes
 * the standard assignability error. Shared by `checkType` (assignment / return
 * checking) and the expression-match `matchExprSource` check in scopes.ts so
 * neither hand-rolls the message.
 */
export function emitAssignabilityError(
  actual: VariableType | "any",
  expected: VariableType,
  loc: SourceLocation | undefined,
  context: string,
  ctx: TypeCheckerContext,
): void {
  if (actual === "any") return;
  if (isAssignable(actual, expected, ctx.getTypeAliases())) return;
  ctx.errors.push(
    diagnostic(
      "typeNotAssignableInContext",
      {
        actual: formatTypeHint(actual),
        expected: formatTypeHint(expected),
        context,
      },
      loc ?? null,
    ),
  );
}

/**
 * Check an `if` / `while` condition. Conditions must be `boolean`, EXCEPT an
 * optional (`T | null`) is accepted as a presence test. The runtime evaluates
 * conditions with JS truthiness, so `if (x)` only licenses narrowing `x` to
 * non-null in the THEN-branch (a falsy `x` may be `""`/`0`/`false` as well as
 * `null`, so the else-branch is not narrowed — see narrowing.ts). Synthesizes
 * the condition once (no double-report) and mirrors `checkType`'s "(condition)"
 * diagnostic.
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
  ctx.errors.push(
    diagnostic(
      "conditionNotBoolean",
      { actual: formatTypeHint(actualType) },
      condition.loc ?? null,
    ),
  );
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
      ctx.errors.push(
        diagnostic(
          "unknownProperty",
          { key: entry.key, expected: formatTypeHint(expectedType), context },
          literal.loc ?? null,
        ),
      );
    }
  }
}
