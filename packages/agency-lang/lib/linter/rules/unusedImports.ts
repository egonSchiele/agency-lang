import type { SourceLocation } from "../../types/base.js";
import type { AgencyProgram } from "../../types.js";
import type {
  ImportStatement,
  ImportNodeStatement,
  NamedImport,
} from "../../types/importStatement.js";
import { getImportedNames } from "../../types/importStatement.js";
import { AgencyGenerator } from "../../backends/agencyGenerator.js";
import type { LintContext, LintEdit, LintFinding, LintFix, LintRule } from "../types.js";
import { lintDiagnostic } from "../diagnostics.js";

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
 *  This is a generic structural walk, NOT walkNodes: walkNodes visits
 *  statement-level AgencyNodes and does not descend into type hints or tag
 *  arguments, which are exactly the positions that would cause a false
 *  "unused" (and a deleted needed import) if missed. Import statements are
 *  excluded so an import does not count as its own use. */
export function collectReferencedNames(program: AgencyProgram): Record<string, true> {
  // Null prototype: identifiers are user-controlled, and on a plain object a
  // key like "__proto__" or "constructor" would hit the prototype chain.
  const used: Record<string, true> = Object.create(null);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (value && typeof value === "object") {
      const node = value as Record<string, unknown>;
      if (typeof node.functionName === "string") {
        used[node.functionName] = true;
      }
      if (typeof node.aliasName === "string") {
        used[node.aliasName] = true;
      }
      if (typeof node.handlerName === "string") {
        used[node.handlerName] = true;
      }
      if (node.type === "variableName" && typeof node.value === "string") {
        used[node.value] = true;
      }
      if (node.type === "genericType" && typeof node.name === "string") {
        used[node.name] = true;
      }
      for (const key of Object.keys(node)) {
        visit(node[key]);
      }
    }
  };
  for (const node of program.nodes) {
    if (node.type === "importStatement" || node.type === "importNodeStatement") {
      continue;
    }
    visit(node);
  }
  return used;
}

/** 0-indexed line/col plus offsets, matching the codebase's SourceLocation. */
export function locFromOffsets(source: string, start: number, end: number): SourceLocation {
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < start; i++) {
    if (source[i] === "\n") {
      line++;
      lastNewline = i;
    }
  }
  return { line, col: start - lastNewline - 1, start, end };
}

const escapeForRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The local name's character range within a statement's source span, matched
 *  on word boundaries so `b` never matches inside `ab` or inside the module
 *  path. Falls back to the whole statement span if the token is somehow not
 *  found (dimming the whole statement is honest; pointing at the wrong
 *  character is not). */
function nameRange(
  source: string,
  stmtStart: number,
  stmtEnd: number,
  localName: string,
): SourceLocation {
  const span = source.slice(stmtStart, stmtEnd);
  const match = new RegExp(
    `(?<![A-Za-z0-9_])${escapeForRegex(localName)}(?![A-Za-z0-9_])`,
  ).exec(span);
  if (!match) {
    return locFromOffsets(source, stmtStart, stmtEnd);
  }
  const start = stmtStart + match.index;
  return locFromOffsets(source, start, start + localName.length);
}

/** The statement's span with trailing whitespace trimmed off: the parser's
 *  span includes the optional trailing newline it consumed, which is not part
 *  of the statement text we match names in or replace on regeneration. */
function statementSpan(
  source: string,
  stmt: ImportStatement | ImportNodeStatement,
): { start: number; end: number } {
  const loc = stmt.loc ?? { line: 0, col: 0, start: 0, end: 0 };
  let end = loc.end;
  while (end > loc.start && /\s/.test(source[end - 1])) {
    end--;
  }
  return { start: loc.start, end };
}

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
  const importedNames = nameType.importedNames.filter((n) => !originals.includes(n));
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
function removalEdit(
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
): LintFinding {
  const span = statementSpan(ctx.source, stmt);
  const range = nameRange(ctx.source, span.start, span.end, localName);
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
  const used = collectReferencedNames(ctx.program);
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
    return unusedByStatement(ctx).flatMap(({ stmt, unusedNames }) =>
      unusedNames.map((localName) => findingFor(ctx, stmt, localName)),
    );
  },
};
