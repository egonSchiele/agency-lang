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
  staticReassignedAtTopLevel: {
    code: "AG7004",
    severity: "error",
    message:
      "Cannot reassign static `{name}` at module top level — statics are immutable after initialization. Use a global (`const`/`let` without `static`) if you need a mutable value.",
  },
} as const;

export type DiagnosticName = keyof typeof DIAGNOSTICS;

/** The {placeholder} names of a template, as a string-literal union. */
type Placeholders<S extends string> =
  S extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never;

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
 * Render a template. Throws on a missing param: typed call sites cannot hit
 * this, but an `as any` caller or future untyped path must fail loudly
 * rather than ship the string "undefined" inside a user-facing message.
 */
export function renderMessage(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(
        `renderMessage: missing param '${key}' for template: ${template}`,
      );
    }
    return String(value);
  });
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
    loc: loc ?? undefined, // transitional; the required-fields flip makes this `loc` verbatim
  };
}
