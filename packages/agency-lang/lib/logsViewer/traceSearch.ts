// traceSearch.ts
// Searching the text of every trace, for the trace picker. A trace's text
// is every string in its events. Built once per parse; a query is then one
// pass over a few strings.
import { walkNodes } from "./forest.js";
import type { TraceSummary } from "./traceSummaries.js";
import type { TreeNode } from "./types.js";

export type TraceText = { traceId: string; text: string; lowered: string };
export type TraceHit = { traceId: string; count: number; snippet: string };
export type TraceFilter = {
  id: string;
  label: string;
  accepts: (summary: TraceSummary) => boolean;
};

/** Characters of context shown on each side of the first hit. */
const SNIPPET_RADIUS = 40;
const ELLIPSIS = "…";

export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsIn);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}

export function traceTexts(roots: TreeNode[]): TraceText[] {
  return roots.map((root) => {
    const events = walkNodes(root).flatMap((node) =>
      node.event === undefined ? [] : [node.event],
    );
    const text = events.flatMap((event) => stringsIn(event.data)).join("\n");
    return { traceId: root.traceId, text, lowered: text.toLowerCase() };
  });
}

export function searchTraces(texts: TraceText[], query: string): TraceHit[] {
  const needle = query.toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  return texts.map((traceText) => hitIn(traceText, needle)).filter((hit) => hit.count > 0);
}

export function textFilter(query: string, hits: TraceHit[]): TraceFilter {
  const hitIds = hits.map((hit) => hit.traceId);
  return {
    id: "text",
    label: `"${query}"`,
    accepts: (summary) => hitIds.includes(summary.traceId),
  };
}

export function applyFilters(summaries: TraceSummary[], filters: TraceFilter[]): TraceSummary[] {
  return summaries.filter((summary) => filters.every((filter) => filter.accepts(summary)));
}

function hitIn(traceText: TraceText, needle: string): TraceHit {
  // Unicode lowercase expansion can shift the display snippet slightly.
  const count = traceText.lowered.split(needle).length - 1;
  const firstAt = traceText.lowered.indexOf(needle);
  const snippet = firstAt === -1 ? "" : snippetAround(traceText.text, firstAt, needle.length);
  return { traceId: traceText.traceId, count, snippet };
}

function snippetAround(text: string, at: number, length: number): string {
  const from = Math.max(0, at - SNIPPET_RADIUS);
  const to = Math.min(text.length, at + length + SNIPPET_RADIUS);
  const body = text.slice(from, to).replace(/\s+/g, " ");
  const head = from > 0 ? ELLIPSIS : "";
  const tail = to < text.length ? ELLIPSIS : "";
  return `${head}${body}${tail}`;
}
