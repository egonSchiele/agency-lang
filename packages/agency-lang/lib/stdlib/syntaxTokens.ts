// Highlighted code and diffs as data, for a program that draws them itself:
// a GUI, a web page, anything that is not a terminal. `syntax.ts` turns the
// same highlight.js output into ANSI text; these functions return the tokens
// instead, so the caller picks the colors.
import hljs from "highlight.js";
import { computeHunks, wordChanges } from "@/utils/diff.js";
import type { DiffLine, Hunk, TextRange } from "@/utils/diff.js";

/**
 * One piece of code. `scope` is the kind of syntax it is, named like the
 * fields of `ColorScheme` ("keyword", "string", "builtIn"), or null for
 * plain text.
 */
export type CodeToken = { text: string; scope: string | null };

/** A piece of one line of a diff. `changed` marks a word that differs from the line it replaced. */
export type DiffToken = CodeToken & { changed: boolean };

export type DiffTokenLine = {
  kind: DiffLine["kind"];
  oldNumber: number | null;
  newNumber: number | null;
  tokens: DiffToken[];
};

export type DiffTokenHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffTokenLine[];
};

/** A node of highlight.js's token tree: plain text, or a kind wrapping more nodes. */
type TokenNode = string | { kind?: string; sublanguage?: boolean; children: TokenNode[] };

const AUTO = "auto";
const LINE_BREAK = "\n";

/** The highlight.js language for a name. Agency code reads as TypeScript. */
export function hljsLanguage(language: string): string {
  return language === "agency" ? "ts" : language;
}

/**
 * Guess a language name for `code`. Detection is heuristic and can be wrong
 * on short or ambiguous snippets.
 */
export function detectLanguage(code: string): string {
  return hljs.highlightAuto(code).language ?? "plaintext";
}

/** Split code into tokens tagged with their kind of syntax. */
export function _highlightTokens(code: string, language: string): CodeToken[] {
  if (code === "") {
    return [];
  }
  const tree = tokenTree(code, hljsLanguage(language));
  if (tree === null) {
    return [{ text: code, scope: null }];
  }
  return joinNeighbors(flatten(tree, null));
}

/**
 * highlight.js's token tree for `code`, or null for a language it does not
 * know: unknown names are common ("text", "console") and simply mean plain text.
 */
function tokenTree(code: string, language: string): TokenNode | null {
  if (language !== AUTO && !hljs.getLanguage(language)) {
    return null;
  }
  const result =
    language === AUTO
      ? hljs.highlightAuto(code)
      : hljs.highlight(code, { language, ignoreIllegals: true });
  return rootOf(result.emitter);
}

/** The emitter's tree. highlight.js builds it but its types do not describe it. */
function rootOf(emitter: unknown): TokenNode | null {
  if (typeof emitter !== "object" || emitter === null || !("rootNode" in emitter)) {
    return null;
  }
  const root = emitter.rootNode;
  return isTokenNode(root) ? root : null;
}

function isTokenNode(value: unknown): value is TokenNode {
  if (typeof value === "string") {
    return true;
  }
  return typeof value === "object" && value !== null && "children" in value;
}

/**
 * The tree's text in order, each piece with its innermost kind. A
 * sublanguage (CSS inside HTML) is not a kind of its own: its pieces keep
 * their own kinds.
 */
function flatten(node: TokenNode, scope: string | null): CodeToken[] {
  if (typeof node === "string") {
    return node === "" ? [] : [{ text: node, scope }];
  }
  const own = node.kind && !node.sublanguage ? scopeName(node.kind) : scope;
  return node.children.flatMap((child) => flatten(child, own));
}

/** highlight.js's class name as a ColorScheme field name: "built_in" -> "builtIn". */
function scopeName(hljsClass: string): string {
  return hljsClass.replace(/[-_](\w)/g, (_match, letter: string) => letter.toUpperCase());
}

/** Neighboring tokens with the same kind (and change mark) become one. */
function joinNeighbors<Token extends CodeToken>(
  tokens: Token[],
  same: (left: Token, right: Token) => boolean = (left, right) => left.scope === right.scope,
): Token[] {
  const joined: Token[] = [];
  for (const token of tokens) {
    const last = joined[joined.length - 1];
    if (last && same(last, token)) {
      joined[joined.length - 1] = { ...last, text: last.text + token.text };
    } else {
      joined.push(token);
    }
  }
  return joined;
}

// MARK: Diffs

/**
 * A diff as hunks of tokenized lines. Each side is highlighted as a whole
 * text and then split into lines, so a comment over several lines stays a
 * comment on every line. A deleted line paired with the line that replaced
 * it has its changed words marked.
 */
export function _diffTokens(
  oldText: string,
  newText: string,
  context: number,
  ignoreWhitespace: boolean,
  language: string,
): DiffTokenHunk[] {
  const hunks = computeHunks(oldText, newText, context, ignoreWhitespace);
  const lineLanguage =
    language === AUTO ? detectLanguage(oldText + LINE_BREAK + newText) : language;
  const sides = {
    old: tokenLines(oldText, lineLanguage),
    new: tokenLines(newText, lineLanguage),
  };
  return hunks.map((hunk) => tokenizeHunk(hunk, sides));
}

type Sides = { old: CodeToken[][]; new: CodeToken[][] };

/** A text's tokens, one list per line, line breaks removed. No language means plain text. */
function tokenLines(text: string, language: string): CodeToken[][] {
  const tokens = language === "" ? [{ text, scope: null }] : _highlightTokens(text, language);
  const lines: CodeToken[][] = [[]];
  for (const token of tokens) {
    token.text.split(LINE_BREAK).forEach((piece, position) => {
      if (position > 0) {
        lines.push([]);
      }
      if (piece !== "") {
        lines[lines.length - 1].push({ text: piece, scope: token.scope });
      }
    });
  }
  return lines;
}

function tokenizeHunk(hunk: Hunk, sides: Sides): DiffTokenHunk {
  const changes = changedRanges(hunk.lines);
  return {
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines.map((line, position) => ({
      kind: line.kind,
      oldNumber: line.oldNum,
      newNumber: line.newNum,
      tokens: markChanged(tokensOf(line, sides), changes[position] ?? []),
    })),
  };
}

/** A deleted line's tokens come from the old text; every other line's from the new. */
function tokensOf(line: DiffLine, sides: Sides): CodeToken[] {
  if (line.kind === "delete") {
    return line.oldNum === null ? [] : (sides.old[line.oldNum - 1] ?? []);
  }
  return line.newNum === null ? [] : (sides.new[line.newNum - 1] ?? []);
}

/**
 * The changed words of each line, by position in `lines`. A run of deleted
 * lines followed by inserted lines pairs them in order, as the terminal diff
 * does; a line with no partner has no changed words.
 */
function changedRanges(lines: DiffLine[]): Record<number, TextRange[]> {
  const ranges: Record<number, TextRange[]> = {};
  let position = 0;
  while (position < lines.length) {
    if (lines[position].kind !== "delete") {
      position++;
      continue;
    }
    const insertsStart = endOfRun(lines, position, "delete");
    const insertsEnd = endOfRun(lines, insertsStart, "insert");
    const pairs = Math.min(insertsStart - position, insertsEnd - insertsStart);
    for (let offset = 0; offset < pairs; offset++) {
      const removed = position + offset;
      const added = insertsStart + offset;
      const words = wordChanges(lines[removed].text, lines[added].text);
      ranges[removed] = words.deleted;
      ranges[added] = words.inserted;
    }
    position = Math.max(insertsEnd, position + 1);
  }
  return ranges;
}

/** The position after a run of lines of one kind that starts at `start`. */
function endOfRun(lines: DiffLine[], start: number, kind: DiffLine["kind"]): number {
  let end = start;
  while (end < lines.length && lines[end].kind === kind) {
    end++;
  }
  return end;
}

/** Splits tokens where a changed range starts or ends, and marks the pieces inside one. */
function markChanged(tokens: CodeToken[], ranges: TextRange[]): DiffToken[] {
  const marked: DiffToken[] = [];
  let offset = 0;
  for (const token of tokens) {
    const end = offset + token.text.length;
    for (const piece of piecesOf(offset, end, ranges)) {
      marked.push({
        text: token.text.slice(piece.start - offset, piece.end - offset),
        scope: token.scope,
        changed: ranges.some((range) => range.start <= piece.start && piece.start < range.end),
      });
    }
    offset = end;
  }
  return joinNeighbors(
    marked,
    (left, right) => left.scope === right.scope && left.changed === right.changed,
  );
}

/** The stretch from `start` to `end`, cut wherever a range begins or ends inside it. */
function piecesOf(start: number, end: number, ranges: TextRange[]): TextRange[] {
  const cuts = ranges
    .flatMap((range) => [range.start, range.end])
    .filter((cut) => cut > start && cut < end);
  const points = [start, ...cuts.sort((left, right) => left - right), end].filter(
    (point, position, all) => position === 0 || point !== all[position - 1],
  );
  return points.slice(1).map((point, position) => ({ start: points[position], end: point }));
}
