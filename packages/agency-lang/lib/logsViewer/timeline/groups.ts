// Group keys and aggregation. In the kernel — not on a view component —
// because the overview's time panel and occurrences must agree, and
// follow-mode re-parses can legitimately re-group a call (a threadCreated
// can arrive after the llm call it names). One computation, two readers.
import { childEvent, spanDetail, stripQuotes } from "../spanText.js";
import { buildTreeIndex, nearestAncestor, rootOf, walkNodes, type TreeIndex } from "../forest.js";
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

/** Per-scope threadId→label maps, built once per process subtree instead
 *  of re-scanning the scope for every llm call (O(k·n) otherwise). */
export type ScopeLabelCache = Record<string, Record<string, string>>;

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
  const scope = threadScopeOf(node, index);
  return scopeThreadLabels(scope, cache)[String(threadId)];
}

/** Process scope for legacy display labels. Fresh tool stores also reuse
 * local thread ids within this scope; this is not a thread identity. */
export function threadScopeOf(node: TreeNode, index: TreeIndex): TreeNode {
  const isSubprocess = (ancestor: TreeNode): boolean =>
    ancestor.nodeKind === "span" && ancestor.label === "subprocessRun";
  return nearestAncestor(node, index, isSubprocess) ?? rootOf(node, index);
}

export function scopeThreadLabels(scope: TreeNode, cache: ScopeLabelCache): Record<string, string> {
  cache[scope.id] ??= scanScopeLabels(scope);
  return cache[scope.id];
}

export function unambiguousThreadLabels(
  scope: TreeNode,
  index: TreeIndex,
  cache: ScopeLabelCache,
): Record<string, string> {
  if (cache[scope.id] !== undefined) {
    return cache[scope.id];
  }
  const creations: Record<string, TreeNode[]> = Object.create(null);
  const labels: Record<string, string> = Object.create(null);
  for (const node of walkNodes(scope)) {
    const data = node.event?.data;
    if (data?.type !== "threadCreated" || threadScopeOf(node, index).id !== scope.id) {
      continue;
    }
    const localId = String(data.threadId);
    (creations[localId] ??= []).push(node);
  }
  for (const [localId, nodes] of Object.entries(creations)) {
    const label = nodes[0].event?.data.label;
    if (nodes.length === 1 && typeof label === "string" && label.length > 0) {
      labels[localId] = label;
    }
  }
  cache[scope.id] = labels;
  return labels;
}

/** DFS order means a reused thread id resolves to the LAST threadCreated
 *  in the scope — "the most recent naming wins". Id reuse within one
 *  process is rare enough that positional (before-the-call) resolution
 *  has not been worth the bookkeeping; revisit if a real log disagrees. */
function scanScopeLabels(scope: TreeNode): Record<string, string> {
  const labels: Record<string, string> = Object.create(null);
  const index = buildTreeIndex(scope);
  for (const node of walkNodes(scope)) {
    const data = node.event?.data;
    if (
      data?.type === "threadCreated" &&
      threadScopeOf(node, index).id === scope.id &&
      typeof data.label === "string" &&
      data.label.length > 0
    ) {
      labels[String(data.threadId)] = data.label;
    }
  }
  return labels;
}

function enclosingFunctionName(node: TreeNode, index: TreeIndex): string | undefined {
  const found = nearestAncestor(
    node,
    index,
    (ancestor) =>
      ancestor.nodeKind === "span" &&
      (ancestor.label === "toolExecution" || ancestor.label === "nodeExecution"),
  );
  if (found === undefined) return undefined;
  return spanDisplayName(found);
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
