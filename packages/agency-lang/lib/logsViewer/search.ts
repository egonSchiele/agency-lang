import { TreeNode, ViewerState } from "./types.js";

// Walk every node in the forest (regardless of current expansion
// state) and return the ids of nodes whose `summary` contains the
// query case-insensitively. The returned order matches a depth-first
// pre-order walk, which is also the visible order once ancestors are
// expanded.
export function findMatches(roots: TreeNode[], query: string): string[] {
  if (query.length === 0) return [];
  const needle = query.toLowerCase();
  const out: string[] = [];
  const walk = (node: TreeNode): void => {
    if (node.summary.toLowerCase().includes(needle)) {
      out.push(node.id);
    }
    for (const child of node.children) walk(child);
  };
  for (const r of roots) walk(r);
  return out;
}

// Given a list of match node ids, return a new ViewerState whose
// `expanded` set includes every ancestor of every match. The match
// nodes themselves are NOT expanded (we only need their ancestors
// visible so the cursor can land on the match).
export function expandAncestorsOf(
  state: ViewerState,
  matchIds: string[],
): ViewerState {
  if (matchIds.length === 0) return state;
  const byId = indexById(state.roots);
  const next = new Set(state.expanded);
  for (const id of matchIds) {
    let cur = byId[id];
    while (cur && cur.parentId) {
      next.add(cur.parentId);
      cur = byId[cur.parentId];
    }
  }
  return next.size === state.expanded.size ? state : { ...state, expanded: next };
}

function indexById(roots: TreeNode[]): Record<string, TreeNode> {
  const out: Record<string, TreeNode> = {};
  const walk = (n: TreeNode): void => {
    out[n.id] = n;
    for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

// Highlight a substring in a row's rendered text. Returns segment
// list where the matching substring(s) carry `bg: "yellow"`. The
// caller turns segments into TUI text. Case-insensitive match.
export type Segment = { text: string; bg?: "yellow" };

export function highlightMatches(text: string, query: string): Segment[] {
  if (query.length === 0) return [{ text }];
  const needle = query.toLowerCase();
  const lower = text.toLowerCase();
  const out: Segment[] = [];
  let i = 0;
  while (i < text.length) {
    const hit = lower.indexOf(needle, i);
    if (hit < 0) {
      out.push({ text: text.slice(i) });
      break;
    }
    if (hit > i) out.push({ text: text.slice(i, hit) });
    out.push({ text: text.slice(hit, hit + query.length), bg: "yellow" });
    i = hit + query.length;
  }
  return out;
}
