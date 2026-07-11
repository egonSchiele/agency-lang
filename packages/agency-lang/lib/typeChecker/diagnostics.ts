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
} as const;

export type DiagnosticName = keyof typeof DIAGNOSTICS;

/** The {placeholder} names of a template, as a string-literal union. */
type Placeholders<S extends string> =
  S extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never;

/** Typed params for a diagnostic: one key per {placeholder} in its template. */
export type DiagnosticParams<N extends DiagnosticName> = Record<
  Placeholders<(typeof DIAGNOSTICS)[N]["message"]>,
  string | number
>;

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
