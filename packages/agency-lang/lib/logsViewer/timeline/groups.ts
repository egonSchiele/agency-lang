// Group keys and aggregation. In the kernel — not on a view component —
// because by-name (display) and occurrences (membership) must agree, and
// follow-mode re-parses can legitimately re-group a call (a threadCreated
// can arrive after the llm call it names). One computation, two readers.
import { childEvent, spanDetail, stripQuotes } from "../spanText.js";
import type { TreeNode } from "../types.js";
import type { TimelineSpan } from "./spans.js";

export type SpanGroup = {
  key: string;
  spanIds: string[];
  count: number;
  totalSelfMs: number;
  /** Of the spans' wall-clock envelope. MAY exceed 1.0 for parallel work
   *  (two forked branches busy 10s each in a 10s window = 2.0) — that is
   *  true compute time, distinct from the nesting double-count that
   *  self-time prevents. */
  share: number;
  models: string[];
};

export function groupSpans(spans: TimelineSpan[], root: TreeNode, index?: TreeIndex): SpanGroup[] {
  const treeIndex = index ?? buildTreeIndex(root);
  // Null prototype: keys incorporate statelog content (thread labels,
  // tool names) — "__proto__" must be an ordinary key.
  const byKey: Record<string, SpanGroup> = Object.create(null);
  const labelCache: ScopeLabelCache = Object.create(null);
  for (const s of spans) {
    const node = treeIndex.byId[s.id];
    if (node === undefined) continue;
    const key = keyOf(node, treeIndex, labelCache);
    byKey[key] ??= { key, spanIds: [], count: 0, totalSelfMs: 0, share: 0, models: [] };
    const group = byKey[key];
    group.spanIds.push(s.id);
    group.count += 1;
    group.totalSelfMs += s.selfMs;
    const model = modelOf(node);
    if (model !== undefined && !group.models.includes(model)) {
      group.models.push(model);
    }
  }
  const wallMs = wallClockOf(spans);
  const groups = Object.values(byKey).sort((a, b) => b.totalSelfMs - a.totalSelfMs);
  for (const g of groups) {
    g.share = wallMs > 0 ? g.totalSelfMs / wallMs : 0;
  }
  return groups;
}

/** Single-lookup convenience (occurrences re-resolves its remembered key
 *  through this once per setData). Builds its own tree index; bulk callers
 *  go through groupSpans, which builds it once. */
export function groupKeyOf(spanId: string, root: TreeNode): string {
  const index = buildTreeIndex(root);
  const node = index.byId[spanId];
  if (node === undefined) return "?";
  return keyOf(node, index, Object.create(null));
}

/** How a span is named everywhere a short name is needed: tool name,
 *  `node X`, `llm(model)`, else the span kind. Built ON spanText's
 *  spanDetail so the tree and the timeline can never disagree. */
export function spanDisplayName(node: TreeNode): string {
  if (node.label === "toolExecution") {
    return spanDetail(node) ?? "tool?";
  }
  if (node.label === "nodeExecution") {
    return `node ${stripQuotes(spanDetail(node))}`;
  }
  if (node.label === "llmCall") {
    return `llm(${modelOf(node) ?? "?"})`;
  }
  return node.label;
}

export type TreeIndex = { byId: Record<string, TreeNode>; parentIds: Record<string, string> };

/** One DFS over the tree; reused by the views so per-row lookups are O(1)
 *  instead of a fresh tree walk (span ids come from statelog content, so
 *  both records are null-prototype). */
export function buildTreeIndex(root: TreeNode): TreeIndex {
  const byId: Record<string, TreeNode> = Object.create(null);
  const parentIds: Record<string, string> = Object.create(null);
  const walk = (node: TreeNode) => {
    byId[node.id] = node;
    for (const child of node.children) {
      parentIds[child.id] = node.id;
      walk(child);
    }
  };
  walk(root);
  return { byId, parentIds };
}

/** Per-scope threadId→label maps, built once per process subtree instead
 *  of re-scanning the scope for every llm call (O(k·n) otherwise). */
type ScopeLabelCache = Record<string, Record<string, string>>;

/** llm: thread label → enclosing function → model. Others: display name. */
function keyOf(node: TreeNode, index: TreeIndex, cache: ScopeLabelCache): string {
  if (node.label !== "llmCall") {
    return spanDisplayName(node);
  }
  const label = threadLabelFor(node, index, cache);
  if (label !== undefined) return `llm(${label})`;
  const enclosing = enclosingFunctionName(node, index);
  if (enclosing !== undefined) return `llm(${enclosing})`;
  return `llm(${modelOf(node) ?? "?"})`;
}

/** Thread ids restart in every subprocess (one trace held two
 *  threadCreated events for id "1"), so the lookup scope is the nearest
 *  enclosing subprocessRun span — or the trace root — EXCLUDING nested
 *  subprocessRun subtrees, which are other processes' id spaces. */
function threadLabelFor(
  node: TreeNode,
  index: TreeIndex,
  cache: ScopeLabelCache,
): string | undefined {
  const call = childEvent(node, "promptCompletion") ?? childEvent(node, "promptStart");
  const threadId = call?.data.threadId;
  if (threadId === undefined) return undefined;
  const scope =
    nearestAncestor(node, index, (a) => a.label === "subprocessRun") ?? rootOf(node, index);
  cache[scope.id] ??= scanScopeLabels(scope);
  return cache[scope.id][String(threadId)];
}

/** DFS order means a reused thread id resolves to the LAST threadCreated
 *  in the scope — "the most recent naming wins". Id reuse within one
 *  process is rare enough that positional (before-the-call) resolution
 *  has not been worth the bookkeeping; revisit if a real log disagrees. */
function scanScopeLabels(scope: TreeNode): Record<string, string> {
  const labels: Record<string, string> = Object.create(null);
  const scan = (n: TreeNode) => {
    if (n !== scope && n.nodeKind === "span" && n.label === "subprocessRun") return;
    const d = n.event?.data;
    if (d?.type === "threadCreated" && typeof d.label === "string" && d.label.length > 0) {
      labels[String(d.threadId)] = d.label;
    }
    n.children.forEach(scan);
  };
  scan(scope);
  return labels;
}

function enclosingFunctionName(node: TreeNode, index: TreeIndex): string | undefined {
  const found = nearestAncestor(
    node,
    index,
    (a) => a.label === "toolExecution" || a.label === "nodeExecution",
  );
  if (found === undefined) return undefined;
  return spanDisplayName(found);
}

function nearestAncestor(
  node: TreeNode,
  index: TreeIndex,
  matches: (ancestor: TreeNode) => boolean,
): TreeNode | undefined {
  let currentId = index.parentIds[node.id];
  while (currentId !== undefined) {
    const ancestor = index.byId[currentId];
    if (ancestor === undefined) return undefined;
    if (ancestor.nodeKind === "span" && matches(ancestor)) return ancestor;
    currentId = index.parentIds[currentId];
  }
  return undefined;
}

function rootOf(node: TreeNode, index: TreeIndex): TreeNode {
  let current = node;
  while (index.parentIds[current.id] !== undefined) {
    current = index.byId[index.parentIds[current.id]];
  }
  return current;
}

function modelOf(node: TreeNode): string | undefined {
  if (node.label !== "llmCall") return undefined;
  const e = childEvent(node, "promptCompletion") ?? childEvent(node, "promptStart");
  const model = e?.data.model;
  return typeof model === "string" ? stripQuotes(model) : undefined;
}

function wallClockOf(spans: TimelineSpan[]): number {
  if (spans.length === 0) return 0;
  const start = Math.min(...spans.map((s) => s.extent.start));
  const end = Math.max(...spans.map((s) => s.extent.end));
  return end - start;
}
