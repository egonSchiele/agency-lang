import { TreeNode, ViewerState } from "./types.js";
import { eventExpansionChildren, rawDataChildren } from "./render.js";

// Walk every node in the forest (regardless of current expansion
// state) AND every synthetic expansion row (conversation lines, JSON
// payload lines, raw-data toggle) and return the ids of nodes whose
// `summary` contains the query case-insensitively. The returned order
// matches a depth-first pre-order walk, which is also the visible
// order once ancestors are expanded.
//
// We have to walk the synthetic rows here too — otherwise `/foo`
// would visibly highlight a match in a conversation/JSON row but
// `n`/`N` would jump to "no matches" because those rows aren't in
// state.roots.
export function findMatches(roots: TreeNode[], query: string): string[] {
  if (query.length === 0) return [];
  const needle = query.toLowerCase();
  const out: string[] = [];
  const pushIfMatches = (node: TreeNode): void => {
    if (node.summary.toLowerCase().includes(needle)) {
      out.push(node.id);
    }
  };
  const walk = (node: TreeNode): void => {
    pushIfMatches(node);
    if (node.nodeKind === "event" && node.event) {
      for (const synth of eventExpansionChildren(node)) {
        pushIfMatches(synth);
        if (synth.nodeKind !== "rawDataToggle") {
          continue;
        }
        for (const json of rawDataChildren(synth)) {
          pushIfMatches(json);
        }
      }
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
//
// Synthetic ids (e.g. "evt-3:convo:1", "evt-3:raw", "evt-3:raw:json:7")
// are not in the persistent forest, so we first walk back along the
// synthetic-id chain to the underlying leaf event id, expanding each
// synthetic ancestor along the way, then walk the real-forest
// ancestors as before.
export function expandAncestorsOf(
  state: ViewerState,
  matchIds: string[],
): ViewerState {
  if (matchIds.length === 0) return state;
  const byId = indexById(state.roots);
  const next = new Set(state.expanded);
  for (const id of matchIds) {
    const realLeafId = expandSyntheticAncestors(id, next);
    let cur = byId[realLeafId];
    while (cur && cur.parentId) {
      next.add(cur.parentId);
      cur = byId[cur.parentId];
    }
  }
  return next.size === state.expanded.size ? state : { ...state, expanded: next };
}

// Walk a synthetic id back to its real-forest leaf id, expanding each
// synthetic parent so the match is visible. Synthetic id forms:
//   <leaf>:convo:<n>          — conversation line under a leaf event
//   <leaf>:json:<n>           — raw JSON line under a non-pc leaf
//   <leaf>:raw                — "raw data" toggle under a leaf
//   <leaf>:raw:json:<n>       — JSON line under an opened raw toggle
// Leaves themselves are returned unchanged.
function expandSyntheticAncestors(id: string, expanded: Set<string>): string {
  const colon = id.indexOf(":");
  if (colon < 0) return id;
  const leafId = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  // Always expand the leaf so its synthetic children become visible.
  expanded.add(leafId);
  // If the match lives under the "raw data" toggle, also expand it.
  if (rest.startsWith("raw:") || rest === "raw") {
    expanded.add(`${leafId}:raw`);
  }
  return leafId;
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
