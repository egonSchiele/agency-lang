import { GLOBAL_SCOPE_KEY, ScopedTypeAliases, type CompilationUnit } from "@/compilationUnit.js";
import { parseAgency } from "@/parser.js";
import { typeCheck } from "@/typeChecker/index.js";
import type { TypeAliasEntry, VariableType } from "@/types.js";
import { formatTypeHint } from "@/utils/formatType.js";

export type ShapeResult = { ok: true } | { ok: false; reason: string };

/**
 * A minimal CompilationUnit carrying only the alias registry, for
 * typechecking probe programs. CompilationUnit is a plain data type (no
 * closures — unlike TypeCheckerContext), so this construction is stable.
 */
export function makeProbeUnit(typeAliases: Record<string, TypeAliasEntry>): CompilationUnit {
  return {
    functionDefinitions: {},
    typeAliases: new ScopedTypeAliases({ [GLOBAL_SCOPE_KEY]: typeAliases }),
    graphNodes: [],
    importedNodes: [],
    importStatements: [],
    safeFunctions: {},
    importedFunctions: {},
    jsImportedNames: {},
  };
}

// Chosen to read acceptably if it ever leaks into a diagnostic shown to the
// mutator LLM ("assignment to 'proposedValue'" is self-explanatory).
const PROBE_VARIABLE = "proposedValue";

/**
 * Does `valueText` fit the type written as `declaredType`? Decided by the
 * language's own typechecker on a one-line probe program — parsed and
 * typechecked in memory, never executed. Any diagnostic (assignability,
 * unknown property, undefined variable inside an interpolation, parse
 * failure) is a rejection; the first message is the retry feedback for the
 * mutator LLM.
 *
 * Known fail-open, inherited from the language: an object literal containing
 * an explicit `null` field synthesizes to `any`, which skips the assignment
 * check entirely — such proposals are accepted unchecked. Fail-open is the
 * right direction (a valid value is never wrongly rejected).
 */
export function checkProposal(
  declaredType: string,
  valueText: string,
  typeAliases: Record<string, TypeAliasEntry>,
): ShapeResult {
  const probe = parseAgency(`const ${PROBE_VARIABLE}: ${declaredType} = ${valueText}`, {}, false);
  if (!probe.success) {
    // The parse failure may be the value OR the rendered type — surface the
    // parser's own message so retry feedback (and baseline self-test
    // fallbacks) are debuggable.
    return {
      ok: false,
      reason: `value does not parse as an Agency expression of type ${declaredType}${probe.message ? `: ${probe.message}` : ""}`,
    };
  }
  const result = typeCheck(probe.result, {}, makeProbeUnit(typeAliases));
  if (result.errors.length === 0) return { ok: true };
  return {
    ok: false,
    reason: result.errors[0].message.replaceAll(` (assignment to '${PROBE_VARIABLE}')`, ""),
  };
}

/**
 * Render an annotation back to parseable source text for probing and for the
 * mutator prompt. The baseline self-test in discovery validates the
 * round-trip: a rendered type that does not re-parse, or does not accept the
 * target's own original value, leaves the target unconstrained.
 */
export function renderDeclaredType(typeHint: VariableType): string {
  return formatTypeHint(typeHint);
}

/**
 * One-line description of a target's allowed values for the mutator prompt.
 * `declaredType === null` means freeform for text targets and
 * unconstrained for literal targets — see the valueKind-first invariant in
 * `OptimizeTarget`.
 */
export function describeConstraint(target: {
  declaredType: string | null;
  valueKind: string;
}): string {
  if (target.declaredType !== null) return target.declaredType;
  if (target.valueKind === "literal") return "any literal value";
  return "free text (any string; keep every ${...} placeholder)";
}
