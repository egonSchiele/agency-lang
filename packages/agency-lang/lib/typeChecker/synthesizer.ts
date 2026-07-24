import { isAnyType } from "./utils.js";
import { diagnostic } from "./diagnostics.js";
import { AgencyNode, Expression, VariableType, ValueAccess, formatUnitLiteral } from "../types.js";
import type { TypeTestExpression } from "../types/pattern.js";
import { visitTypes } from "./typeWalker.js";
import { parseMatchValId } from "../matchVal.js";
import { typeAliasParser } from "../parsers/parsers.js";

/** The structural equivalent of stdlib Code (stdlib/agency.agency), built
 *  once through the TYPE-ALIAS production — the same grammar Code's own
 *  declaration goes through — so field encodings (optional-field flags,
 *  string-literal types) match by construction; the bare
 *  variableTypeParser encodes optionality differently and the record
 *  comparison rejects the mismatch. The `type` and `kind` fields are the
 *  EXACT literal and union from Code: structural assignability into a
 *  literal-typed field is directional, so a widened `string` here would
 *  fail fill(template: Code). Structural typing is what lets the literal
 *  flow into std::agency's fill/holesOf/toSource without any mechanism
 *  for naming a stdlib alias from the checker. */
function parseCodeLiteralType(): VariableType {
  const source = [
    "type __CodeLiteralValue = {",
    '  type: "agencyProgram";',
    '  kind?: "program" | "statements" | "expr";',
    "  nodes: any[];",
    "  docComment?: any",
    "}",
  ].join("\n");
  const parsed = typeAliasParser(source);
  if (!parsed.success) {
    throw new Error("internal: the Code structural type failed to parse");
  }
  return parsed.result.aliasedType;
}

const CODE_LITERAL_TYPE: VariableType = parseCodeLiteralType();
import { recordLikeKeyValue } from "./recordLike.js";
import type { ResultType, UnionType, TypeAliasEntry } from "../types/typeHints.js";
import type { SourceLocation } from "../types/base.js";
import { resultToObjectUnion } from "./resultUnion.js";
import type {
  NamedArgument,
  SplatExpression,
} from "../types/dataStructures.js";
import { formatTypeHint } from "../utils/formatType.js";
import { BUILTIN_FUNCTION_TYPES, AGENCY_FUNCTION_METHOD_TYPES, BUILTIN_VARIABLE_TYPES } from "./builtins.js";
import { isAssignable, isNever, safeResolveType } from "./assignability.js";
import { typeAt, flowHasNarrowFor, stablePrefix } from "./flow.js";
import { literalToType } from "./literalType.js";
import { typeKey } from "./typeKey.js";
import { resultTypeForValidation } from "./validation.js";
import { TypeCheckerContext } from "./types.js";
import { Scope } from "./scope.js";
import { ANY_T, BOOLEAN_T, NEVER_T, NUMBER_T, REGEX_T, STRING_T } from "./primitives.js";
import {
  lookupArrayCallbackMethod,
  lookupPrimitiveMember,
  resolvePropertyType,
  resolveSig,
  type ArrayCallbackKind,
} from "./primitiveMembers.js";
import type { BuiltinSignature } from "./types.js";
import { walkNodes } from "../utils/node.js";
import { unionTypes } from "./inference.js";
import { uniqBy } from "../utils.js";
import type { BlockArgument } from "../types/blockArgument.js";
import { NULL_T, VOID_T } from "./primitives.js";

/** Own-property lookup for name-keyed maps. A plain `obj[name]` on a
 *  user-controlled identifier like "toString" hits the prototype chain
 *  and returns a function where a type/def is expected. */
const hasOwn = (obj: object, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, name);

/** Names treated as Result constructors (synth parameterizes ResultType from arg). */
const RESULT_CONSTRUCTORS = new Set<string>(["success", "failure"]);

/** Runtime fields exposed on Success/Failure. See lib/runtime/result.ts. */
const RESULT_FIELDS = new Set<string>([
  "value",
  "error",
  "checkpoint",
  "functionName",
  "args",
  "neverStarted",
  "destructiveRan",
  "success",
  "skippedFunctions",
]);

// The Result fields that exist on exactly one branch (everything except
// `success`, which is on both). Derived from RESULT_FIELDS so adding a field in
// one place updates both. `value` is success-only; the rest are failure-only.
const RESULT_BRANCH_FIELDS = new Set(
  [...RESULT_FIELDS].filter((f) => f !== "success"),
);


/**
 * Resolve a field access on a `ResultType` against the narrowing layer.
 * Returns:
 *  - a concrete `VariableType` → caller should set `currentType = ...; break;`
 *  - `ANY_T` → the un-typed escape hatch for a Result field on an un-narrowed
 *    Result (until Increment 3 tightens `.value` on Failure into a hard error)
 *  - `null` → no resolution; fall through to the next case in `synthValueAccess`
 *
 * Pulled out of `synthValueAccess` to keep that function under the
 * structural linter's max-lines-per-function budget. Single caller; the
 * extraction is purely organizational.
 */
function resolveResultFieldType(
  _resolved: ResultType,
  fieldName: string,
): VariableType | null {
  // Narrowed Results are now real member object types (narrowed via the
  // discriminant engine), so this only sees UN-narrowed Results: keep the
  // lenient `any` for known Result fields. Task 2 deletes this entirely and
  // routes un-narrowed Results through strict union access.
  if (RESULT_FIELDS.has(fieldName)) return ANY_T;
  return null;
}

type StrictSeverity = "silent" | "warn" | "error";

/**
 * The configured strict union-member-access severity. Defaults to "error":
 * un-guarded access to a branch-specific union member (notably `r.value` on an
 * un-narrowed Result) is a hard error. Set `strictMemberAccess: "silent"` to
 * opt out (restores the old lenient behavior).
 *
 * Strict access is FLOW-SENSITIVE: whether a member is reachable depends on
 * narrowing (`if (isSuccess(b.r)) { b.r.value }`), which is only known once the
 * flow graph exists. The pre-flow inference passes (return-type inference and
 * scope-building, where an untyped `let v = b.r.value` synthesizes its RHS to
 * declare `v`) run with `ctx.flowEnv` unset — emitting here would be a false
 * positive on narrowed access. Suppress in that window; the flow-aware
 * `checkScopes` pass re-synthesizes every value access and emits the genuine
 * diagnostic.
 */
function strictMemberAccessSeverity(ctx: TypeCheckerContext): StrictSeverity {
  if (!ctx.flowEnv) return "silent";
  return ctx.config.typechecker?.strictMemberAccess ?? "error";
}

/** Map the strict-member-access CONFIG severity word to an error severity. */
function strictSeverity(severity: "warn" | "error"): "warning" | "error" {
  if (severity === "warn") {
    return "warning";
  }
  return "error";
}

/**
 * Collect a property's type across the members of a union. `type` is the
 * collapsed result over members that HAVE the property (a single hit unwraps;
 * none → `null`). `missing` is true when at least one member lacks it —
 * covering BOTH an object member without the property AND a non-object member
 * (e.g. `string` in `{a:string} | string`); both require narrowing, so both
 * count as missing for the strict check.
 */
function unionPropertyAccess(
  members: VariableType[],
  fieldName: string,
  aliases: Record<string, TypeAliasEntry>,
): { type: VariableType | null; missing: boolean } {
  const types: VariableType[] = [];
  let missing = false;
  for (const member of members) {
    const resolvedMember = safeResolveType(member, aliases);
    const prop =
      resolvedMember.type === "objectType"
        ? resolvedMember.properties.find((p) => p.key === fieldName)?.value
        : undefined;
    if (prop) {
      types.push(prop);
    } else {
      missing = true;
    }
  }
  const type =
    types.length === 0
      ? null
      : types.length === 1
        ? types[0]
        : { type: "unionType" as const, types };
  return { type, missing };
}

/**
 * Strict-aware property access on a union receiver. Returns the collapsed
 * member type, or `null` when no member has the field (caller emits the hard
 * "does not exist" error). When the field is present on some-but-not-all
 * members, emits the gated strict diagnostic — a narrowed receiver is a single
 * object member and never reaches here, so this never fires on guarded code.
 */
function accessUnionField(
  union: UnionType,
  fieldName: string,
  aliases: Record<string, TypeAliasEntry>,
  ctx: TypeCheckerContext,
  loc: SourceLocation | undefined,
): VariableType | null {
  const { type, missing } = unionPropertyAccess(union.types, fieldName, aliases);
  if (type === null) {
    return null;
  }
  const severity = strictMemberAccessSeverity(ctx);
  if (missing && severity !== "silent") {
    ctx.errors.push(
      diagnostic(
        "unionFieldNotOnEveryMember",
        { field: fieldName, union: formatTypeHint(union) },
        loc ?? null,
        { severity: strictSeverity(severity) },
      ),
    );
  }
  return type;
}

/**
 * Strict-aware property access on a Result receiver. At `silent`, defers to the
 * lenient `resolveResultFieldType` (`any` for Result fields) — behavior-
 * preserving. At `warn`/`error`, expands the Result to its object union and,
 * for a branch-specific field, emits a Result-framed diagnostic. Narrowed
 * Results are already object members and never reach here.
 *
 * Return contract matches `resolveResultFieldType`: `"any"` → caller returns
 * `"any"`; a type → caller sets `currentType`; `null` → fall through to the
 * generic "does not exist" handling.
 */
function accessResultField(
  result: ResultType,
  fieldName: string,
  aliases: Record<string, TypeAliasEntry>,
  ctx: TypeCheckerContext,
  loc: SourceLocation | undefined,
): VariableType | null {
  const severity = strictMemberAccessSeverity(ctx);
  if (severity === "silent") {
    return resolveResultFieldType(result, fieldName);
  }
  const { type, missing } = unionPropertyAccess(
    resultToObjectUnion(result, aliases).types,
    fieldName,
    aliases,
  );
  if (type === null) {
    return null;
  }
  if (missing && RESULT_BRANCH_FIELDS.has(fieldName)) {
    // Invariant (per lib/runtime/result.ts): `value` is the only success-only
    // field; every other branch field is failure-only. Update if Result grows
    // a new success-side field.
    const branch = fieldName === "value" ? "success" : "failure";
    ctx.errors.push(
      diagnostic(
        "resultBranchFieldAccess",
        { field: fieldName, branch },
        loc ?? null,
        { severity: strictSeverity(severity) },
      ),
    );
  }
  return type;
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
): VariableType {
  switch (expr.type) {
    case "variableName": {
      // Expression-match temp: `__matchval_<id>` is the synthetic ref the
      // lowerer leaves as an expression-match's value. It is never declared in
      // scope; resolve it directly to the match's computed value type so an
      // outer yield that reads an inner match's temp gets the inner union.
      const matchvalId = parseMatchValId(expr.value);
      if (matchvalId !== undefined) {
        return ctx.matchExprTypes[matchvalId] ?? ANY_T;
      }
      const scopeType = scope.lookup(expr.value);
      if (scopeType) {
        // Flow-sensitive narrowing: when a flow node is attached to this exact
        // reference node (populated by buildFlowGraphs; present during
        // checkScopes / Phase B), resolve through typeAt so narrowed types are
        // consistent across passes. Relies on AST node identity — the flowOf
        // WeakMap is keyed on the same node object the synthesizer receives. No
        // flow node (buildScopes / inference, before flowEnv exists, or a
        // synthetic node) → the declared scope type, unchanged. Only narrows a
        // *variable* (scopeType found); the ref-resolution below is untouched.
        if (ctx.flowEnv) {
          const flow = ctx.flowEnv.flowOf.get(expr);
          if (flow) {
            // Resolve against the CURRENT scope's type aliases
            // (ctx.getTypeAliases() tracks ctx.withScope), not the global
            // snapshot captured once in buildFlowGraphs — a scope that overrides
            // an alias must narrow against its own set. Safe with the shared
            // memo: each flow node belongs to one scope, so it is only ever
            // queried under that scope's alias context.
            return typeAt({ variable: expr.value, chain: [] }, flow, {
              ...ctx.flowEnv,
              typeAliases: ctx.getTypeAliases(),
            });
          }
        }
        return scopeType;
      }
      // Builtin variables resolve only after scope lookup fails, so a
      // real binding named `__dirname` shadows the builtin (the same
      // rule the generator applies — see issue #453).
      if (hasOwn(BUILTIN_VARIABLE_TYPES, expr.value)) {
        return BUILTIN_VARIABLE_TYPES[expr.value];
      }
      // Same hasOwnProperty rule for the def/node/import maps: a name
      // like "toString" would otherwise resolve to a prototype method
      // and crash assignability with a params-less functionRefType.
      const fnDef = hasOwn(ctx.functionDefs, expr.value)
        ? ctx.functionDefs[expr.value]
        : undefined;
      if (fnDef) {
        return {
          type: "functionRefType",
          name: expr.value,
          params: fnDef.parameters,
          returnType: fnDef.returnType ?? null,
          returnTypeValidated: fnDef.returnTypeValidated,
        };
      }
      const nodeDef = hasOwn(ctx.nodeDefs, expr.value)
        ? ctx.nodeDefs[expr.value]
        : undefined;
      if (nodeDef) {
        return {
          type: "functionRefType",
          name: expr.value,
          params: nodeDef.parameters,
          returnType: nodeDef.returnType ?? null,
          returnTypeValidated: nodeDef.returnTypeValidated,
        };
      }
      const imported = hasOwn(ctx.importedFunctions, expr.value)
        ? ctx.importedFunctions[expr.value]
        : undefined;
      if (imported) {
        return {
          type: "functionRefType",
          name: expr.value,
          params: imported.parameters,
          returnType: imported.returnType ?? null,
        };
      }
      return ANY_T;
    }
    case "number":
    case "unitLiteral":
      return NUMBER_T;
    case "string":
      // Single source of truth for string→literal-type; shared with the
      // discriminant-narrowing recognizer. number/boolean intentionally stay
      // NUMBER_T/BOOLEAN_T above (synthType does not infer numeric/boolean
      // literal types).
      return literalToType(expr) ?? STRING_T;
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
    case "typeTestExpression":
      return synthTypeTestExpression(expr, scope, ctx);
    case "hole":
      // A template hole's type is its inline annotation when present.
      // Without one it synthesizes as `any`; positions that supply no
      // expected type either are flagged by checkTemplateHoles (AG8002).
      return expr.typeAnnotation ?? ANY_T;
    case "codeLiteral":
      // A literal IS a Code value. The body is quoted — never checked
      // here; the completed program is checked in full at its own
      // compile. See CODE_LITERAL_TYPE for why the fields match stdlib
      // Code exactly.
      return CODE_LITERAL_TYPE;
    default:
      return ANY_T;
  }
}

/**
 * `try expr` runs `expr` and converts a thrown error to a `failure(...)`.
 * If the inner call already returns a Result, pass it through (matches
 * runtime `__tryCall` behavior). Otherwise wrap as `Result<T, any>`.
 */
/** Names that are JavaScript classes users plausibly reach for in a type
 *  pattern. They get a pointed AG1013 hint: type patterns never mean
 *  `instanceof`, so there is no schema-vs-class ambiguity to learn. */
const JS_CLASS_NAMES: readonly string[] = [
  "Date", "Map", "Set", "RegExp", "Error", "Promise", "Function", "Symbol",
];

/**
 * A type pattern's lowered test (`x is T`). Synthesizes `boolean`. The
 * typeHint is validated here with AG1013 as the SOLE diagnostic (the generic
 * AG1006 path never sees type-pattern hints — they live in an expression,
 * not an annotation), so `x is Bogus` reads as "not a type, did you mean to
 * bind?" rather than a generic alias error.
 */
function synthTypeTestExpression(
  expr: TypeTestExpression,
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType {
  synthType(expr.expression, scope, ctx);
  const aliases = ctx.getTypeAliases();
  visitTypes(expr.typeHint, (t) => {
    if (t.type === "typeAliasVariable" && !aliases[t.aliasName]) {
      const hint = JS_CLASS_NAMES.includes(t.aliasName)
        ? `\`${t.aliasName}\` is a JavaScript class, and type patterns only test Agency types. Use \`is object\` or a helper function.`
        : `to bind the value write \`const ${t.aliasName} = x\`.`;
      ctx.errors.push(
        diagnostic(
          "typePatternUnknownType",
          { name: t.aliasName, hint },
          expr.loc ?? null,
        ),
      );
    }
  });
  return BOOLEAN_T;
}

function synthTryExpression(
  expr: AgencyNode & { type: "tryExpression" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType {
  const inner = synthType(expr.call, scope, ctx);
  if (isAnyType(inner)) return inner;
  if (inner.type === "resultType") return inner;
  return { type: "resultType", successType: inner, failureType: ANY_T };
}

const BOOLEAN_OPS = new Set([
  "==",
  "!=",
  "===",
  "!==",
  "=~",
  "!~",
  "<",
  ">",
  "<=",
  ">=",
  // Unary `!` is desugared by the parser into a binOpExpression of the form
  // `{ op: "!", left: true, right: x }` (see unaryNotParser in parsers.ts).
  // It always yields a boolean.
  "!",
]);

const DIMENSION_CHECK_OPS = new Set([
  "+", "-", ">", "<", ">=", "<=", "==", "!=", "===", "!==",
]);

function synthBinOp(
  expr: AgencyNode & { type: "binOpExpression" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType {
  const op = expr.operator;
  if (op === "catch") return synthCatch(expr, scope, ctx);
  if (op === "|>") return synthPipe(expr, scope, ctx);
  if (op === "??") return synthNullishCoalesce(expr, scope, ctx);
  if (op === "||" || op === "&&") return synthLogical(expr, scope, ctx);

  // Dimension mismatch check: only when both sides are direct unit literals
  if (DIMENSION_CHECK_OPS.has(op) &&
      expr.left.type === "unitLiteral" && expr.right.type === "unitLiteral" &&
      expr.left.dimension !== expr.right.dimension) {
    ctx.errors.push(
      diagnostic(
        "dimensionMismatch",
        {
          op,
          leftDim: expr.left.dimension,
          rightDim: expr.right.dimension,
          left: formatUnitLiteral(expr.left),
          right: formatUnitLiteral(expr.right),
        },
        expr.loc ?? null,
      ),
    );
  }

  if (BOOLEAN_OPS.has(op)) return BOOLEAN_T;
  if (op === "+") {
    const leftType = synthType(expr.left, scope, ctx);
    const rightType = synthType(expr.right, scope, ctx);
    const isString = (t: VariableType) =>
      !isAnyType(t) &&
      ((t.type === "primitiveType" && t.value === "string") ||
        t.type === "stringLiteralType");
    if (isString(leftType) || isString(rightType)) {
      return STRING_T;
    }
  }
  return NUMBER_T;
}

/**
 * `lhs || rhs` returns lhs if it is truthy, otherwise rhs. Type is the
 * union of left and right (deduped). Same shape for `&&` — returns lhs if
 * falsy, otherwise rhs — so the runtime value also comes from one side or
 * the other.
 *
 * If either side is `any`, the result is `any`. If left and right
 * structurally collapse to a single type, return that type.
 */
function synthLogical(
  expr: AgencyNode & { type: "binOpExpression" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType {
  const left = synthType(expr.left, scope, ctx);
  const right = synthType(expr.right, scope, ctx);
  if (isAnyType(left) || isAnyType(right)) return ANY_T;
  const seen = new Map<string, VariableType>();
  const aliases = ctx.getTypeAliases();
  const collect = (t: VariableType) => {
    if (t.type === "unionType") {
      for (const m of t.types) seen.set(typeKey(m, aliases), m);
    } else {
      seen.set(typeKey(t, aliases), t);
    }
  };
  collect(left);
  collect(right);
  const unique = Array.from(seen.values());
  if (unique.length === 1) return unique[0];
  return { type: "unionType", types: unique };
}

/**
 * `lhs ?? rhs` returns lhs if it is non-null/undefined, otherwise rhs.
 * Strip `null` / `undefined` from a nullable LHS union, so
 * `(string | undefined) ?? ""` synths as `string`. If the resulting
 * non-nullable type collapses to nothing (LHS was `null | undefined`)
 * or LHS is `any`, fall back to the RHS type.
 */
function synthNullishCoalesce(
  expr: AgencyNode & { type: "binOpExpression" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType {
  const left = synthType(expr.left, scope, ctx);
  if (isAnyType(left)) return synthType(expr.right, scope, ctx);
  const stripped = stripNullable(left);
  if (stripped === undefined) return synthType(expr.right, scope, ctx);
  return stripped;
}

function isNullishPrimitive(t: VariableType): boolean {
  return (
    t.type === "primitiveType" && (t.value === "null" || t.value === "undefined")
  );
}

function stripNullable(t: VariableType): VariableType | undefined {
  if (isNullishPrimitive(t)) return undefined;
  if (t.type !== "unionType") return t;
  const kept = t.types.filter((m) => !isNullishPrimitive(m));
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0];
  return { ...t, types: kept };
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
): VariableType {
  const left = synthType(expr.left, scope, ctx);
  if (isAnyType(left)) return left;
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
): VariableType {
  const right = synthPipeRhs(expr.right, scope, ctx);
  if (isAnyType(right)) return right;
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
): VariableType {
  const rhsType = synthType(rhs, scope, ctx);
  if (!isAnyType(rhsType) && rhsType.type === "functionRefType") {
    const returnType =
      rhsType.returnType ??
      (!isAnyType(ctx.inferredReturnTypes[rhsType.name])
        ? (ctx.inferredReturnTypes[rhsType.name] as VariableType | undefined)
        : undefined);
    if (returnType) return resultTypeForValidation(returnType, rhsType.returnTypeValidated);
  }
  return rhsType;
}

/** The block argument of a call, if it carries one. The single home for
 *  the block cast - every block-typing consumer reads through this. */
function blockOf(
  expr: AgencyNode & { type: "functionCall" },
): { body: AgencyNode[] } | undefined {
  return (expr as unknown as { block?: { body: AgencyNode[] } }).block;
}

/** The type a block argument's OWN returns produce. The walk skips
 *  returns belonging to nested function/node/block definitions, then
 *  folds: no returns -> void; any return typed `any` -> `any`
 *  (fail-open); otherwise the union of the distinct return types.
 *  Every BLOCK_CALL_RESULT row reads through this one walk, so the
 *  block constructs cannot drift on what counts as a block-level
 *  return. */
function blockReturnType(
  block: { body: AgencyNode[] },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType {
  const returnTypes: VariableType[] = [];
  for (const { node, ancestors } of walkNodes(block.body)) {
    if (node.type !== "returnStatement" || !node.value) {
      continue;
    }
    const nested = ancestors.some(
      (a) =>
        a.type === "function" ||
        a.type === "graphNode" ||
        a.type === "blockArgument",
    );
    if (!nested) {
      returnTypes.push(synthType(node.value, scope, ctx));
    }
  }
  if (returnTypes.length === 0) {
    return VOID_T;
  }
  if (returnTypes.some((t) => isAnyType(t))) {
    return ANY_T;
  }
  return unionTypes(returnTypes);
}

/** Reserved calls whose type comes from their block's returns. The walk
 *  is shared (blockReturnType); only the wrapper differs. Adding
 *  another block-carrying reserved call is a row. Keying on the call
 *  name is shadow-proof: every key is in RESERVED_FUNCTION_NAMES. */
const BLOCK_CALL_RESULT: Record<
  string,
  (element: VariableType) => VariableType
> = {
  // The guard construct's Result<T> precision. By synth time the
  // construct has desugared to `_guard(...)` carrying its block
  // (guardDesugar.ts + the TypeChecker constructor); _guard's own
  // annotation is the generic Result, so parameterize it from the
  // block. A direct `_guard` call with a block gets the same, correct,
  // typing. The failure side stays `any`, the try-expression
  // precedent: the err-side narrowing users rely on (`isFailure`,
  // `error.type`) is field-based, not type-based.
  _guard: (element) => ({
    type: "resultType",
    successType: element,
    failureType: ANY_T,
  }),
  // fork joins every branch into a list. The list shape is kept even
  // for an `any` element - any[] still catches scalar annotations.
  // Failure slots are deliberately invisible (spec: "optimistic about
  // failures").
  fork: (element) => ({ type: "arrayType", elementType: element }),
  // race yields the first-SETTLED branch, or null when zero branches
  // ran (empty source, or a comprehension filter that matched nothing
  // - #604). An `any` element collapses to any, NOT any | null:
  // unionTypes does not absorb any, and fail-open must stay fail-open.
  // COUPLED to #606: if the empty-race return value or first-success
  // semantics change there, this row changes with them.
  race: (element) =>
    isAnyType(element) ? ANY_T : unionTypes([element, NULL_T]),
};

function synthFunctionCall(
  expr: AgencyNode & { type: "functionCall" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType {
  // Reserved block-carrying calls (guard construct, fork, race) take
  // their type from the block's returns - see BLOCK_CALL_RESULT. The
  // Object.hasOwn guard is load-bearing: functionName is user-supplied,
  // and a bare index on an object literal walks the prototype chain, so
  // a user function named toString/valueOf/constructor with a block
  // would get "wrapped" by Object.prototype methods - a silently wrong
  // type, not a crash. (The sibling tables, CALL_NAME and
  // COMPREHENSION_PREFIXES, have closed keysets and no such exposure.)
  const wrapBlockResult = Object.hasOwn(BLOCK_CALL_RESULT, expr.functionName)
    ? BLOCK_CALL_RESULT[expr.functionName]
    : undefined;
  const calledBlock = blockOf(expr);
  if (wrapBlockResult !== undefined && calledBlock !== undefined) {
    return wrapBlockResult(blockReturnType(calledBlock, scope, ctx));
  }
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
      const innerType = synthType(inner, scope, ctx);
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
  return ANY_T;
}

function synthArray(
  expr: AgencyNode & { type: "agencyArray" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType {
  if (expr.items.length === 0)
    return { type: "arrayType", elementType: ANY_T };
  const itemTypes: (VariableType)[] = [];
  for (const item of expr.items) {
    if (item.type === "splat") {
      const splatType = synthType(item.value, scope, ctx);
      if (isAnyType(splatType)) return ANY_T;
      if (splatType.type !== "arrayType") return ANY_T;
      itemTypes.push(splatType.elementType);
      continue;
    }
    itemTypes.push(synthType(item, scope, ctx));
  }
  const concreteTypes = itemTypes.filter((t): t is VariableType => !isAnyType(t));
  if (concreteTypes.length === 0) return ANY_T;
  if (concreteTypes.length === 1) {
    return { type: "arrayType", elementType: concreteTypes[0] };
  }
  // Deduplicate structurally identical types
  const seen = new Map<string, VariableType>();
  const aliases = ctx.getTypeAliases();
  for (const t of concreteTypes) {
    const key = typeKey(t, aliases);
    if (!seen.has(key)) seen.set(key, t);
  }
  const unique = Array.from(seen.values());
  const elementType = unique.length === 1
    ? unique[0]
    : { type: "unionType" as const, types: unique };
  return { type: "arrayType", elementType };
}

/**
 * The null literal in expression position — either the dedicated `null` node
 * or (as the parser produces in value position) a bare variableName named
 * "null". Mirrors `isNullExpr` in narrowing.ts, which is private there.
 */
function isNullLiteralExpr(e: AgencyNode): boolean {
  return e.type === "null" || (e.type === "variableName" && e.value === "null");
}

function synthObject(
  expr: AgencyNode & { type: "agencyObject" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType {
  // Use a Map so later entries overwrite earlier ones (later-wins for splats
  // followed by explicit keys, e.g. { ...a, x: "new" } produces x's literal type).
  const properties = new Map<string, VariableType>();
  // Track value types from computed-key entries — we can't know the key
  // statically, so the whole object degrades to a Record whose value type
  // is the union of all entry value types (static + computed).
  const computedValueTypes: VariableType[] = [];
  let hasComputedKey = false;
  for (const entry of expr.entries) {
    if ("type" in entry && entry.type === "splat") {
      const splatType = synthType(entry.value, scope, ctx);
      if (isAnyType(splatType)) return ANY_T;
      if (splatType.type !== "objectType") return ANY_T;
      for (const prop of splatType.properties)
        properties.set(prop.key, prop.value);
      continue;
    }
    const kv = entry as {
      key: string;
      computedKey?: AgencyNode;
      value: AgencyNode;
    };
    // A null literal reaches synth as a bare variableName named "null" (the
    // same shape narrowing's isNullExpr handles); synthType has no case for
    // it and returns "any", which would bail out the WHOLE object literal
    // below and silently skip assignment checking of every other property.
    // Type it as null here so siblings keep their checks. Scoped to object
    // literals on purpose: a general synthType null case would bind
    // `let x = null` to the null type and break later reassignment.
    const valueType = isNullLiteralExpr(kv.value)
      ? NULL_T
      : synthType(kv.value, scope, ctx);
    if (isAnyType(valueType)) {
      return ANY_T;
    }
    if (kv.computedKey) {
      hasComputedKey = true;
      computedValueTypes.push(valueType);
      continue;
    }
    properties.set(kv.key, valueType);
  }
  if (hasComputedKey) {
    const allValueTypes = [
      ...Array.from(properties.values()),
      ...computedValueTypes,
    ];
    if (allValueTypes.length === 0) return ANY_T;
    const unique = uniqBy(allValueTypes, (t) => typeKey(t, ctx.getTypeAliases()));
    const valueType: VariableType =
      unique.length === 1
        ? unique[0]
        : { type: "unionType" as const, types: unique };
    return {
      type: "genericType",
      name: "Record",
      typeArgs: [{ type: "primitiveType", value: "string" }, valueType],
    };
  }
  return {
    type: "objectType",
    properties: Array.from(properties, ([key, value]) => ({ key, value })),
  };
}

/**
 * The type of a tool-method chain element (`fn.partial(...)`,
 * `fn.describe("…")`, `fn.rename("…")`, `fn.preapprove()`). Each returns a new
 * tool, which is a function value — so we keep the receiver's functionRefType
 * rather than collapsing to `any`. That is what makes a single tool ineligible
 * where a `tools:` array is expected.
 *
 * `.partial(name: …)` binds arguments, so it drops those parameters from the
 * resulting signature — `_matchesFilter(name, filterText).partial(filterText:)`
 * becomes `(name) -> boolean`, which still satisfies a `(any) -> any` callback.
 * The other methods leave the signature untouched. When the receiver isn't a
 * known function we can't prove it's a tool, so we stay `any`.
 */
function toolMethodResultType(
  receiver: VariableType,
  methodName: string,
  element: { functionCall: { arguments: any[] } },
): VariableType {
  if (receiver.type !== "functionRefType") return ANY_T;
  if (methodName !== "partial") return receiver;
  const boundNames = element.functionCall.arguments
    .filter((a: any) => "type" in a && a.type === "namedArgument")
    .map((a: any) => a.name);
  return {
    ...receiver,
    params: receiver.params.filter((p) => !boundNames.includes(p.name)),
  };
}

function validateAgencyFunctionMethod(
  expr: ValueAccess,
  element: { kind: "methodCall"; functionCall: { type: "functionCall"; functionName: string; arguments: any[] } },
  methodName: string,
  scope: Scope,
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
      ctx.errors.push(
        diagnostic("partialRequiresNamedArgs", {}, expr.loc ?? null),
      );
    }
    const params = fnDef?.parameters ?? importedSig?.parameters ?? null;
    if (!params) return;
    const paramNames = new Set(params.map((p) => p.name));
    const namedArgs = args.filter(
      (a: any) => "type" in a && a.type === "namedArgument",
    );
    const typeAliases = ctx.getTypeAliases();
    for (const arg of namedArgs) {
      if (!paramNames.has(arg.name)) {
        ctx.errors.push(
          diagnostic(
            "unknownPartialParameter",
            {
              name: arg.name,
              fn: baseName,
              params: [...paramNames].join(", "),
            },
            expr.loc ?? null,
          ),
        );
        continue;
      }
      const param = params.find((p) => p.name === arg.name);
      if (!param) continue;
      // Variadic binding via .partial(rest: [...]) is allowed. The value's
      // type must match the variadic's array type (T[]), not the element
      // type T. Non-variadic params are type-checked by the regular call-arg
      // assignability path; we only validate variadic here because it would
      // otherwise be invisible to that pass.
      if (param.variadic) {
        if (!param.typeHint) continue;
        const expected: VariableType = param.typeHint.type === "arrayType"
          ? param.typeHint
          : { type: "arrayType", elementType: param.typeHint };
        const actual = synthType(arg.value, scope, ctx);
        if (isAnyType(actual)) continue;
        if (!isAssignable(actual, expected, typeAliases)) {
          ctx.errors.push(
            diagnostic(
              "partialArgNotAssignable",
              {
                actual: formatTypeHint(actual),
                expected: formatTypeHint(expected),
                fn: baseName,
              },
              expr.loc ?? null,
            ),
          );
        }
      }
    }
    return;
  }

  // describe / preapprove / rename — validated generically from their
  // declared signatures in AGENCY_FUNCTION_METHOD_TYPES (builtins.ts), so
  // adding a new such method is a one-line type entry, not checker code.
  const sig = AGENCY_FUNCTION_METHOD_TYPES[methodName];
  if (sig) {
    validatePrimitiveMethodCall(expr, element.functionCall, sig, scope, ctx);
  }
}

/**
 * Flow-sensitive path narrowing (M2): if a stable prefix of `expr` carries a
 * `narrow` for that exact ref, return its narrowed type and how many chain
 * elements it consumes — so `arr[0].value` reads the narrowed `arr[0]` and
 * `o.inner.r.value` reads the narrowed `o.inner.r`. Searches the LONGEST prefix
 * first (so the most precise narrowing wins). `null` = no narrowing → the caller
 * resolves the base structurally and the chain walk's diagnostics (strict member
 * access) run on the un-narrowed access. (Bare-base narrowing, `r.value`, flows
 * through `synthType(expr.base)` and needs nothing here.)
 *
 * `stablePrefix` (not `chainToSegments`) is used so a later UNSTABLE hop doesn't
 * block narrowing an earlier stable prefix (`a.b[i()].x` can still use a narrowed
 * `a.b`).
 *
 * The `flowHasNarrowFor` gate is required: without it, `typeAt` would return the
 * structural (un-narrowed) member type and short-circuiting on it would suppress
 * the strict-member-access error that un-guarded access must still raise.
 */
function narrowedPathPrefix(
  expr: ValueAccess,
  ctx: TypeCheckerContext,
): { type: VariableType; consumed: number } | null {
  if (!ctx.flowEnv || expr.base.type !== "variableName") return null;
  const flow = ctx.flowEnv.flowOf.get(expr);
  if (!flow) return null;
  const stable = stablePrefix(expr.chain);
  const env = { ...ctx.flowEnv, typeAliases: ctx.getTypeAliases() };
  for (let len = stable.length; len >= 1; len--) {
    const ref = { variable: expr.base.value, chain: stable.slice(0, len) };
    if (flowHasNarrowFor(ref, flow)) {
      return { type: typeAt(ref, flow, env), consumed: len };
    }
  }
  return null;
}

/** The shared "property does not exist" push — one wording, three receiver
 *  shapes (union member, object type, primitive-member fallback). */
function pushPropertyDoesNotExist(
  ctx: TypeCheckerContext,
  property: string,
  receiver: VariableType,
  loc: SourceLocation | undefined,
): void {
  ctx.errors.push(
    diagnostic(
      "propertyDoesNotExist",
      { property, type: formatTypeHint(receiver) },
      loc ?? null,
    ),
  );
}

export function synthValueAccess(
  expr: ValueAccess,
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType {
  const typeAliases = ctx.getTypeAliases();

  // When a narrowed stable prefix applies, start the structural walk from its
  // type at the next hop; otherwise resolve the base and walk the whole chain.
  const narrowedPrefix = narrowedPathPrefix(expr, ctx);
  let currentType =
    narrowedPrefix === null ? synthType(expr.base, scope, ctx) : narrowedPrefix.type;
  const chainStart = narrowedPrefix === null ? 0 : narrowedPrefix.consumed;

  for (const element of expr.chain.slice(chainStart)) {
    // Validate .partial()/.describe() even when the base type is unknown,
    // since we can check argument structure against the function definition.
    // Use continue (not return) so chained calls like fn.partial(a: 1).describe("x") are all validated.
    if (element.kind === "methodCall") {
      const methodName = element.functionCall.functionName;
      if (methodName === "partial" || methodName in AGENCY_FUNCTION_METHOD_TYPES) {
        validateAgencyFunctionMethod(expr, element, methodName, scope, ctx);
        // Chaining still works past this point because the dispatch above keys
        // on the method name, not the receiver type.
        currentType = toolMethodResultType(currentType, methodName, element);
        continue;
      }
    }

    if (isAnyType(currentType)) return ANY_T;
    const resolved = safeResolveType(currentType, typeAliases);
    if (isAnyType(resolved)) return ANY_T;
    // never is the bottom type: any access on it is itself never, and emits no
    // diagnostic (a provably-unreachable receiver must not flag spurious
    // missing-member errors).
    if (isNever(resolved)) return NEVER_T;

    switch (element.kind) {
      case "property": {
        // Result<T, E> field access. Inside a guard, `resolved` is already the
        // narrowed member (an objectType, handled below), so this branch only
        // sees UN-narrowed Results. `accessResultField` enforces strict access
        // per `strictMemberAccess` (default "error"): a branch-specific field
        // (.value/.error/…) without narrowing is diagnosed with Result-framed
        // guidance; `strictMemberAccess: "silent"` keeps the lenient `any`.
        if (resolved.type === "resultType") {
          const fieldType = accessResultField(
            resolved,
            element.name,
            typeAliases,
            ctx,
            expr.loc,
          );
          if (fieldType !== null && isAnyType(fieldType)) return ANY_T;
          if (fieldType !== null) {
            currentType = fieldType;
            break;
          }
          // null → fall through to generic handling (bogus Result field →
          // "does not exist"), matching today's behavior.
        }
        if (resolved.type === "unionType") {
          const memberType = accessUnionField(
            resolved,
            element.name,
            typeAliases,
            ctx,
            expr.loc,
          );
          if (memberType === null) {
            pushPropertyDoesNotExist(ctx, element.name, resolved, expr.loc);
            return ANY_T;
          }
          currentType = memberType;
        } else if (resolved.type === "objectType") {
          const prop = resolved.properties.find((p) => p.key === element.name);
          if (prop) {
            currentType = prop.value;
          } else {
            pushPropertyDoesNotExist(ctx, element.name, resolved, expr.loc);
            return ANY_T;
          }
        } else if (resolved.type === "genericType" && resolved.name === "Record") {
          // Record<K, V>: property access yields V (key existence is dynamic).
          currentType = resolved.typeArgs[1];
        } else {
          // Built-in member on a primitive (string.length, array.length, …)?
          const member = lookupPrimitiveMember(resolved, element.name);
          if (member && member.kind === "property") {
            currentType = resolvePropertyType(member.type, resolved);
            break;
          }
          pushPropertyDoesNotExist(ctx, element.name, resolved, expr.loc);
          return ANY_T;
        }
        break;
      }
      case "index": {
        if (resolved.type === "arrayType") {
          currentType = resolved.elementType;
        } else {
          // Record-like (`Record<K, V>` or an object literal): index access
          // yields the value type. Shared with the for-loop typer so `obj[k]`
          // and `for (k, v in obj)` agree on an object literal's value type.
          const recordLike = recordLikeKeyValue(resolved);
          if (recordLike) {
            currentType = recordLike.value;
          } else {
            return ANY_T;
          }
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
          if (methodName === "toJSONSchema") {
            // `toJSONSchema()` returns an arbitrary JSON Schema object —
            // we don't track its exact shape statically.
            currentType = ANY_T;
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
          currentType = isAnyType(sig.returnType) ? ANY_T : sig.returnType;
          break;
        }
        return ANY_T;
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
    ctx.errors.push(
      diagnostic(
        "namedArgsOnBuiltinMethod",
        { method: call.functionName },
        expr.loc ?? null,
      ),
    );
    return;
  }
  const hasSplat = args.some((a) => "type" in a && a.type === "splat");
  if (!hasSplat) {
    const minArgs = sig.minParams ?? sig.params.length;
    const hasRest = sig.restParam !== undefined;
    const maxArgs = hasRest ? Infinity : sig.params.length;
    if (args.length < minArgs || args.length > maxArgs) {
      const arity = { method: call.functionName, count: args.length };
      const loc = expr.loc ?? null;
      if (minArgs === maxArgs) {
        ctx.errors.push(
          diagnostic("methodArityExact", { ...arity, expected: minArgs }, loc),
        );
      } else if (maxArgs === Infinity) {
        ctx.errors.push(
          diagnostic("methodArityAtLeast", { ...arity, min: minArgs }, loc),
        );
      } else {
        ctx.errors.push(
          diagnostic(
            "methodArityRange",
            { ...arity, min: minArgs, max: maxArgs },
            loc,
          ),
        );
      }
      return;
    }
  }
  const typeAliases = ctx.getTypeAliases();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ("type" in arg && arg.type === "splat") continue; // skip splat element check for primitives
    const slotType =
      i < sig.params.length ? sig.params[i] : (sig.restParam as VariableType | undefined);
    if (slotType === undefined || isAnyType(slotType)) continue;
    const argType = synthType(arg as AgencyNode, scope, ctx);
    if (isAnyType(argType)) continue;
    if (!isAssignable(argType, slotType, typeAliases)) {
      ctx.errors.push(
        diagnostic(
          "builtinMethodArgNotAssignable",
          {
            actual: formatTypeHint(argType),
            expected: formatTypeHint(slotType),
            method: call.functionName,
          },
          expr.loc ?? null,
        ),
      );
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
): VariableType {
  const elementT = receiver.elementType;
  if (cbKind === "sameArray") return receiver;
  if (cbKind === "void") return VOID_T;
  if (cbKind === "boolean") return BOOLEAN_T;
  if (cbKind === "elementOrNull") {
    return { type: "unionType", types: [elementT, NULL_T] };
  }

  // The remaining kinds (`arrayU`, `flatten`, `reduce`) all need the
  // callback's return type. Synth it from whichever shape was provided.
  const cbReturn = synthCallbackReturnType(call, elementT, scope, ctx);

  if (cbKind === "arrayU") {
    if (isAnyType(cbReturn)) return ANY_T;
    return { type: "arrayType", elementType: cbReturn };
  }
  if (cbKind === "flatten") {
    if (isAnyType(cbReturn)) return ANY_T;
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
  return ANY_T;
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
): VariableType {
  if (call.block) {
    return synthBlockReturnType(call.block, elementT, scope, ctx);
  }
  const args = (call.arguments as AgencyNode[]) ?? [];
  if (args.length === 0) return ANY_T;
  const cbType = synthType(args[0], scope, ctx);
  if (isAnyType(cbType)) return ANY_T;
  if (cbType.type === "functionRefType") return cbType.returnType ?? ANY_T;
  if (cbType.type === "blockType") return cbType.returnType;
  return ANY_T;
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
): VariableType {
  const child = scope.child();
  // First param is the element; second (if present) is the index for
  // most array iteration methods. We don't try to special-case `reduce`
  // (param 0 = acc) — the resulting param types are best-effort and the
  // body can still infer through binOps and literals.
  block.params.forEach((p, i) => {
    if (i === 0) child.declareLocal(p.name, elementT);
    else if (i === 1) child.declareLocal(p.name, NUMBER_T);
    else child.declareLocal(p.name, ANY_T);
  });

  const returnTypes: (VariableType)[] = [];
  for (const { node } of walkNodes(block.body)) {
    if (node.type === "returnStatement" && node.value) {
      returnTypes.push(synthType(node.value, child, ctx));
    }
  }
  if (returnTypes.length === 0) return ANY_T;
  const concrete = returnTypes.filter((t): t is VariableType => !isAnyType(t));
  if (concrete.length === 0) return ANY_T;
  if (concrete.length === 1) return concrete[0];
  // Dedupe structurally identical types.
  const seen = new Map<string, VariableType>();
  const aliases = ctx.getTypeAliases();
  for (const t of concrete) {
    const key = typeKey(t, aliases);
    if (!seen.has(key)) seen.set(key, t);
  }
  const unique = Array.from(seen.values());
  return unique.length === 1
    ? unique[0]
    : { type: "unionType", types: unique };
}
