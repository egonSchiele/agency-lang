import type { SourceLocation } from "../../types/base.js";

/** Visit every object in an AST subtree (descending arrays and object
 *  values alike). The linter's ONE bespoke descent — it exists because
 *  walkNodes does not reach type hints or tag arguments, which are
 *  positions rules must see. Collectors (collectReferencedNames,
 *  usedNamesIn, reassignedNames) are callbacks over this shared HOW,
 *  each stating only WHAT it collects. */
export function walkValues(
  root: unknown,
  visit: (node: Record<string, unknown>) => void,
): void {
  if (Array.isArray(root)) {
    for (const item of root) {
      walkValues(item, visit);
    }
    return;
  }
  if (root && typeof root === "object") {
    const node = root as Record<string, unknown>;
    visit(node);
    for (const key of Object.keys(node)) {
      walkValues(node[key], visit);
    }
  }
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
export function nameRange(
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
export function statementSpan(
  source: string,
  node: { loc?: SourceLocation },
): { start: number; end: number } {
  const loc = node.loc ?? { line: 0, col: 0, start: 0, end: 0 };
  let end = loc.end;
  while (end > loc.start && /\s/.test(source[end - 1])) {
    end--;
  }
  return { start: loc.start, end };
}
