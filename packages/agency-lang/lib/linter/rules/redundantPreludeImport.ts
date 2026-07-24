import type { ImportStatement, NamedImport } from "../../types/importStatement.js";
import { PRELUDE_NAMES } from "../../prelude.js";
import type { LintContext, LintFinding, LintFix, LintRule } from "../types.js";
import { lintDiagnostic } from "../diagnostics.js";
import { nameRange, statementSpan } from "./util.js";
import { removalEdit } from "./importFixes.js";

/** A name is redundant only when it is completely plain: provided by the
 *  prelude, not rebound under an alias, and carrying no retry-safety
 *  marker. The membership test is PRELUDE_NAMES, NOT the module path:
 *  std::index also exports names outside the prelude (types like
 *  WriteMode — the mirror test covers functions only), and importing
 *  those is the only way to get them. Plainness is what makes the removal
 *  fix safe. */
function isRedundant(nameType: NamedImport, name: string): boolean {
  return (
    PRELUDE_NAMES.includes(name) &&
    !Object.hasOwn(nameType.aliases, name) &&
    !nameType.destructiveNames?.includes(name) &&
    !nameType.idempotentNames?.includes(name)
  );
}

function redundantNamesIn(ctx: LintContext): { stmt: ImportStatement; name: string }[] {
  return ctx.program.nodes
    .filter(
      (node): node is ImportStatement =>
        node.type === "importStatement" &&
        node.modulePath === "std::index" &&
        !node.testOnly,
    )
    .flatMap((stmt) =>
      stmt.importedNames
        .filter((nameType): nameType is NamedImport => nameType.type === "namedImport")
        .flatMap((nameType) =>
          nameType.importedNames
            .filter((name): name is string => typeof name === "string") // template holes are not names
            .filter((name) => isRedundant(nameType, name))
            .map((name) => ({ stmt, name })),
        ),
    );
}

export const redundantPreludeImportRule: LintRule = {
  name: "redundantPreludeImport",
  run(ctx: LintContext): LintFinding[] {
    return redundantNamesIn(ctx).map(({ stmt, name }) => {
      const span = statementSpan(ctx.source, stmt);
      const range = nameRange(ctx.source, span.start, span.end, name);
      const fix: LintFix = {
        title: `Remove redundant import '${name}'`,
        edits: [removalEdit(ctx.source, stmt, [name])],
      };
      return lintDiagnostic("redundantPreludeImport", { name }, range, fix);
    });
  },
};
