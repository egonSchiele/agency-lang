// Wire types moved to lib/statelog/wireTypes.ts so the eval module
// (a peer of this viewer, not a dependent) can import them without
// pulling in viewer internals. Re-exported here to keep existing
// imports from `logsViewer/types` working.
import type { EventEnvelope, EventData } from "../statelog/wireTypes.js";
import type { TreeNode } from "./treeNode.js";
export type { EventEnvelope, EventData };
// TreeNode is now a class (lib/logsViewer/treeNode.ts) that hides the parser.
// Re-exported so existing `import { TreeNode } from "./types.js"` sites keep
// working.
export type { TreeNode } from "./treeNode.js";

export type ViewerState = {
  // The full forest (one root per trace_id).
  roots: TreeNode[];
  // ids of every node currently expanded.
  expanded: Set<string>;
  // Currently-focused node id (cursor position).
  cursorId: string;
  // Vertical scroll offset (line of the first visible row).
  scrollTop: number;
  // Set by the input layer; consumed by the run loop.
  quit: boolean;
  // ---- v2 additions ----
  // Active substring query for `/`, `n`, `N`. Empty when search is off.
  query?: string;
  // Node ids that currently match `query`, in flatten order.
  matches?: string[];
  // Index into `matches` for the current "n/N" position.
  matchIdx?: number;
  // Help-screen overlay shown?
  helpOpen?: boolean;
  // Follow mode (`--follow` / `f`) — viewer re-reads the file when it grows.
  followOn?: boolean;
  // One-line status message (`copied 312 bytes`, etc.); auto-clears
  // on the next keystroke. Owned by the input layer.
  messageBar?: string;
  // Width (in terminal columns) available to the viewer. Used to
  // wrap long convoLine summaries onto multiple visible rows so
  // promptCompletion messages aren't truncated with `…`. Kept on
  // state so the renderer, input layer, and search all agree on
  // the same row set.
  viewportCols?: number;
};
