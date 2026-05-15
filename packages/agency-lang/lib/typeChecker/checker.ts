import {
  AgencyNode,
  FunctionCall,
  FunctionParameter,
  VariableType,
} from "../types.js";
import { walkNodes, isInsideBlock, type WalkAncestor } from "../utils/node.js";
import { scopeKey as getScopeKey } from "../compilationUnit.js";
import type { Scope as WalkScope } from "../types.js";
import { formatTypeHint } from "../utils/formatType.js";
import type { ValueAccess } from "../types/access.js";
import { BUILTIN_FUNCTION_TYPES } from "./builtins.js";
import { JS_GLOBALS, lookupJsMember } from "./resolveCall.js";
import { isAssignable } from "./assignability.js";
import { synthType } from "./synthesizer.js";
import { ScopeInfo } from "./types.js";
import type { BuiltinSignature, TypeCheckerContext } from "./types.js";
import {
  checkType,
  isAnyType,
  getParamsForNodeOrFunc,
  getBlockSlot,
  checkExcessObjectProperties,
} from "./utils.js";
import { Scope } from "./scope.js";
import { BOOLEAN_T, REGEX_T, STRING_T } from "./primitives.js";
import type { BlockType } from "../types/typeHints.js";

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

/**
 * `walkNodes` descends into nested function/graphNode/method bodies,
 * yielding their inner expressions with their own scope chain. When we're
 * checking a single scope, we want to skip items that belong to nested
 * scopes — they get checked separately when their own ScopeInfo is
 * processed. Without this filter, an expression inside `node main()`
 * would also be checked under the global scope, which would lose any
 * type aliases declared inside the node body.
 *
 * Items inside intra-def constructs that don't open a new scope (if /
 * while / for / handle / fork bodies) keep the parent's scope chain, so
 * they pass through.
 *
 * walkNodes seeds an empty scopes list with [globalScope]. For a per-def
 * ScopeInfo, the body passed to walkNodes is the def's body, so direct
 * children appear with scopes=[globalScope] — accept those when info is
 * a per-def scope.
 *
 * Class methods don't currently get their own ScopeInfo (buildScopes
 * only iterates functionDefs/nodeDefs), so the global pass owns them —
 * accept method-body nodes when info is the global scope, otherwise
 * those expressions never get checked.
 */
function isInScope(scopes: WalkScope[], info: ScopeInfo): boolean {
  if (scopes.length === 0) return true;
  const innermostKey = getScopeKey(scopes[scopes.length - 1]);
  if (innermostKey === info.scopeKey) return true;
  if (info.scopeKey !== "global" && innermostKey === "global") return true;
  // Class-method bodies have their own scope chain in walkNodes but no
  // dedicated ScopeInfo — fall through to the global pass to ensure
  // they still get type-checked.
  if (info.scopeKey === "global" && isClassMethodScope(innermostKey)) {
    return true;
  }
  return false;
}

function isClassMethodScope(key: string): boolean {
  // walkNodes tags method bodies with `function:Class.method` (note the
  // `.` between class and method names). Function defs use plain
  // `function:foo`, so the dot is the discriminator.
  return key.startsWith("function:") && key.includes(".");
}

function checkFunctionCallsInScope(
  info: ScopeInfo,
  ctx: TypeCheckerContext,
): void {
  for (const { node, ancestors, scopes } of walkNodes(info.body)) {
    if (!isInScope(scopes, info)) continue;
    if (node.type === "functionCall") {
      checkSingleFunctionCall(node, info.scope, ctx);
    }
  }
}

export function isInsideHandler(ancestors: WalkAncestor[]): boolean {
  return ancestors.some((a) => {
    if (a.type === "handleBlock") return true;
    if (a.type === "withModifier" && a.handlerName !== "propagate") return true;
    return false;
  });
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
    if (!checkBlockArgShape(call, params, ctx)) return;
    const { minArgs, maxArgs, slots } = paramListSignature(
      params,
      call.arguments.length,
    );
    if (!checkArity(call, minArgs, maxArgs, hasSplatArg, ctx)) return;
    checkArgsAgainstParams(call, slots, scope, ctx);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(BUILTIN_FUNCTION_TYPES, call.functionName)) {
    checkCallAgainstBuiltinSig(
      call,
      BUILTIN_FUNCTION_TYPES[call.functionName],
      scope,
      ctx,
      hasSplatArg,
    );
    return;
  }

  // Flat callable JS globals (parseInt, parseFloat, isNaN, …) with a
  // populated `sig`. Namespace member calls like `JSON.parse(...)` are
  // valueAccess nodes and are checked in checkExpressionsInScope. JS
  // globals without a `sig` keep the existence-only behavior — no arity
  // or type validation, mirroring the diagnostic's Phase 1 behavior.
  if (Object.prototype.hasOwnProperty.call(JS_GLOBALS, call.functionName)) {
    const entry = JS_GLOBALS[call.functionName];
    if (entry.kind === "callable" && entry.sig) {
      checkCallAgainstBuiltinSig(call, entry.sig, scope, ctx, hasSplatArg);
    }
  }
}

/**
 * Common arity + per-arg type validation for a call against a
 * `BuiltinSignature`. Used for both `BUILTIN_FUNCTION_TYPES` entries (true
 * Agency primitives) and `JS_GLOBALS` entries that have a populated `sig`.
 *
 * Builtins have no parameter names, so named args and block args are
 * rejected here — the backend can't bind either.
 */
function checkCallAgainstBuiltinSig(
  call: FunctionCall,
  sig: BuiltinSignature,
  scope: Scope,
  ctx: TypeCheckerContext,
  hasSplatArg: boolean,
): void {
  if (call.arguments.some((a) => a.type === "namedArgument")) {
    ctx.errors.push({
      message: `Named arguments can only be used with Agency-defined functions, not '${call.functionName}'.`,
      loc: call.loc,
    });
    return;
  }
  if (call.block) {
    ctx.errors.push({
      message: `'${call.functionName}' does not accept a block argument.`,
      loc: call.block.loc ?? call.loc,
    });
    return;
  }
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

/**
 * Validate a `<JsNamespace>.<member>(args)` call against `JS_GLOBALS`'s
 * sig (when populated). Only the simple shape — base = bare variableName
 * matching a JS namespace, single methodCall in the chain — is checked;
 * deeper or computed chains are left to the runtime.
 *
 * Skips cases where the base is shadowed by a local binding (so `let JSON
 * = ...` cleanly opts out). Entries without `sig` (e.g. `console.log`)
 * are skipped — they're variadic / loosely typed by design.
 */
function checkJsNamespaceMemberCall(
  expr: ValueAccess,
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  if (expr.base.type !== "variableName") return;
  const baseName = expr.base.value;
  if (scope.has(baseName)) return;
  if (Object.prototype.hasOwnProperty.call(ctx.functionDefs, baseName)) return;
  if (Object.prototype.hasOwnProperty.call(ctx.importedFunctions, baseName)) return;
  if (!Object.prototype.hasOwnProperty.call(JS_GLOBALS, baseName)) return;
  if (expr.chain.length !== 1) return;
  const access = expr.chain[0];
  if (access.kind !== "methodCall") return;
  const member = access.functionCall;
  const entry = lookupJsMember([baseName, member.functionName]);
  if (!entry || entry.kind !== "callable" || !entry.sig) return;
  const hasSplatArg = member.arguments.some((a) => a.type === "splat");
  // Reuse the BUILTIN-style check. It uses `member.functionName` in error
  // messages, so the user sees `'parse' …` for `JSON.parse(...)`. Acceptable
  // — disambiguation is in the source location, not the function name.
  checkCallAgainstBuiltinSig(member, entry.sig, scope, ctx, hasSplatArg);
}

/**
 * If the call passes a block (trailing `as` or inline `\... -> ...`), the
 * function must declare a `blockType` parameter to receive it. Reject calls
 * that pass a block to a function with no block-typed param.
 *
 * Returns false to bail before downstream checks emit confusing diagnostics.
 */
function checkBlockArgShape(
  call: FunctionCall,
  params: FunctionParameter[],
  ctx: TypeCheckerContext,
): boolean {
  if (!call.block) return true;
  // The backend pushes `call.block` as the final positional argument, so the
  // last parameter is what receives it. Accept a block-typed slot, or the
  // permissive cases — untyped (no hint) and `any` — that could legitimately
  // hold a block.
  const lastParam = params[params.length - 1];
  if (lastParam) {
    const hint = lastParam.typeHint;
    if (
      hint === undefined ||
      hint.type === "blockType" ||
      (hint.type === "primitiveType" && hint.value === "any")
    ) {
      return true;
    }
  }
  ctx.errors.push({
    message: `'${call.functionName}' does not accept a block argument.`,
    loc: call.block.loc ?? call.loc,
  });
  return false;
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
      pushErr(
        `Duplicate named argument '${arg.name}' in call to '${call.functionName}'.`,
      );
      continue;
    }
    seen.add(arg.name);
    const paramIdx = nameableParams.findIndex((p) => p.name === arg.name);
    if (paramIdx < 0) {
      pushErr(
        `Unknown named argument '${arg.name}' in call to '${call.functionName}'.`,
      );
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
  // A block argument (trailing `as` block or inline `\... -> ...`) fills the
  // block-typed param slot but lives at `call.block`, not `call.arguments`.
  // Count it so `f() as x { }` doesn't look like a 0-arg call.
  const argCount = call.arguments.length + (call.block ? 1 : 0);
  if (argCount >= minArgs && argCount <= maxArgs) return true;
  ctx.errors.push({
    message: `Expected ${formatArity(minArgs, maxArgs)} argument(s) for '${call.functionName}', but got ${argCount}.`,
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
    // failures pass through unvalidated per docs/site/guide/schemas.md.
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
    if (innerArg.type === "agencyObject") {
      checkExcessObjectProperties(
        innerArg,
        paramType,
        `call to '${call.functionName}'`,
        ctx,
      );
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

  for (const { node, ancestors, scopes } of walkNodes(info.body)) {
    if (!isInScope(scopes, info)) continue;
    if (node.type !== "returnStatement" || !node.value) continue;
    // Returns inside a block belong to the block, not the enclosing function;
    // they're checked against the slot's return type by checkExpressionsInScope.
    if (isInsideBlock(ancestors)) continue;
    checkType(
      node.value,
      info.returnType,
      info.scope,
      `return in '${info.name}'`,
      ctx,
    );
  }
}

/**
 * Find the `blockType` slot for the innermost enclosing block, if any.
 * `walkNodes` includes the `blockArgument` AST node in `ancestors` when
 * descending into a block body, so the innermost `blockArgument` ancestor
 * marks "we're inside a block" and the immediately preceding ancestor is
 * the call that received it.
 */
function findEnclosingBlockSlot(
  ancestors: WalkAncestor[],
  ctx: TypeCheckerContext,
): BlockType | undefined {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (ancestors[i].type !== "blockArgument") continue;
    const parent = ancestors[i - 1];
    if (parent?.type !== "functionCall") return undefined;
    return getBlockSlot(parent.functionName, ctx);
  }
  return undefined;
}

function checkExpressionsInScope(
  info: ScopeInfo,
  ctx: TypeCheckerContext,
): void {
  for (const { node, ancestors, scopes } of walkNodes(info.body)) {
    if (!isInScope(scopes, info)) continue;
    if (node.type === "valueAccess") {
      checkJsNamespaceMemberCall(node, info.scope, ctx);
      synthType(node, info.scope, ctx);
    } else if (node.type === "returnStatement" && node.value) {
      // A return inside a block body belongs to the block, not the enclosing
      // function. If the block fills a typed slot, check the return value
      // against the slot's declared return type. (Inference for the enclosing
      // function already excludes block returns — see inference.ts.)
      const blockSlot = findEnclosingBlockSlot(ancestors, ctx);
      if (blockSlot) {
        checkType(
          node.value,
          blockSlot.returnType,
          info.scope,
          "block return",
          ctx,
        );
      } else {
        synthType(node.value, info.scope, ctx);
      }
    } else if (node.type === "ifElse" || node.type === "whileLoop") {
      checkType(node.condition, BOOLEAN_T, info.scope, "condition", ctx);
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

/**
 * Validate the LHS of `|>` against the slot it flows into on the RHS:
 * - bare variable RHS (`lhs |> half`) — slot is param 0
 *
 * Note: valueAccess RHS (e.g. `lhs |> add.partial(b: 5)`) is not yet
 * type-checked — pipeRhsSlotType returns undefined for non-variableName nodes.
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
