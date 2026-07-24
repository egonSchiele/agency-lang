import type { AgencyNode } from "../../types.js";
import type {
  ImportStatement,
  ImportNodeStatement,
} from "../../types/importStatement.js";
import { getImportedNames } from "../../types/importStatement.js";
import type { LintContext, LintEdit, LintFinding, LintFix, LintRule } from "../types.js";
import { lintDiagnostic } from "../diagnostics.js";
import { buildLineIndex, nameRange, statementSpan, walkValues } from "./util.js";
import type { LineIndex } from "./util.js";
import { removalEdit } from "./importFixes.js";

/** Names referenced anywhere in the file body. Conservative: an imported name
 *  found here is treated as used, so the rule never removes a used import.
 *
 *  Collection is conservative BY CONSTRUCTION, not by enumerating node types:
 *  any object carrying a name-bearing field (`functionName`, `aliasName`,
 *  `handlerName`) contributes that name, regardless of its `type`/`kind`
 *  discriminant. Over-collection only makes the rule keep an import (safe,
 *  possibly a missed detection); an allow-list of discriminants risks
 *  under-collection, which deletes a used import — a `handle { } with fn`
 *  handler reference is `{ kind: "functionRef", functionName }` with no
 *  `type` field at all, and removing a handler's import silently unregisters
 *  the handler (CLAUDE.md-critical). Two fields stay discriminated because
 *  their names are too generic to collect blindly: `value` (string literals
 *  also have one) and `name` (parameters also have one).
 *
 *  Import statements are excluded so an import does not count as its own
 *  use. The descent itself is walkValues (util.ts) — see its comment for
 *  why the linter has a bespoke walk at all. */
export function collectReferencedNames(nodes: AgencyNode[]): Record<string, true> {
  // Null prototype: identifiers are user-controlled, and on a plain object a
  // key like "__proto__" or "constructor" would hit the prototype chain.
  const used: Record<string, true> = Object.create(null);
  for (const node of nodes) {
    if (node.type === "importStatement" || node.type === "importNodeStatement") {
      continue;
    }
    walkValues(node, (n) => {
      if (typeof n.functionName === "string") {
        used[n.functionName] = true;
      }
      if (typeof n.aliasName === "string") {
        used[n.aliasName] = true;
      }
      if (typeof n.handlerName === "string") {
        used[n.handlerName] = true;
      }
      if (n.type === "variableName" && typeof n.value === "string") {
        used[n.value] = true;
      }
      if (n.type === "genericType" && typeof n.name === "string") {
        used[n.name] = true;
      }
    });
  }
  return used;
}

/** One edit per statement, each regenerated with ALL of its unused names
 *  removed. Used by "Remove all unused imports" and remove-on-save. Never
 *  produces overlapping edits, because a statement appears at most once. */
export function unusedImportsBatchEdits(ctx: LintContext): LintEdit[] {
  return unusedByStatement(ctx).map(({ stmt, unusedNames }) =>
    removalEdit(ctx.source, stmt, unusedNames),
  );
}

function findingFor(
  ctx: LintContext,
  stmt: ImportStatement | ImportNodeStatement,
  localName: string,
  lineIndex: LineIndex,
): LintFinding {
  const span = statementSpan(ctx.source, stmt);
  const range = nameRange(ctx.source, span.start, span.end, localName, lineIndex);
  const fix: LintFix = {
    title: `Remove unused import '${localName}'`,
    edits: [removalEdit(ctx.source, stmt, [localName])],
  };
  return lintDiagnostic("unusedImport", { name: localName }, range, fix);
}

/** Each lintable statement paired with its unused local names. Shared by the
 *  per-name findings (below) and the grouped batch fix. */
function unusedByStatement(
  ctx: LintContext,
): { stmt: ImportStatement | ImportNodeStatement; unusedNames: string[] }[] {
  const used = collectReferencedNames(ctx.program.nodes);
  const groups: { stmt: ImportStatement | ImportNodeStatement; unusedNames: string[] }[] = [];
  for (const node of ctx.program.nodes) {
    if (node.type === "importStatement") {
      if (node.modulePath === "std::index") {
        continue; // injected prelude
      }
      if (node.testOnly) {
        continue; // test-only wiring
      }
      const unusedNames = node.importedNames
        .filter((nameType) => nameType.type === "namedImport") // namespace/default deferred
        .flatMap((nameType) => getImportedNames(nameType))
        .filter((localName) => !used[localName]);
      if (unusedNames.length > 0) {
        groups.push({ stmt: node, unusedNames });
      }
    } else if (node.type === "importNodeStatement") {
      const unusedNames = node.importedNodes.filter((localName) => !used[localName]);
      if (unusedNames.length > 0) {
        groups.push({ stmt: node, unusedNames });
      }
    }
  }
  return groups;
}

export const unusedImportsRule: LintRule = {
  name: "unusedImport",
  run(ctx: LintContext): LintFinding[] {
    const lineIndex = buildLineIndex(ctx.source);
    return unusedByStatement(ctx).flatMap(({ stmt, unusedNames }) =>
      unusedNames.map((localName) => findingFor(ctx, stmt, localName, lineIndex)),
    );
  },
};
