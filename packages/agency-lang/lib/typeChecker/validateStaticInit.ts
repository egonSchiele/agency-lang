/**
 * Compile-time validation driver for `static` declarations and
 * `static <bare>` top-level statements (Phase A surface).
 *
 * Two responsibilities, both keyed off the module's top-level node
 * list (single pass):
 *
 *   1. Collect every static binding name so the mutation-detection
 *      rule has something to match against (`staticName = ...` and
 *      `staticName.push(...)`).
 *   2. For each static decl or `static <bare>`, run
 *      {@link checkBannedBuiltinCalls} over the inner expression /
 *      statement; for everything else at module top level, run
 *      {@link checkStaticMutation} against the collected names.
 *
 * Cross-module reads of non-static globals from a static initializer
 * are NOT checked here — that's still the job of
 * `rejectStaticReferencesGlobal` in `lib/compiler/initDepGraph.ts`,
 * which already runs at the closure level (it can see *all* modules'
 * statics + globals at once, and reuses PR 2.5's depth-1 expansion).
 * Splitting per-module direct rules from cross-module dep-graph
 * rules keeps each pass focused on the data it actually has.
 */
import type { AgencyProgram, AgencyNode, Assignment } from "../types.js";
import type { TypeCheckError } from "./types.js";
import {
  checkBannedBuiltinCalls,
  checkStaticMutation,
} from "./staticInitRules.js";

export function validateStaticInit(
  program: AgencyProgram,
  errors: TypeCheckError[],
): void {
  // First sweep: collect static names so the mutation rule has
  // something to match against. Both `static const` and `with handler
  // { static const ... }` shapes count; the `withModifier` wrapper
  // here mirrors how `sectionAssembler` / `initDepGraph` peel it off.
  const staticNames: Record<string, true> = {};
  for (const node of program.nodes) {
    const inner =
      node.type === "withModifier" ? node.statement : node;
    if (inner.type !== "assignment") continue;
    if ((inner as Assignment).static) {
      staticNames[(inner as Assignment).variableName] = true;
    }
  }

  // Second sweep: validate static initializers + bare statements,
  // and flag obvious mutations against known statics elsewhere at
  // top level.
  for (const node of program.nodes) {
    const inner =
      node.type === "withModifier" ? node.statement : node;

    // `static const x = ...` — validate the initializer expression.
    if (inner.type === "assignment" && (inner as Assignment).static) {
      const a = inner as Assignment;
      const label = `Static const \`${a.variableName}\``;
      errors.push(
        ...checkBannedBuiltinCalls(a.value as AgencyNode, label, a.variableName),
      );
      continue;
    }

    // `static <bare>` — validate the wrapped statement.
    if (inner.type === "staticStatement") {
      errors.push(
        ...checkBannedBuiltinCalls(
          inner.statement,
          "Static bare statement",
        ),
      );
      continue;
    }

    // Anything else at top level — could be a mutation of a known
    // static. checkStaticMutation returns null when it isn't.
    const mutationErr = checkStaticMutation(inner, staticNames);
    if (mutationErr) errors.push(mutationErr);
  }
}
