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

export function groupSpans(spans: TimelineSpan[], root: TreeNode): SpanGroup[] {
  const index = indexTree(root);
  const byKey: Record<string, SpanGroup> = {};
  for (const s of spans) {
    const node = index.byId[s.id];
    if (node === undefined) continue;
    const key = keyOf(node, index);
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
  const index = indexTree(root);
  const node = index.byId[spanId];
  if (node === undefined) return "?";
  return keyOf(node, index);
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

type TreeIndex = { byId: Record<string, TreeNode>; parentIds: Record<string, string> };

function indexTree(root: TreeNode): TreeIndex {
  const byId: Record<string, TreeNode> = {};
  const parentIds: Record<string, string> = {};
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

/** llm: thread label → enclosing function → model. Others: display name. */
function keyOf(node: TreeNode, index: TreeIndex): string {
  if (node.label !== "llmCall") {
    return spanDisplayName(node);
  }
  const label = threadLabelFor(node, index);
  if (label !== undefined) return `llm(${label})`;
  const enclosing = enclosingFunctionName(node, index);
  if (enclosing !== undefined) return `llm(${enclosing})`;
  return `llm(${modelOf(node) ?? "?"})`;
}

/** Thread ids restart in every subprocess (one trace held two
 *  threadCreated events for id "1"), so the lookup scope is the nearest
 *  enclosing subprocessRun span — or the trace root — EXCLUDING nested
 *  subprocessRun subtrees, which are other processes' id spaces. */
function threadLabelFor(node: TreeNode, index: TreeIndex): string | undefined {
  const call = childEvent(node, "promptCompletion") ?? childEvent(node, "promptStart");
  const threadId = call?.data.threadId;
  if (threadId === undefined) return undefined;
  const scope = nearestAncestor(node, index, (a) => a.label === "subprocessRun")
    ?? rootOf(node, index);
  let label: string | undefined;
  const scan = (n: TreeNode) => {
    if (n !== scope && n.nodeKind === "span" && n.label === "subprocessRun") return;
    const d = n.event?.data;
    if (d?.type === "threadCreated" && String(d.threadId) === String(threadId)
        && typeof d.label === "string" && d.label.length > 0) {
      label = d.label;
    }
    n.children.forEach(scan);
  };
  scan(scope);
  return label;
}

function enclosingFunctionName(node: TreeNode, index: TreeIndex): string | undefined {
  const found = nearestAncestor(node, index, (a) =>
    a.label === "toolExecution" || a.label === "nodeExecution");
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
