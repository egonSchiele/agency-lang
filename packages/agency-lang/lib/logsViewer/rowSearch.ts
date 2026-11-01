// Searching one trace for the rows whose own text matches. A row's own text
// is decided by the transcript, which shows each message once, on the block
// where it first appeared; search filters those blocks and names each hit by
// its story row, through the same `blockRowId` the transcript screen uses.
// So a word in the first user message matches the user row once, not every
// later LLM call that carried it again as history.
import { headerLine } from "./rowText.js";
import { blockRowId, transcriptOf, transcriptText, type TranscriptBlock } from "./transcript.js";
import type { TreeNode } from "./types.js";

export type SearchKind = "user" | "call" | "tool" | "hosted" | "error";

/** The search kind each searched block kind reports. A kind not listed is
 *  not searched: thread dividers, turns, pauses, and rewrite headings. */
export const SEARCHED_BLOCKS: Partial<Record<TranscriptBlock["kind"], SearchKind>> = {
  system: "call",
  assistant: "call",
  history: "user",
  user: "user",
  handback: "user",
  tool: "tool",
  hosted: "hosted",
  error: "error",
};

export const SEARCH_KINDS: SearchKind[] = ["user", "call", "tool", "hosted", "error"];

export type Found = { count: number; first: number; length: number };
export type Matcher = { test(text: string): Found | undefined };

/** A matcher for a plain pattern or, with `regex`, a JavaScript regular
 *  expression. Case is ignored unless `caseSensitive`. A match of no
 *  characters does not count. */
export function matcherFor(
  pattern: string,
  options: { regex: boolean; caseSensitive: boolean },
): Matcher | { error: string } {
  if (pattern === "") {
    return { error: "the pattern is empty" };
  }
  const source = options.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let expression: RegExp;
  try {
    expression = new RegExp(source, options.caseSensitive ? "g" : "gi");
  } catch (error) {
    return { error: (error as Error).message };
  }
  return {
    test: (text) => {
      const matches = [...text.matchAll(expression)].filter((match) => match[0].length > 0);
      if (matches.length === 0) {
        return undefined;
      }
      return { count: matches.length, first: matches[0].index, length: matches[0][0].length };
    },
  };
}

export type RowHit = {
  rowId: string;
  kind: SearchKind;
  header: string;
  matches: number;
  snippet: string;
};

/** The story rows whose own text matches, in transcript order. Blocks that
 *  name the same row (a system prompt and its call) are one hit, with
 *  their matches added and the first block's snippet. */
export function searchTrace(
  trace: TreeNode,
  matcher: Matcher,
  options: { context: number; kinds: SearchKind[] | undefined },
): RowHit[] {
  const { blocks, story } = transcriptOf(trace);
  const hits: RowHit[] = [];
  for (const block of blocks) {
    const kind = SEARCHED_BLOCKS[block.kind];
    if (kind === undefined || (options.kinds !== undefined && !options.kinds.includes(kind))) {
      continue;
    }
    const text = transcriptText(block);
    const found = matcher.test(text);
    const rowId = found === undefined ? undefined : blockRowId(block, story);
    if (found === undefined || rowId === undefined) {
      continue;
    }
    const earlier = hits.find((hit) => hit.rowId === rowId);
    if (earlier !== undefined) {
      earlier.matches += found.count;
      continue;
    }
    const row = story.find((candidate) => candidate.id === rowId);
    hits.push({
      rowId,
      kind,
      header: row === undefined ? block.kind : headerLine(row, trace),
      matches: found.count,
      snippet: snippetAround(text, found.first, found.length, options.context),
    });
  }
  return hits;
}

/** One line: `context` characters each side of the match, runs of
 *  whitespace collapsed, and an ellipsis where text was cut. A match longer
 *  than twice the context is cut too, so a greedy regex cannot print a
 *  whole tool result. */
export function snippetAround(text: string, at: number, length: number, context: number): string {
  const start = Math.max(0, at - context);
  const shownLength = Math.min(length, context * 2);
  const end = Math.min(text.length, at + length + context);
  const inner = [
    text.slice(start, at),
    text.slice(at, at + shownLength),
    shownLength < length ? "…" : "",
    text.slice(at + length, end),
  ]
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return `${start > 0 ? "…" : ""}${inner}${end < text.length ? "…" : ""}`;
}
