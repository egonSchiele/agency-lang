// Timed spans for the timeline views: extents, self-time, running
// detection. Pure over the TreeNode forest; output is plain data with no
// TreeNode reference (the cross-run project consumes this without a TUI).
import { walkNodes } from "../forest.js";
import type { TreeNode } from "../types.js";
import { subtract, totalMs, type Interval } from "./intervals.js";

export type TimelineSpan = {
  id: string;
  kind: string;
  depth: number;
  extent: Interval;
  /** Start-marking event has no matching terminus yet (live run under follow). */
  running: boolean;
  /** Envelope minus the union of DIRECT child span envelopes. Without
   *  this, the top-level llmCall span (which wraps the whole tool loop)
   *  absorbs the entire run — observed as a 193% share. */
  selfIntervals: Interval[];
  selfMs: number;
};

/** Hidden by default in timeline views: per-interrupt bookkeeping that
 *  appears under nearly every tool call and buries the signal. */
export const ADMIN_KINDS = ["handlerChain", "threadEndHooks"];

// Cancellation counts as an end: summary.ts renders "⏳ … never completed"
// on the same judgment, and a cancelled call must not read running forever.
const ENDS_BY_START: Record<string, string[]> = {
  toolCallStart: ["toolCall", "toolError"],
  promptStart: ["promptCompletion", "promptCancelled"],
  subprocessStarted: ["subprocessEnd"],
};

export function timelineSpans(root: TreeNode, opts: { hideKinds: string[] }): TimelineSpan[] {
  const out: TimelineSpan[] = [];
  if (root.nodeKind === "span") {
    pushSpan(root, 0, opts.hideKinds, out);
  } else {
    collect(root, 0, opts.hideKinds, out);
  }
  return out;
}

function pushSpan(node: TreeNode, depth: number, hideKinds: string[], out: TimelineSpan[]): void {
  const made = makeSpan(node, depth);
  if (made !== undefined) {
    out.push(made);
  }
  // A timestamp-less span is dropped; its children surface at ITS depth so
  // no phantom indentation level appears under a row that is not there.
  const childDepth = made !== undefined ? depth + 1 : depth;
  collect(node, childDepth, hideKinds, out);
}

function collect(node: TreeNode, depth: number, hideKinds: string[], out: TimelineSpan[]): void {
  for (const child of node.children) {
    if (child.nodeKind !== "span") continue;
    if (hideKinds.includes(child.label)) {
      // Hidden rows disappear; their subtree keeps ITS depth relative to
      // the surviving ancestor, and self-time is untouched (an admin
      // span's envelope sits inside its parent's either way).
      collect(child, depth, hideKinds, out);
    } else {
      pushSpan(child, depth, hideKinds, out);
    }
  }
}

function makeSpan(node: TreeNode, depth: number): TimelineSpan | undefined {
  const extent = spanExtent(node);
  if (extent === undefined) return undefined;
  const childExtents = node.children
    .filter((c) => c.nodeKind === "span")
    .map(spanExtent)
    .filter((e): e is Interval => e !== undefined);
  const selfIntervals = subtract(extent, childExtents);
  return {
    id: node.id,
    kind: node.label,
    depth,
    extent,
    running: hasRunningWork(node),
    selfIntervals,
    selfMs: totalMs(selfIntervals),
  };
}

/** Envelope over ALL descendant leaves: start = min(timestamp − timeTaken),
 *  end = max(timestamp). All-descendants is what makes parent ⊇ child hold
 *  (tree.ts uses the same rule for duration), which keeps self-time ≥ 0.
 *  Called once per node plus once per direct child, and isRunning walks
 *  again — O(n·depth) overall. Fine at current statelog sizes; fold into
 *  one memoised post-order pass when the cross-run project starts feeding
 *  this bigger inputs. */
export function spanExtent(node: TreeNode): Interval | undefined {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const leafNode of walkNodes(node).filter((child) => child.event !== undefined)) {
    const data = leafNode.event!.data;
    const ts = Date.parse(data.timestamp);
    if (!Number.isFinite(ts)) {
      continue;
    }
    const taken = typeof data.timeTaken === "number" ? data.timeTaken : 0;
    start = Math.min(start, ts - taken);
    end = Math.max(end, ts);
  }
  if (!Number.isFinite(start)) return undefined;
  return { start, end: Math.max(end, start) };
}

export function hasRunningWork(node: TreeNode): boolean {
  return walkNodes(node).some((owner) => ownerHasRunningWork(owner));
}

function ownerHasRunningWork(owner: TreeNode): boolean {
  const types = owner.children
    .flatMap((child) => (child.event === undefined ? [] : [child.event]))
    .sort((first, second) => Date.parse(first.data.timestamp) - Date.parse(second.data.timestamp))
    .map((event) =>
      event.data.type === "error" && event.data.errorType === "toolError"
        ? "toolError"
        : event.data.type,
    );
  return Object.entries(ENDS_BY_START).some(([startType, endTypes]) =>
    hasUnmatchedStart(types, startType, endTypes),
  );
}

function hasUnmatchedStart(types: string[], startType: string, endTypes: string[]): boolean {
  let open = 0;
  for (const type of types) {
    if (type === startType) {
      open += 1;
    } else if (endTypes.includes(type) && open > 0) {
      open -= 1;
    }
  }
  return open > 0;
}
