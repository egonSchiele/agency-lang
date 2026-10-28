/**
 * Type errors in the generated program, mapped back to the workflow step and
 * field whose lines they fall in. The field a wrong argument name belongs to
 * comes from the diagnostic's structured payload, never from its message.
 */
import type { Problem, Range } from "./types.js";

export type Diagnostic = {
  message: string;
  loc?: { line: number };
  params?: Record<string, string | number>;
};

function fieldOf(range: Range, diagnostic: Diagnostic): string | null {
  const name = diagnostic.params?.name;
  if (range.owner.field === "args" && typeof name === "string") {
    return `args.${name}`;
  }
  return range.owner.field;
}

export function problemsFromDiagnostics(diagnostics: Diagnostic[], ranges: Range[]): Problem[] {
  return diagnostics.map((diagnostic) => {
    const line = diagnostic.loc?.line;
    const range = ranges.find(
      (candidate) => line !== undefined && candidate.from <= line && line <= candidate.to,
    );
    if (range === undefined) {
      return { step: null, field: null, message: diagnostic.message };
    }
    return {
      step: range.owner.step,
      field: fieldOf(range, diagnostic),
      message: diagnostic.message,
    };
  });
}
