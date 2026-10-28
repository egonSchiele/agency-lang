/**
 * Type errors in the generated program, mapped back to the workflow step and
 * field whose lines they fall in. The field a wrong argument name belongs to
 * comes from the diagnostic's structured payload, never from its message.
 */
import type { Owner, Problem, Range } from "./types.js";

/** `loc.line` is 0-based, as the typechecker reports it. */
export type Diagnostic = {
  code: string;
  message: string;
  loc?: { line: number };
  params?: Record<string, string | number>;
};

/** The diagnostics about one argument of a call, and the payload field that
 *  names the argument: `name` is the name the call wrote, `param` the
 *  parameter a mistyped argument was matched to. */
const ARGUMENT_DIAGNOSTICS: Record<string, "name" | "param"> = {
  AG6012: "name", // not an accepted named argument
  AG6013: "name", // duplicate named argument
  AG6014: "name", // named argument of the wrong type
  AG6019: "param", // argument not assignable to its parameter
  AG6025: "name", // unknown named argument
  AG6026: "name", // named argument conflicts with a positional one
};

function argumentOf(diagnostic: Diagnostic): string | null {
  const field = ARGUMENT_DIAGNOSTICS[diagnostic.code];
  const name = field === undefined ? undefined : diagnostic.params?.[field];
  return typeof name === "string" && name !== "" ? name : null;
}

function fieldOf(owner: Owner, diagnostic: Diagnostic): string | null {
  const argument = argumentOf(diagnostic);
  return owner.field === "args" && argument !== null ? `args.${argument}` : owner.field;
}

/** The owner of the lines that hold a diagnostic, or of the declared type its
 *  `context` names when it has no line. */
function ownerOf(
  diagnostic: Diagnostic,
  ranges: Range[],
  typeOwners: Record<string, Owner>,
): Owner | null {
  const loc = diagnostic.loc;
  if (loc !== undefined) {
    const line = loc.line + 1;
    return ranges.find((range) => range.from <= line && line <= range.to)?.owner ?? null;
  }
  const context = diagnostic.params?.context;
  return typeof context === "string" ? (typeOwners[context] ?? null) : null;
}

export function problemsFromDiagnostics(
  diagnostics: Diagnostic[],
  ranges: Range[],
  typeOwners: Record<string, Owner> = {},
): Problem[] {
  return diagnostics.map((diagnostic) => {
    const owner = ownerOf(diagnostic, ranges, typeOwners);
    if (owner === null) {
      return { step: null, field: null, message: diagnostic.message };
    }
    return { step: owner.step, field: fieldOf(owner, diagnostic), message: diagnostic.message };
  });
}
