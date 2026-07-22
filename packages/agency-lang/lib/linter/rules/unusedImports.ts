import type { SourceLocation } from "../../types/base.js";
import type { AgencyProgram } from "../../types.js";
import type {
  ImportStatement,
  ImportNodeStatement,
} from "../../types/importStatement.js";
import { getImportedNames } from "../../types/importStatement.js";
import type { LintContext, LintFinding, LintRule } from "../types.js";
import { lintDiagnostic } from "../diagnostics.js";

/** Names referenced anywhere in the file body. Conservative: an imported name
 *  found here is treated as used, so the rule never removes a used import.
 *  The reference positions and their node shapes (verified via pnpm run ast):
 *    - value reference / access-chain base → `variableName` (.value)
 *    - direct call                         → `functionCall` (.functionName)
 *    - bare type annotation                → `typeAliasVariable` (.aliasName)
 *    - parameterized type                  → `genericType` (.name)
 *  This is a generic structural walk, NOT walkNodes: walkNodes visits
 *  statement-level AgencyNodes and does not descend into type hints or tag
 *  arguments, which are exactly the positions that would cause a false
 *  "unused" (and a deleted needed import) if missed. Import statements are
 *  excluded so an import does not count as its own use. */
export function collectReferencedNames(program: AgencyProgram): Record<string, true> {
  const used: Record<string, true> = {};
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (value && typeof value === "object") {
      const node = value as Record<string, unknown>;
      if (node.type === "variableName" && typeof node.value === "string") {
        used[node.value] = true;
      } else if (node.type === "functionCall" && typeof node.functionName === "string") {
        used[node.functionName] = true;
      } else if (node.type === "typeAliasVariable" && typeof node.aliasName === "string") {
        used[node.aliasName] = true;
      } else if (node.type === "genericType" && typeof node.name === "string") {
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

function findingFor(
  ctx: LintContext,
  stmt: ImportStatement | ImportNodeStatement,
  localName: string,
): LintFinding {
  const span = statementSpan(ctx.source, stmt);
  const range = nameRange(ctx.source, span.start, span.end, localName);
  return lintDiagnostic("unusedImport", { name: localName }, range);
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
