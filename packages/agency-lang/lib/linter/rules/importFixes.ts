import type {
  ImportStatement,
  ImportNodeStatement,
  NamedImport,
} from "../../types/importStatement.js";
import { AgencyGenerator } from "../../backends/agencyGenerator.js";
import type { LintEdit } from "../types.js";
import { statementSpan } from "./util.js";

/** Print a single import statement back to Agency source. `preserveOrder` is
 *  required: without it the generator buffers imports and returns "". */
function printImport(node: ImportStatement | ImportNodeStatement): string {
  return new AgencyGenerator({ preserveOrder: true }).processNode(node).trim();
}

/** A copy of a NamedImport with the given local names removed (dropping their
 *  aliases and retry-safety markers). Returns null if that empties the group. */
function namedImportWithout(nameType: NamedImport, localNames: string[]): NamedImport | null {
  // Map each local name back to its original imported name (alias-aware).
  const originals = localNames.map(
    (localName) =>
      Object.keys(nameType.aliases).find((o) => nameType.aliases[o] === localName) ??
      localName,
  );
  // Hole entries (template import specifiers) are never reported unused.
  const importedNames = nameType.importedNames.filter(
    (n) => typeof n !== "string" || !originals.includes(n),
  );
  if (importedNames.length === 0) {
    return null;
  }
  const aliases = { ...nameType.aliases };
  for (const original of originals) {
    delete aliases[original];
  }
  const next: NamedImport = { type: "namedImport", importedNames, aliases };
  const destructive = nameType.destructiveNames?.filter((n) => !originals.includes(n));
  const idempotent = nameType.idempotentNames?.filter((n) => !originals.includes(n));
  if (destructive && destructive.length > 0) {
    next.destructiveNames = destructive;
  }
  if (idempotent && idempotent.length > 0) {
    next.idempotentNames = idempotent;
  }
  return next;
}

/** A copy of the statement with the local names removed, or null if the whole
 *  statement should be deleted. */
function rebuildWithout(
  stmt: ImportStatement | ImportNodeStatement,
  localNames: string[],
): ImportStatement | ImportNodeStatement | null {
  if (stmt.type === "importNodeStatement") {
    const importedNodes = stmt.importedNodes.filter((n) => !localNames.includes(n));
    if (importedNodes.length === 0) {
      return null;
    }
    return { ...stmt, importedNodes };
  }
  const importedNames = stmt.importedNames
    .map((nameType) =>
      nameType.type === "namedImport" ? namedImportWithout(nameType, localNames) : nameType,
    )
    .filter((nameType): nameType is NonNullable<typeof nameType> => nameType !== null);
  if (importedNames.length === 0) {
    return null;
  }
  return { ...stmt, importedNames };
}

/** The single edit that removes `localNames` from `stmt`: either the statement
 *  regenerated without them, or (when nothing survives) a deletion of the
 *  whole statement including its trailing newline, so no blank line is left
 *  behind. The parser's span already includes the trailing newline it
 *  consumed; the regeneration path replaces only the trimmed statement text. */
export function removalEdit(
  source: string,
  stmt: ImportStatement | ImportNodeStatement,
  localNames: string[],
): LintEdit {
  const loc = stmt.loc ?? { line: 0, col: 0, start: 0, end: 0 };
  const span = statementSpan(source, stmt);
  const rebuilt = rebuildWithout(stmt, localNames);
  if (rebuilt === null) {
    // The parser's span usually already consumed the statement's trailing
    // newline. Only extend past one when it did not (statement at EOF or
    // followed by `;`); extending unconditionally would eat the NEXT line's
    // newline and collapse an intentional blank line between imports.
    const spanEndsWithNewline = source[loc.end - 1] === "\n";
    const end =
      !spanEndsWithNewline && source[loc.end] === "\n" ? loc.end + 1 : loc.end;
    return { start: loc.start, end, newText: "" };
  }
  return { start: span.start, end: span.end, newText: printImport(rebuilt) };
}
