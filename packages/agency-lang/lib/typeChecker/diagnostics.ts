import type { SourceLocation } from "../types/base.js";
import type { TypeCheckError } from "./types.js";

/**
 * The single source of truth for every diagnostic the type checker can emit.
 *
 * APPEND-ONLY: a shipped code is never renumbered or reused. A retired
 * diagnostic keeps its entry with `retired: true` so the code stays reserved.
 * Codes are AG#### with category ranges (documentation, not machinery):
 *   AG1xxx types/aliases          AG2xxx assignability/checking
 *   AG3xxx interrupts/effects     AG4xxx names/scope/reserved/const
 *   AG5xxx match/narrowing        AG6xxx tools/llm/blocks
 *   AG7xxx static-init/config/imports
 *
 * Message templates use {param} placeholders. Templates are extracted
 * VERBATIM from the legacy inline strings — rendered output must be
 * byte-identical (the migration safety gate). Conditional phrasing NEVER
 * goes into a param (params are structured data, not sentence fragments):
 * a site that built its message conditionally gets one entry per phrasing.
 * EXCEPTION for closed-set WORDS (not fragments): a param may hold a single
 * word chosen from a fixed set — e.g. {kind} = Function|Node, or
 * {argumentWord} = argument|arguments for pluralization — because these are
 * enum-like values, not free-form phrasing.
 *
 * Deliberate `loc: null` (file-level) diagnostics, and why no AST node is
 * reachable at the site:
 *   (populated during the migration sweep; final list in the PR body)
 */
export const DIAGNOSTICS = {
  reassignToConst: {
    code: "AG4005",
    severity: "error",
    message: "Cannot reassign to constant '{name}'.",
  },
  regexInStructuredOutput: {
    code: "AG6001",
    severity: "error",
    message:
      "'regex' cannot appear in an llm() structured-output type ({context}); LLMs can't return regex values through JSON.",
  },
  typeNotAssignableInContext: {
    code: "AG2001",
    severity: "error",
    message: "Type '{actual}' is not assignable to type '{expected}' ({context}).",
  },
  conditionNotBoolean: {
    code: "AG2002",
    severity: "error",
    message: "Type '{actual}' is not assignable to type 'boolean' (condition).",
  },
  unknownProperty: {
    code: "AG2003",
    severity: "error",
    message: "Unknown property '{key}' on type '{expected}' ({context}).",
  },
  exportRequiresStaticConst: {
    code: "AG7001",
    severity: "error",
    message:
      "Only 'static const' declarations can be exported. Use 'export static const {name} = ...' instead.",
  },
  missingAnnotationStrictMode: {
    code: "AG2004",
    severity: "error",
    message: "Variable '{name}' has no type annotation (strict mode).",
  },
  typeNotAssignable: {
    code: "AG2005",
    severity: "error",
    message: "Type '{actual}' is not assignable to type '{expected}'.",
  },
  forLoopIterableType: {
    code: "AG2006",
    severity: "error",
    message: "For-loop iterable must be an array or Record, got '{actual}'.",
  },
  handlerParamValidated: {
    code: "AG3001",
    severity: "error",
    message:
      "The '!' validation syntax is not allowed on handler parameters. Validate the data inside the handler body if needed.",
  },
  typeParamDefaultOrder: {
    code: "AG1001",
    severity: "error",
    message:
      "Type parameter '{param}' (no default) must come before parameters that have defaults in '{alias}'.",
  },
  shadowsImportedFunction: {
    code: "AG4001",
    severity: "warning",
    message: "'{name}' shadows an imported function.",
  },
  reservedBuiltinRedefined: {
    code: "AG4002",
    severity: "error",
    message: "'{name}' is a reserved built-in; cannot be redefined.",
  },
  reservedBuiltinTypeRedefined: {
    code: "AG4003",
    severity: "error",
    message: "'{name}' is a reserved built-in type; cannot be redefined.",
  },
  validatedParamsRequireResult: {
    code: "AG2007",
    severity: "error",
    message:
      "{kind} '{name}' has validated parameters but its return type is not a Result type. Validated parameters can short-circuit with a failure, so the return type must be 'Result<...>'.",
  },
  docStringParamInterpolation: {
    code: "AG6002",
    severity: "error",
    message:
      "Cannot interpolate parameter '{param}' in doc string — parameter values are not known when the tool description is sent to the LLM. Use a global variable instead.",
  },
  notValueParameterized: {
    code: "AG1002",
    severity: "error",
    message:
      "Type '{alias}' is not a value-parameterized type but was given {count} value {argumentWord} (referenced in '{context}').",
  },
  tooManyValueArgs: {
    code: "AG1003",
    severity: "error",
    message:
      "{alias} expects at most {max} value {argumentWord}, got {count} (referenced in '{context}').",
  },
  valueArgsRequired: {
    code: "AG1004",
    severity: "error",
    message:
      "'{alias}' is a value-parameterized type and requires value arguments — write '{alias}({formals})' (referenced in '{context}').",
  },
  tooFewValueArgs: {
    code: "AG1005",
    severity: "error",
    message:
      "{alias} requires at least {min} value {argumentWord} (referenced in '{context}').",
  },
  unknownTypeAlias: {
    code: "AG1006",
    severity: "error",
    message: "Type alias '{alias}' is not defined (referenced in '{context}').",
  },
  genericRequiresTypeArgs: {
    code: "AG1007",
    severity: "error",
    message:
      "Generic type '{alias}' requires type arguments (referenced in '{context}').",
  },
  builtinGenericArity: {
    code: "AG1008",
    severity: "error",
    message:
      "{alias} expects {expected} type {argumentWord}, got {count} (referenced in '{context}').",
  },
  unknownGenericType: {
    code: "AG1009",
    severity: "error",
    message: "Unknown generic type '{alias}' (referenced in '{context}').",
  },
  notGenericType: {
    code: "AG1010",
    severity: "error",
    message: "Type '{alias}' is not a generic type (referenced in '{context}').",
  },
  tooManyTypeArgs: {
    code: "AG1011",
    severity: "error",
    message:
      "{alias} expects at most {max} type {argumentWord}, got {count} (referenced in '{context}').",
  },
  tooFewTypeArgs: {
    code: "AG1012",
    severity: "error",
    message:
      "{alias} requires at least {min} type {argumentWord} (referenced in '{context}').",
  },
  bannedBuiltinInStaticInit: {
    code: "AG7002",
    severity: "error",
    message:
      "{contextLabel} cannot call `{builtin}(...)` — {reason}, but static initializers run once at process startup before any per-run state exists. Move this call into a node or a function called from a node.",
  },
  interruptInStaticInit: {
    code: "AG7003",
    severity: "error",
    message:
      "{contextLabel} cannot `interrupt(...)` — interrupts pause the per-run execution stack, but static initializers run once at process startup before any agent run has begun. Move this into a node body.",
  },
  unionFieldNotOnEveryMember: {
    code: "AG2008",
    severity: "error",
    message:
      "Property '{field}' is not available on every member of '{union}'; narrow the value (e.g. with a guard) before accessing it.",
  },
  resultBranchFieldAccess: {
    code: "AG2009",
    severity: "error",
    message:
      "'.{field}' is only available on a {branch} Result; guard with 'if (isSuccess(r))' / 'if (isFailure(r))', use 'r catch …', or 'match (r) {{ … }}'.",
  },
  dimensionMismatch: {
    code: "AG2010",
    severity: "error",
    message:
      "Cannot {op} values of different dimensions ({leftDim} and {rightDim}): '{left}' and '{right}'.",
  },
  propertyDoesNotExist: {
    code: "AG2011",
    severity: "error",
    message: "Property '{property}' does not exist on type '{type}'.",
  },
  partialRequiresNamedArgs: {
    code: "AG6003",
    severity: "error",
    message: ".partial() requires named arguments, e.g. fn.partial(a: 5).",
  },
  unknownPartialParameter: {
    code: "AG6004",
    severity: "error",
    message:
      "Unknown parameter '{name}' in .partial() call. '{fn}' has parameters: {params}.",
  },
  partialArgNotAssignable: {
    code: "AG6005",
    severity: "error",
    message:
      "Argument type '{actual}' is not assignable to parameter type '{expected}' in .partial() call to '{fn}'.",
  },
  namedArgsOnBuiltinMethod: {
    code: "AG6006",
    severity: "error",
    message: "Named arguments are not supported on built-in method '.{method}()'.",
  },
  methodArityExact: {
    code: "AG6007",
    severity: "error",
    message: "Method '.{method}()' expects {expected} argument(s), got {count}.",
  },
  methodArityAtLeast: {
    code: "AG6008",
    severity: "error",
    message:
      "Method '.{method}()' expects at least {min} argument(s), got {count}.",
  },
  methodArityRange: {
    code: "AG6009",
    severity: "error",
    message: "Method '.{method}()' expects {min}–{max} argument(s), got {count}.",
  },
  builtinMethodArgNotAssignable: {
    code: "AG6010",
    severity: "error",
    message:
      "Argument type '{actual}' is not assignable to parameter type '{expected}' in call to '.{method}()'.",
  },
  namedArgsOnlyAgencyFunctions: {
    code: "AG6011",
    severity: "error",
    message:
      "Named arguments can only be used with Agency-defined functions, not '{fn}'.",
  },
  namedArgNotAccepted: {
    code: "AG6012",
    severity: "error",
    message:
      "'{fn}' does not accept the named argument '{name}'. Allowed: {allowed}.",
  },
  duplicateNamedArg: {
    code: "AG6013",
    severity: "error",
    message: "Duplicate named argument '{name}' in call to '{fn}'.",
  },
  namedArgTypeMismatch: {
    code: "AG6014",
    severity: "error",
    message:
      "Named argument '{name}' on '{fn}' expects type '{expected}', got '{actual}'.",
  },
  blockArgNotAccepted: {
    code: "AG6015",
    severity: "error",
    message: "'{fn}' does not accept a block argument.",
  },
  callArityExact: {
    code: "AG6016",
    severity: "error",
    message: "Expected {expected} argument(s) for '{fn}', but got {count}.",
  },
  callArityAtLeast: {
    code: "AG6017",
    severity: "error",
    message: "Expected at least {min} argument(s) for '{fn}', but got {count}.",
  },
  callArityRange: {
    code: "AG6018",
    severity: "error",
    message: "Expected {min}-{max} argument(s) for '{fn}', but got {count}.",
  },
  argNotAssignable: {
    code: "AG6019",
    severity: "error",
    message:
      "Argument type '{actual}' is not assignable to parameter type '{expected}' in call to '{fn}'.",
  },
  splatMustBeArray: {
    code: "AG6020",
    severity: "error",
    message: "Splat argument must be an array, got '{actual}' in call to '{fn}'.",
  },
  splatElementNotAssignable: {
    code: "AG6021",
    severity: "error",
    message:
      "Splat element type '{actual}' is not assignable to parameter type '{expected}' in call to '{fn}'.",
  },
  pipeSlotNotAssignable: {
    code: "AG6022",
    severity: "error",
    message:
      "Type '{actual}' is not assignable to pipe slot of type '{expected}'.",
  },
  splatAfterNamedArg: {
    code: "AG6023",
    severity: "error",
    message: "Splat argument cannot follow a named argument in call to '{fn}'.",
  },
  positionalAfterNamedArg: {
    code: "AG6024",
    severity: "error",
    message:
      "Positional argument cannot follow a named argument in call to '{fn}'.",
  },
  unknownNamedArg: {
    code: "AG6025",
    severity: "error",
    message: "Unknown named argument '{name}' in call to '{fn}'.",
  },
  namedArgConflictsPositional: {
    code: "AG6026",
    severity: "error",
    message:
      "Named argument '{name}' conflicts with positional argument at position {position} in call to '{fn}'.",
  },
  positionalFeedsNamedVariadic: {
    code: "AG6027",
    severity: "error",
    message:
      "Positional argument cannot feed variadic parameter '{param}' when it is also bound by name in call to '{fn}'.",
  },
  effectDeclaredTwice: {
    code: "AG3002",
    severity: "error",
    message: "Effect '{effect}' is declared more than once in the same file.",
  },
  effectPayloadConflict: {
    code: "AG3003",
    severity: "error",
    message:
      "Conflicting payload types for effect '{effect}'. All declarations of an effect must agree on its payload.",
  },
  namedArgsOnRaise: {
    code: "AG3004",
    severity: "error",
    message:
      "Named arguments are not allowed on 'raise'/'interrupt'. Pass the data positionally.",
  },
  effectDataMissing: {
    code: "AG3005",
    severity: "error",
    message: "Effect '{effect}' expects data {payload}, but none was supplied.",
  },
  effectDataFieldMissing: {
    code: "AG3006",
    severity: "error",
    message: "Effect '{effect}' data field '{field}' is missing.",
  },
  effectDataFieldWrongType: {
    code: "AG3007",
    severity: "error",
    message: "Effect '{effect}' data field '{field}' has the wrong type.",
  },
  effectDataMismatch: {
    code: "AG3008",
    severity: "error",
    message: "Effect '{effect}' data does not match the declared {payload}.",
  },
  unhandledInterrupts: {
    code: "AG3009",
    severity: "warning",
    message:
      "Function '{fn}' may throw interrupts [{effects}] but is not inside a handler.",
  },
  handlerBodyRaises: {
    code: "AG3010",
    severity: "error",
    message:
      "Handler {handler} may raise interrupts [{effects}]. That would re-enter the handler chain (the dispatcher visits every handler, even the one currently running) and recurse until `HandlerRecursionError` fires at runtime. Restructure so the handler doesn't call interrupt-raising code (e.g. hoist file I/O out of the handler), or suppress this error with `// @tc-ignore` on the line above the `handle` block.",
  },
  interruptInCallback: {
    code: "AG3011",
    severity: "error",
    message:
      "`interrupt` is not allowed inside a callback body (callback registered on '{hook}' may raise [{effects}]). Callbacks fire as side effects; their body cannot pause execution to ask the user a question. Move the `interrupt` into the calling node/function instead, or use a runtime guard if you wanted budget enforcement.",
  },
  raisesNotAnEffectSet: {
    code: "AG3012",
    severity: "error",
    message:
      "'raises {ref}' is not an effect set. Declare '{ref}' with 'effectSet' (not 'type'), or use an inline set like '<...>'.",
  },
  raisesExceeded: {
    code: "AG3013",
    severity: "error",
    message:
      "{kind} '{name}' raises effect '{effect}', which exceeds its declared 'raises {declared}'. Add '{effect}' to the clause.",
  },
  valueMayRaiseAnyEffect: {
    code: "AG3014",
    severity: "error",
    message:
      "{who} may raise any effect (its type has no 'raises' clause), which exceeds the 'raises <{allowed}>' allowed by type '{type}'. Add a 'raises' clause to the value's type.",
  },
  valueEffectExceedsRaises: {
    code: "AG3015",
    severity: "error",
    message:
      "{who} raises effect '{effect}', which exceeds the 'raises <{allowed}>' allowed by type '{type}'. Add '{effect}' to the clause, or use a target type that allows it.",
  },
  undefinedFunction: {
    code: "AG4004",
    severity: "error",
    message: "Function '{name}' is not defined.",
  },
  reservedBlockKeyword: {
    code: "AG4006",
    severity: "error",
    message:
      "`{keyword}` is a reserved block keyword. Write `{keyword} {{ ... }}` or `{keyword}(args) {{ ... }}` directly — the `as` keyword is not supported on {keyword} blocks (there's nothing to bind).",
  },
  undefinedVariable: {
    code: "AG4007",
    severity: "error",
    message: "Variable '{name}' is not defined.",
  },
  matchNotExhaustive: {
    code: "AG5002",
    severity: "error",
    message: "match is not exhaustive: missing {missing}.",
  },
  notAllPathsReturn: {
    code: "AG2012",
    severity: "error",
    message: "Not all code paths return a value in '{fn}'.",
  },
  toolRequiredParamUnbound: {
    code: "AG6028",
    severity: "error",
    message:
      "Tool '{tool}' has required function-typed parameter '{param}' is unbound. Bind it with .partial({param}: <value>) before passing as a tool.",
  },
  toolRequiredParamUnboundTyped: {
    code: "AG6029",
    severity: "error",
    message:
      "Tool '{tool}' has required function-typed parameter '{param}' is unbound ({type}). Bind it with .partial({param}: <value>) before passing as a tool.",
  },
  toolOptionalParamsDropped: {
    code: "AG6030",
    severity: "warning",
    message:
      "Tool '{tool}' will be exposed to the LLM without optional function-typed parameter(s): {params}. The function body must be prepared to run with the declared default for each.",
  },
  staticReassignedAtTopLevel: {
    code: "AG7004",
    severity: "error",
    message:
      "Cannot reassign static `{name}` at module top level — statics are immutable after initialization. Use a global (`const`/`let` without `static`) if you need a mutable value.",
  },
  staticMutatedViaMethod: {
    code: "AG7005",
    severity: "error",
    message:
      "Cannot mutate static `{name}` via `.{method}(...)` at module top level — statics are deep-frozen after initialization. Use a global (`const`/`let` without `static`) if you need a mutable value.",
  },
} as const;

export type DiagnosticName = keyof typeof DIAGNOSTICS;

/**
 * The {placeholder} names of a template, as a string-literal union.
 * A candidate containing a brace or space is not a placeholder — it comes
 * from an {{escaped}} literal-brace region — and is dropped (mirrors the
 * runtime \w+ rule in renderMessage).
 */
type NonPlaceholderChar = "{" | "}" | " ";
type IsPlaceholderName<P extends string> =
  P extends `${string}${NonPlaceholderChar}${string}` ? false : true;
type Placeholders<S extends string> =
  S extends `${string}{${infer P}}${infer Rest}`
    ? (IsPlaceholderName<P> extends true ? P : never) | Placeholders<Rest>
    : never;

/**
 * Typed params for a diagnostic: every {placeholder} in its template is a
 * REQUIRED key (missing one is a compile error at the call site). Extra keys
 * are allowed — params are the structured payload, and a site may carry
 * machine-readable data beyond what the message mentions (e.g. the variable
 * name on an assignability error whose message only shows the types).
 */
export type DiagnosticParams<N extends DiagnosticName> = Record<
  Placeholders<(typeof DIAGNOSTICS)[N]["message"]>,
  string | number
> &
  Record<string, string | number>;

/**
 * Render a template. Literal braces in message text are written as {{ and }}
 * (unescaped after substitution, so they can never be misread as
 * placeholders). Throws on a missing param: typed call sites cannot hit
 * this, but an `as any` caller or future untyped path must fail loudly
 * rather than ship the string "undefined" inside a user-facing message.
 */
export function renderMessage(
  template: string,
  params: Record<string, string | number>,
): string {
  const OPEN_SENTINEL = "\u0000";
  const CLOSE_SENTINEL = "\u0001";
  const substituted = template
    .replace(/\{\{/g, OPEN_SENTINEL)
    .replace(/\}\}/g, CLOSE_SENTINEL)
    .replace(/\{(\w+)\}/g, (_, key: string) => {
      const value = params[key];
      if (value === undefined) {
        throw new Error(
          `renderMessage: missing param '${key}' for template: ${template}`,
        );
      }
      return String(value);
    });
  return substituted
    .replace(new RegExp(OPEN_SENTINEL, "g"), "{")
    .replace(new RegExp(CLOSE_SENTINEL, "g"), "}");
}

/**
 * Build a TypeCheckError from the registry. `loc: null` is a DELIBERATE
 * file-level diagnostic (greppable), never an accident of omission.
 * `overrides.severity` exists for config-driven sites (strict member access,
 * exhaustiveness, undefined names) — the registry carries the default.
 */
export function diagnostic<N extends DiagnosticName>(
  name: N,
  params: DiagnosticParams<N>,
  loc: SourceLocation | null,
  overrides?: { severity?: "error" | "warning" },
): TypeCheckError {
  const entry = DIAGNOSTICS[name];
  return {
    code: entry.code,
    name,
    message: renderMessage(entry.message, params),
    severity: overrides?.severity ?? entry.severity,
    params,
    loc,
  };
}
