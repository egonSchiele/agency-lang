import { GLOBAL_SCOPE_KEY, ScopedTypeAliases, type CompilationUnit } from "@/compilationUnit.js";
import { parseAgency } from "@/parser.js";
import { typeCheck } from "@/typeChecker/index.js";
import type { Expression, TypeAliasEntry, VariableType } from "@/types.js";
import { formatTypeHint } from "@/utils/formatType.js";

export type ShapeResult = { ok: true } | { ok: false; reason: string };

/**
 * The parser represents `null` as a variableName node — there is no
 * `{ type: "null" }` in parser output. Single point of truth for the check
 * so no caller ever tests `expr.type === "null"` (dead code).
 */
export function isNullLiteral(expr: Expression): boolean {
  return expr.type === "variableName" && expr.value === "null";
}

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

const PROBE_VARIABLE = "__optimizeProbe";

/**
 * Does `valueText` fit the type written as `constraintText`? Decided by the
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
  constraintText: string,
  valueText: string,
  typeAliases: Record<string, TypeAliasEntry>,
): ShapeResult {
  const probe = parseAgency(`const ${PROBE_VARIABLE}: ${constraintText} = ${valueText}`, {}, false);
  if (!probe.success) {
    return {
      ok: false,
      reason: `value does not parse as an Agency expression of type ${constraintText}`,
    };
  }
  const result = typeCheck(probe.result, {}, makeProbeUnit(typeAliases));
  if (result.errors.length === 0) return { ok: true };
  return {
    ok: false,
    reason: result.errors[0].message.replace(` (assignment to '${PROBE_VARIABLE}')`, ""),
  };
}

/**
 * True when a literal expression contains a string interpolation anywhere —
 * at top level or nested inside object/array literals. Typed replacement
 * values must be self-contained: the mutator cannot know what identifiers
 * exist at the target's declaration site, and the probe's undefined-variable
 * pass does not descend into interpolation segments. Structural traversal
 * only — no type semantics.
 */
export function hasInterpolation(expr: Expression): boolean {
  switch (expr.type) {
    case "string":
    case "multiLineString":
      return expr.segments.some((segment) => segment.type !== "text");
    case "agencyArray":
      return expr.items.some((item) =>
        item.type === "splat" ? hasInterpolation(item.value) : hasInterpolation(item),
      );
    case "agencyObject":
      return expr.entries.some((entry) => {
        if ("type" in entry && entry.type === "splat") return hasInterpolation(entry.value);
        const kv = entry as { value: Expression };
        return hasInterpolation(kv.value);
      });
    default:
      return false;
  }
}

/**
 * Render an annotation back to parseable source text for probing and for the
 * mutator prompt. The baseline self-test in discovery validates the
 * round-trip: a rendered type that does not re-parse, or does not accept the
 * target's own original value, leaves the target unconstrained.
 */
export function renderConstraintText(typeHint: VariableType): string {
  return formatTypeHint(typeHint);
}

/**
 * One-line description of a target's allowed values for the mutator prompt.
 * `constraintText === null` means freeform for text targets and
 * unconstrained for literal targets — see the valueKind-first invariant in
 * `OptimizeTarget`.
 */
export function describeConstraint(target: {
  constraintText: string | null;
  valueKind: string;
}): string {
  if (target.constraintText !== null) return target.constraintText;
  if (target.valueKind === "literal") return "any literal value";
  return "free text (any string; keep every ${...} placeholder)";
}
