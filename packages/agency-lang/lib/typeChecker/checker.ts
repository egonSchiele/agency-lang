import { ANY_T } from "./primitives.js";
import { diagnostic } from "./diagnostics.js";
import {
  AgencyNode,
  FunctionCall,
  FunctionParameter,
  VariableType,
} from "../types.js";
import { walkNodes, isInsideBlock, type WalkAncestor } from "../utils/node.js";
import { parseMatchValId } from "../matchVal.js";
import { scopeKey as getScopeKey } from "../compilationUnit.js";
import type { Scope as WalkScope } from "../types.js";
import { formatTypeHint } from "../utils/formatType.js";
import type { ValueAccess } from "../types/access.js";
import { BUILTIN_FUNCTION_TYPES } from "./builtins.js";
import { JS_GLOBALS, isJsGlobalBase, lookupJsMember } from "./resolveCall.js";
import { collectProgramShadowing } from "./shadowing.js";
import { isAssignable } from "./assignability.js";
import { synthType } from "./synthesizer.js";
import { ScopeInfo } from "./types.js";
import type { BuiltinSignature, TypeCheckerContext, TypeCheckError } from "./types.js";
import {
  checkType,
  checkConditionType,
  isAnyType,
  getParamsForNodeOrFunc,
  getBlockSlot,
  checkExcessObjectProperties,
} from "./utils.js";
import { Scope } from "./scope.js";
import { checkAssignmentValue } from "./scopes.js";
import { checkMatchExprYields } from "./matchExprTypes.js";
import { BOOLEAN_T, REGEX_T, STRING_T } from "./primitives.js";
import type { BlockType } from "../types/typeHints.js";
import { isSchemaTypeHint } from "../utils/schemaParam.js";

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
): VariableType | undefined {
  if (param.typeHint?.type === "arrayType") return param.typeHint.elementType;
  return param.typeHint ?? ANY_T;
}

/**
 * Array-typed slot for the named-arg form of a variadic.
 *
 * `foo(rest: [1, 2, 3])` binds the whole array, so the slot type is the
 * array (`T[]`), not the element (`T`). For declarations written as the
 * conventional `...xs: T[]`, the typeHint is already the array; for the
 * less-conventional `...xs: T`, we wrap the element type ourselves.
 * Returns `undefined` when the param is untyped — the caller treats that
 * as `any`.
 */
function variadicNamedSlotType(
  typeHint: VariableType | undefined,
): VariableType | undefined {
  if (!typeHint) return undefined;
  if (typeHint.type === "arrayType") return typeHint;
  return { type: "arrayType", elementType: typeHint };
}

export type ParamSlot = {
  type: VariableType | undefined;
  validated: boolean;
  /** Original parameter name. Absent for builtins (which can't take named args). */
  name?: string;
};

export type SlotRequest =
  | { kind: "positional"; index: number }
  | { kind: "named"; name: string };

export type ParamSignature = {
  minArgs: number;
  maxArgs: number;
  /** Declared parameter count (excludes splat pads). Used by splat
   *  checking to iterate each declared slot once. */
  paramCount: number;
  /**
   * Resolve the slot that an argument fills.
   *
   * - `{ kind: "positional", index }` — returns an element-typed slot for a
   *   variadic, matching the spread calling convention.
   * - `{ kind: "named", name }` — for variadics, returns a slot whose `type`
   *   is the *array* form (`T[]`) so the call-site value `foo(rest: [1,2])`
   *   type-checks against the whole array. Returns undefined for unknown
   *   names (caught earlier by `checkNamedArgStructure`).
   *
   * No consumer should branch on `param.variadic` to pick element-vs-array
   * itself — that's the rule this resolver encapsulates.
   */
  resolveSlot(req: SlotRequest): ParamSlot | undefined;
};

export function paramListSignature(
  params: FunctionParameter[],
  argCount: number,
): ParamSignature {
  const lastParam = params[params.length - 1];
  const hasRest = lastParam?.variadic === true;
  // Schema<...> parameters are injection-eligible: the preprocessor's
  // `injectSchemaArgs` pass fills them in from the call's expected type
  // (LHS annotation or enclosing return type) when omitted, so they are
  // effectively optional from the type checker's perspective.
  const minArgs = params.filter(
    (p) =>
      p.defaultValue === undefined &&
      !p.variadic &&
      !isSchemaTypeHint(p.typeHint),
  ).length;
  const maxArgs = hasRest ? Infinity : params.length;

  // Internal positional slot list — variadic gets an element-typed slot.
  const positionalSlots: ParamSlot[] = params.map((p) => ({
    type: p.typeHint,
    validated: !!p.validated,
    name: p.name,
  }));
  if (hasRest) {
    const elementType = variadicElementType(lastParam);
    const restSlot: ParamSlot = {
      type: elementType,
      validated: positionalSlots[positionalSlots.length - 1]?.validated ?? false,
      name: lastParam.name,
    };
    positionalSlots[positionalSlots.length - 1] = restSlot;
    while (positionalSlots.length < argCount) positionalSlots.push(restSlot);
  }

  return {
    minArgs,
    maxArgs,
    paramCount: params.length,
    resolveSlot(req) {
      if (req.kind === "positional") return positionalSlots[req.index];
      // Named lookup: find the declared param. For a variadic param, the
      // named-arg form `foo(rest: [1,2])` binds the whole array, so the
      // slot type is the array type (T[]) rather than the element type.
      const idx = params.findIndex((p) => p.name === req.name);
      if (idx < 0) return undefined;
      const param = params[idx];
      if (param.variadic) {
        return {
          type: variadicNamedSlotType(param.typeHint),
          validated: !!param.validated,
          name: param.name,
        };
      }
      return {
        type: param.typeHint,
        validated: !!param.validated,
        name: param.name,
      };
    },
  };
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
      checkAssignmentsInScope(scope, ctx);
    });
  }
}

/**
 * Flow-aware Phase B pass for assignment value-vs-target checks (annotated
 * `checkType`, access-chain writes, reassignment). Moved here from
 * `declareVariable` (Phase A) so the checks narrow through the flow graph —
 * `synthType`/`checkType` consult `ctx.flowEnv`, which is populated by
 * `buildFlowGraphs` before `checkScopes` runs.
 */
function checkAssignmentsInScope(info: ScopeInfo, ctx: TypeCheckerContext): void {
  for (const { node, scopes } of walkNodes(info.body)) {
    if (!isInScope(scopes, info)) {
      continue;
    }
    checkAssignmentValue(node, info.scope, ctx);
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
export function isInScope(scopes: WalkScope[], info: ScopeInfo): boolean {
  if (scopes.length === 0) return true;
  const innermostKey = getScopeKey(scopes[scopes.length - 1]);
  if (innermostKey === info.scopeKey) return true;
  if (info.scopeKey !== "global" && innermostKey === "global") return true;
  return false;
}

function checkFunctionCallsInScope(
  info: ScopeInfo,
  ctx: TypeCheckerContext,
): void {
  for (const { node, ancestors, scopes } of walkNodes(info.body)) {
    if (!isInScope(scopes, info)) continue;
    if (node.type === "functionCall") {
      // Skip method calls (`x.foo()`) — `walkNodes` descends into
      // `valueAccess.chain[].functionCall`, but the call refers to a
      // member of the receiver, not a global function. Resolving its
      // name against `functionDefs` would falsely flag arity / unknown
      // errors when a same-named global exists.
      const parent = ancestors[ancestors.length - 1];
      if (parent?.type === "valueAccess") continue;
      checkSingleFunctionCall(node, info.scope, ctx);
      checkSaveDraftCall(node, info, ctx);
    }
  }
}

/** `saveDraft(v)` records a best-so-far value that a tripping enclosing `guard`
 *  yields in place of a failure — so `v` must be assignable to the enclosing
 *  scope's return type, the same contract a `return` obeys. This covers def/node
 *  bodies AND guard blocks (a block's return type is inferred from its `return`).
 *  Only a scope with no inferred/declared return type (`info.returnType`
 *  undefined) is skipped. Name-keyed: aliasing `saveDraft` (`const s = saveDraft;
 *  s(v)`) escapes the check (documented v1 limitation). */
function checkSaveDraftCall(
  call: FunctionCall,
  info: ScopeInfo,
  ctx: TypeCheckerContext,
): void {
  if (call.functionName !== "saveDraft") return;
  // Only the stdlib saveDraft carries the draft contract. Stand down when
  // the name resolves to anything the user wrote: a local def or node, or
  // an import whose origin is not the stdlib thread module. Those are
  // ordinary functions and their arguments check against their own
  // signatures. An UNRESOLVED name keeps the check: unresolved imports
  // already raise their own diagnostics, and in fail-open resolution the
  // only saveDraft people call is the stdlib one.
  if (ctx.functionDefs["saveDraft"] || ctx.nodeDefs["saveDraft"]) return;
  const imported = ctx.importedFunctions["saveDraft"];
  if (imported && !isStdlibSaveDraftOrigin(imported.originFile)) return;
  if (!info.returnType) return; // no declared/inferred return type in scope
  if (call.arguments.length !== 1) return;
  const first = call.arguments[0];
  // A splat's runtime expansion is unknowable here: the argument node
  // holds an ARRAY whose elements become the call's arguments, so
  // checking the splat expression against the scalar return type would
  // be a false error. The generic call checks still cover the splat.
  if (first.type === "splat") return;
  // `saveDraft(value: x)` names the parameter but carries the same draft;
  // check the value it wraps so the named form cannot bypass the rule.
  const arg = first.type === "namedArgument" ? first.value : first;
  checkType(arg, info.returnType, info.scope, "the saveDraft() draft value", ctx);
}

/** True when an import's origin file is the stdlib prelude (or the
 *  origin is unknown, which is the fail-open resolution path). saveDraft
 *  lives in std::index and arrives via the auto-injected prelude import.
 *  Keeps checkSaveDraftCall pinned to the real builtin even if import
 *  resolution grows to populate importedFunctions in more cases. */
function isStdlibSaveDraftOrigin(originFile: string | undefined): boolean {
  if (!originFile) return true;
  return /[\\/]stdlib[\\/]index\.agency$/.test(originFile);
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
    const sig = paramListSignature(params, call.arguments.length);
    if (!checkArity(call, sig.minArgs, sig.maxArgs, hasSplatArg, ctx)) return;
    checkArgsAgainstParams(call, sig, scope, ctx);
    return;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      BUILTIN_FUNCTION_TYPES,
      call.functionName,
    )
  ) {
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
    // A namespace global may also be directly callable (e.g. `String(x)`).
    if (entry.kind === "namespace" && entry.callableSig) {
      checkCallAgainstBuiltinSig(
        call,
        entry.callableSig,
        scope,
        ctx,
        hasSplatArg,
      );
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
  const allowedNamed = sig.acceptsNamedArgs ?? {};
  const allowedNames = Object.keys(allowedNamed);
  const seenNamed = new Set<string>();
  const typeAliases = ctx.getTypeAliases();
  for (const a of call.arguments) {
    if (a.type !== "namedArgument") continue;
    if (!(a.name in allowedNamed)) {
      if (allowedNames.length === 0) {
        ctx.errors.push(
          diagnostic(
            "namedArgsOnlyAgencyFunctions",
            { fn: call.functionName },
            call.loc ?? null,
          ),
        );
      } else {
        ctx.errors.push(
          diagnostic(
            "namedArgNotAccepted",
            {
              fn: call.functionName,
              name: a.name,
              allowed: allowedNames.join(", "),
            },
            call.loc ?? null,
          ),
        );
      }
      return;
    }
    // Duplicate named arg (Copilot #3) — mirrors the
    // checkNamedArgStructure behavior for Agency-defined functions.
    if (seenNamed.has(a.name)) {
      ctx.errors.push(
        diagnostic(
          "duplicateNamedArg",
          { name: a.name, fn: call.functionName },
          call.loc ?? null,
        ),
      );
      return;
    }
    seenNamed.add(a.name);
    // Validate the named-arg value's type against the declared one
    // (Copilot #4). Skip when the allowlist entry is the `any` type.
    const expected = allowedNamed[a.name];
    if (!isAnyType(expected)) {
      const actual = synthType(a.value, scope, ctx);
      if (!isAnyType(actual) && !isAssignable(actual, expected, typeAliases)) {
        ctx.errors.push(
          diagnostic(
            "namedArgTypeMismatch",
            {
              name: a.name,
              fn: call.functionName,
              expected: formatTypeHint(expected),
              actual: formatTypeHint(actual),
            },
            call.loc ?? null,
          ),
        );
        return;
      }
    }
  }
  if (call.block && !sig.acceptsBlock) {
    ctx.errors.push(
      diagnostic(
        "blockArgNotAccepted",
        { fn: call.functionName },
        call.block.loc ?? call.loc ?? null,
      ),
    );
    return;
  }
  const minArgs = sig.minParams ?? sig.params.length;
  const hasRest = sig.restParam !== undefined;
  let maxArgs = hasRest ? Infinity : sig.params.length;
  if (sig.acceptsBlock) {
    maxArgs += 1;
  }
  // Recognized named args (e.g. `shared: true` on fork/race) don't
  // count toward arity since they don't fill a positional slot.
  // Strip them out of a shallow call copy before the arity check and
  // the positional-args walk.
  const positionalCall: FunctionCall =
    allowedNames.length === 0
      ? call
      : {
          ...call,
          arguments: call.arguments.filter(
            (a) => a.type !== "namedArgument",
          ),
        };
  if (!checkArity(positionalCall, minArgs, maxArgs, hasSplatArg, ctx)) return;
  const slots: ParamSlot[] = sig.params.map((type) => ({
    type,
    validated: false,
  }));
  if (hasRest) {
    while (slots.length < positionalCall.arguments.length) {
      slots.push({ type: sig.restParam!, validated: false });
    }
  }
  // Builtins (apart from the recognized named args allowlist above)
  // have no parameter names. Wrap the flat slot array in a minimal
  // ParamSignature so the shared `checkArgsAgainstParams` path applies.
  const builtinSig: ParamSignature = {
    minArgs,
    maxArgs,
    paramCount: sig.params.length,
    resolveSlot(req) {
      if (req.kind === "positional") return slots[req.index];
      return undefined;
    },
  };
  checkArgsAgainstParams(positionalCall, builtinSig, scope, ctx);
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
  shadowing: { importedNodeNames: readonly string[] },
): void {
  if (expr.base.type !== "variableName") return;
  const baseName = expr.base.value;
  if (
    !isJsGlobalBase(baseName, {
      scope,
      functionDefs: ctx.functionDefs,
      nodeDefs: ctx.nodeDefs,
      importedFunctions: ctx.importedFunctions,
      importedNodeNames: shadowing.importedNodeNames,
      jsImportedNames: ctx.jsImportedNames,
    })
  )
    return;
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
      isAnyType(hint)
    ) {
      return true;
    }
  }
  ctx.errors.push(
    diagnostic(
      "blockArgNotAccepted",
      { fn: call.functionName },
      call.block.loc ?? call.loc ?? null,
    ),
  );
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
  const pushErr = (err: TypeCheckError) => {
    ctx.errors.push(err);
    ok = false;
  };

  // Pass 1: only named args can follow the first named arg. Splats can't
  // appear after a named arg either — the runtime can't tell statically
  // how many positional slots a splat will fill, so mixing it with named
  // args would create an ambiguous overlap between the splat's elements
  // and the named values. (The TypeScript builder's resolveNamedArgs and
  // the runtime's resolveNamed both reject this combination.) Splats are
  // fine *before* the first named arg.
  for (let i = namedStartIdx + 1; i < call.arguments.length; i++) {
    const a = call.arguments[i];
    if (a.type === "splat") {
      pushErr(
        diagnostic(
          "splatAfterNamedArg",
          { fn: call.functionName },
          call.loc ?? null,
        ),
      );
      break;
    }
    if (a.type !== "namedArgument") {
      pushErr(
        diagnostic(
          "positionalAfterNamedArg",
          { fn: call.functionName },
          call.loc ?? null,
        ),
      );
      break;
    }
  }

  // Pass 2: validate each named arg against the parameter list. All declared
  // params — including variadics and block-typed params — can be passed by
  // name. (For variadic, the named-array form `rest: [1,2]` binds the whole
  // spread; for block params, `block: fn` works the same as the trailing
  // `as { ... }` syntax. The runtime resolver rejects supplying both for
  // the same param.)
  const seen = new Set<string>();
  for (let i = namedStartIdx; i < call.arguments.length; i++) {
    const arg = call.arguments[i];
    if (arg.type !== "namedArgument") continue;
    if (seen.has(arg.name)) {
      pushErr(
        diagnostic(
          "duplicateNamedArg",
          { name: arg.name, fn: call.functionName },
          call.loc ?? null,
        ),
      );
      continue;
    }
    seen.add(arg.name);
    const paramIdx = params.findIndex((p) => p.name === arg.name);
    if (paramIdx < 0) {
      pushErr(
        diagnostic(
          "unknownNamedArg",
          { name: arg.name, fn: call.functionName },
          call.loc ?? null,
        ),
      );
    } else if (paramIdx < namedStartIdx) {
      pushErr(
        diagnostic(
          "namedArgConflictsPositional",
          { name: arg.name, position: paramIdx + 1, fn: call.functionName },
          call.loc ?? null,
        ),
      );
    }
  }

  // Pass 3: mixed positional + named-variadic rule. If any named arg targets
  // a variadic parameter, no positional argument may exist past the last
  // fixed (non-variadic) parameter — i.e. no positional may feed the
  // variadic when it is also bound by name. See spec §1 "Mixed positional +
  // named-variadic rule".
  const variadicParam = params.find((p) => p.variadic);
  if (variadicParam) {
    const variadicNamed = call.arguments.find(
      (a) => a.type === "namedArgument" && a.name === variadicParam.name,
    );
    if (variadicNamed) {
      const fixedCount = params.filter((p) => !p.variadic).length;
      // Positional args appear before namedStartIdx; any positional at
      // index >= fixedCount would feed the variadic.
      const positionalCount = Math.min(namedStartIdx, call.arguments.length);
      if (positionalCount > fixedCount) {
        pushErr(
          diagnostic(
            "positionalFeedsNamedVariadic",
            { param: variadicParam.name, fn: call.functionName },
            call.loc ?? null,
          ),
        );
      }
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
  const arity = { fn: call.functionName, count: argCount };
  const arityLoc = call.loc ?? null;
  if (maxArgs === Infinity) {
    ctx.errors.push(
      diagnostic("callArityAtLeast", { ...arity, min: minArgs }, arityLoc),
    );
  } else if (minArgs === maxArgs) {
    ctx.errors.push(
      diagnostic("callArityExact", { ...arity, expected: minArgs }, arityLoc),
    );
  } else {
    ctx.errors.push(
      diagnostic(
        "callArityRange",
        { ...arity, min: minArgs, max: maxArgs },
        arityLoc,
      ),
    );
  }
  return false;
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
  sig: ParamSignature,
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
        sig,
        scope,
        ctx,
      );
      return;
    }
    let slot: ParamSlot | undefined;
    let innerArg: AgencyNode;
    if (arg.type === "namedArgument") {
      // Unknown names are caught upstream in checkNamedArgStructure; the
      // resolver returns undefined for them and we skip the check.
      slot = sig.resolveSlot({ kind: "named", name: arg.name });
      innerArg = arg.value;
    } else {
      slot = sig.resolveSlot({ kind: "positional", index: argIndex });
      innerArg = arg;
    }
    const argType = synthType(innerArg, scope, ctx);
    const paramType = slot?.type;
    if (paramType === undefined || isAnyType(paramType) || isAnyType(argType)) {
      continue;
    }
    // Validated params accept either the un-bang'd type T or any Result —
    // failures pass through unvalidated per docs/site/guide/schemas.md.
    if (slot?.validated && argType.type === "resultType") {
      continue;
    }
    if (!isAssignable(argType, paramType, typeAliases)) {
      ctx.errors.push(
        diagnostic(
          "argNotAssignable",
          {
            actual: formatTypeHint(argType),
            expected: formatTypeHint(paramType),
            fn: call.functionName,
          },
          call.loc ?? null,
        ),
      );
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
  sig: ParamSignature,
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  const splatType = synthType(splatSource, scope, ctx);
  if (isAnyType(splatType)) return;
  if (splatType.type !== "arrayType") {
    const splatStr = formatTypeHint(splatType);
    ctx.errors.push(
      diagnostic(
        "splatMustBeArray",
        { actual: splatStr, fn: call.functionName },
        call.loc ?? null,
      ),
    );
    return;
  }
  const elementType = splatType.elementType;
  const elementStr = formatTypeHint(elementType);
  const typeAliases = ctx.getTypeAliases();
  // Check splat element type against each declared param slot from splatIndex
  // onward. For a variadic-last function, position params.length-1 returns
  // the element-typed slot, which is the right thing to compare against.
  for (let i = splatIndex; i < sig.paramCount; i++) {
    const slot = sig.resolveSlot({ kind: "positional", index: i });
    if (!slot) continue;
    const paramType = slot.type;
    if (paramType === undefined || isAnyType(paramType)) continue;
    if (isAssignable(elementType, paramType, typeAliases)) continue;
    const paramStr = formatTypeHint(paramType);
    ctx.errors.push(
      diagnostic(
        "splatElementNotAssignable",
        { actual: elementStr, expected: paramStr, fn: call.functionName },
        call.loc ?? null,
      ),
    );
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
    // `return match(...)` lowers to `return __matchval_<id>`. Check each arm's
    // yield against the declared return type using its UNWIDENED type (per
    // `checkMatchExprYields`), so a literal-union return type accepts a literal
    // yield and errors anchor on the offending arm — mirroring the annotated
    // assignment path. The widened union that `checkType`/`synthType` would use
    // for the `__matchval_` ref would falsely reject such returns.
    const matchId = matchvalRefId(node.value);
    if (matchId !== undefined) {
      checkMatchExprYields(
        matchId,
        info.returnType,
        `return in '${info.name}'`,
        ctx,
        node.loc,
      );
      continue;
    }
    checkType(
      node.value,
      info.returnType,
      info.scope,
      `return in '${info.name}'`,
      ctx,
    );
  }
}

/** The match id `N` when `expr` is the lowered `__matchval_N` temp reference a
 *  `return match(...)` produces, else undefined. */
function matchvalRefId(expr: AgencyNode): number | undefined {
  if (expr.type !== "variableName") return undefined;
  return parseMatchValId(expr.value);
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
  const shadowing = collectProgramShadowing(ctx.programNodes);
  for (const { node, ancestors, scopes } of walkNodes(info.body)) {
    if (!isInScope(scopes, info)) continue;
    if (node.type === "valueAccess") {
      checkJsNamespaceMemberCall(node, info.scope, ctx, shadowing);
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
      checkConditionType(node.condition, info.scope, ctx);
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
  if (slotType === undefined || isAnyType(slotType)) return;

  const leftType = synthType(expr.left, scope, ctx);
  if (isAnyType(leftType)) return;
  const flowingType =
    leftType.type === "resultType" ? leftType.successType : leftType;
  if (isAnyType(flowingType)) return;

  if (!isAssignable(flowingType, slotType, ctx.getTypeAliases())) {
    ctx.errors.push(
      diagnostic(
        "pipeSlotNotAssignable",
        {
          actual: formatTypeHint(flowingType),
          expected: formatTypeHint(slotType),
        },
        expr.loc ?? null,
      ),
    );
  }
}

function pipeRhsSlotType(
  rhs: AgencyNode,
  ctx: TypeCheckerContext,
): VariableType | undefined {
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
  if (isAnyType(left)) return;
  const expected = left.type === "resultType" ? left.successType : left;
  checkType(node.right, expected, scope, "catch default", ctx);
}
