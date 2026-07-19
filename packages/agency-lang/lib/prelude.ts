/**
 * The prelude: names every Agency file gets without importing them.
 *
 * This array is the only definition of that list. Two places render it:
 *
 *  - `parseAgency` wraps user source in the parser template
 *    (lib/templates/backends/agency/template.mustache), which turns these
 *    names into a real `import { … } from "std::index"` line.
 *  - The LSP can't use that template — wrapping the source would shift
 *    every line and land the editor's squiggles on the wrong row — so
 *    `runDiagnostics` synthesizes an equivalent import statement instead
 *    (lib/lsp/diagnostics.ts).
 *
 * Both read this array, so the compiler and the editor cannot disagree
 * about what is in scope. They used to keep separate hand-copied lists,
 * which drifted: `_guard`, `saveDraft`, and `flatten` reached the template
 * but not the LSP, so any file using the `guard` construct showed a
 * phantom "Function '_guard' is not defined" in the editor that
 * `agency typecheck` never reported.
 *
 * Every name here must be exported by stdlib/index.agency, and the rendered
 * import must stay on one line. prelude.test.ts enforces both and explains
 * why each matters.
 */
export const PRELUDE_NAMES: readonly string[] = [
  "print",
  "printJSON",
  "input",
  "sleep",
  "saveDraft",
  "_guard",
  "_pairsOf",
  "read",
  "write",
  "writeBinary",
  "readBinary",
  "range",
  "callback",
  // Array helpers (moved from std::array into std::index).
  "map",
  "filter",
  "exclude",
  "find",
  "findIndex",
  "reduce",
  "flatMap",
  "every",
  "some",
  "count",
  "sortBy",
  "unique",
  "groupBy",
  "flatten",
];

/** The prelude as a single-line `import { … } from "std::index"` statement. */
export function preludeImportLine(): string {
  return `import { ${PRELUDE_NAMES.join(", ")} } from "std::index";`;
}
