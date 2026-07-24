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

/** Sorted offsets of every "\n" in `source`. Build this ONCE per lint pass
 *  (buildLineIndex) and hand it to locFromOffsets/nameRange so each
 *  offset→line/col lookup is a binary search instead of a rescan from byte 0.
 *  Without it, a rule that emits one finding per declaration turns a
 *  whole-file pass into O(n²): each finding pays O(its own offset), and the
 *  offsets span the file. */
export type LineIndex = number[];

export function buildLineIndex(source: string): LineIndex {
  const newlines: LineIndex = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") {
      newlines.push(i);
    }
  }
  return newlines;
}

/** The 0-indexed line of `offset` (= count of newlines strictly before it) and
 *  the offset of the last newline before it (or -1). Binary search over the
 *  sorted index; matches the linear scan below exactly, including a newline
 *  sitting exactly at `offset` (which belongs to the next line, not this one). */
function lineAt(lineIndex: LineIndex, offset: number): { line: number; lastNewline: number } {
  let lo = 0;
  let hi = lineIndex.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lineIndex[mid] < offset) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return { line: lo, lastNewline: lo > 0 ? lineIndex[lo - 1] : -1 };
}

/** 0-indexed line/col plus offsets, matching the codebase's SourceLocation.
 *  Pass a `lineIndex` (buildLineIndex) to make this O(log n); without one it
 *  falls back to an O(offset) scan — fine for a handful of calls, quadratic
 *  across a finding-per-declaration pass. */
export function locFromOffsets(
  source: string,
  start: number,
  end: number,
  lineIndex?: LineIndex,
): SourceLocation {
  if (lineIndex) {
    const { line, lastNewline } = lineAt(lineIndex, start);
    return { line, col: start - lastNewline - 1, start, end };
  }
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
  lineIndex?: LineIndex,
): SourceLocation {
  const span = source.slice(stmtStart, stmtEnd);
  const match = new RegExp(
    `(?<![A-Za-z0-9_])${escapeForRegex(localName)}(?![A-Za-z0-9_])`,
  ).exec(span);
  if (!match) {
    return locFromOffsets(source, stmtStart, stmtEnd, lineIndex);
  }
  const start = stmtStart + match.index;
  return locFromOffsets(source, start, start + localName.length, lineIndex);
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
