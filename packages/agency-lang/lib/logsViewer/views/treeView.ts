// The tree view on the View interface. This is the ADAPTER stage of the
// migration: the reducer (input.ts) and row rendering (render.ts) are
// imported unchanged; this class owns the ViewerState they operate on and
// translates the reducer's ViewerCommand side channel into ViewActions.
// The scroll/paginate glue moved here from run.ts — a view that receives
// the viewport can own its own scrolling, which is the point of the move.
import { column, line } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { clampScroll, followCursor } from "../../tui/scroll.js";
import { scrollList } from "../../tui/scrollList.js";
import { detectClipboard } from "../clipboard.js";
import { helpLines as treeHelpLines } from "../help.js";
import { handleKeyEx } from "./treeReducer.js";
import { colorFor, flattenVisibleRows, renderRowText, VisibleRow } from "../treeRows.js";
import { expandAncestorsOf, findMatches } from "../search.js";
import { bottomHints } from "./shared.js";
import type { ViewerThresholds } from "../thresholds.js";
import type { TreeNode, ViewerState } from "../types.js";
import type { View, ViewAction, Viewport } from "./view.js";

export class TreeView implements View {
  readonly viewName = "tree" as const;
  private state: ViewerState;

  constructor(
    roots: TreeNode[],
    private readonly thresholds: ViewerThresholds,
    private readonly viewport: Viewport,
  ) {
    this.state = {
      roots,
      expanded: new Set(roots.length === 1 ? [roots[0].id] : []),
      cursorId: roots[0]?.id ?? "",
      scrollTop: 0,
      quit: false,
      viewportCols: viewport.cols,
    };
  }

  handleKey(ev: KeyEvent, viewport: Viewport): ViewAction {
    const fmt = formatKey(ev);
    if (fmt === "t") {
      return { kind: "open", view: "flame" };
    }
    if (fmt === "d") {
      const id = this.cursorRealId();
      if (id !== undefined) return { kind: "openDetail", spanId: id };
    }
    const paged = this.paginate(ev, viewport);
    if (paged !== undefined) {
      this.state = this.applyScroll(paged, viewport);
      return { kind: "none" };
    }
    const { state, command } = handleKeyEx(this.state, ev);
    this.state = this.applyScroll(state, viewport);
    if (command?.kind === "search") {
      return {
        kind: "promptLine",
        label: "Search: ",
        onResult: (text) => {
          this.state = this.applySearch(text, viewport);
        },
      };
    }
    if (command?.kind === "copy") {
      const text = this.copyText();
      if (text !== undefined) return { kind: "copy", text };
    }
    // `toggleFollow` is shell-owned now; `f` never reaches this reducer.
    return { kind: "none" };
  }

  render(viewport: Viewport): Element {
    const state = this.state;
    const treeRows = flattenVisibleRows(state);
    const cursorIdx = treeRows.findIndex((r) => r.node.id === state.cursorId);
    const treeHeight = this.paneRows(viewport);
    const { element: tree } = scrollList<VisibleRow>({
      items: treeRows,
      cursorIdx,
      scrollTop: state.scrollTop,
      viewportRows: treeHeight,
      renderItem: (vrow, isCursor) => {
        const fg = colorFor(vrow.node);
        return line(
          renderRowText(vrow, isCursor, state.expanded.has(vrow.node.id), {
            query: state.query,
            thresholds: this.thresholds,
          }),
          fg ? { fg } : undefined,
        );
      },
    });
    return column({ justifyContent: "flex-start" }, tree, this.renderStatusBar(viewport));
  }

  setData(roots: TreeNode[]): void {
    if (roots.length === 0) return;
    const stillThere = findNode(roots, this.state.cursorId);
    this.state = {
      ...this.state,
      roots,
      cursorId: stillThere !== undefined ? this.state.cursorId : roots[0].id,
    };
  }

  helpLines(): string[] {
    return [
      "t — timeline views (flame → by-name)",
      "d — full details of the focused span",
      "",
      ...treeHelpLines(),
    ];
  }

  notify(message: string): void {
    this.state = { ...this.state, messageBar: message };
  }

  /** `o` in a timeline view lands here: reveal and focus the span. */
  reveal(spanId: string): void {
    const revealed = expandAncestorsOf(this.state, [spanId]);
    this.state = { ...this.state, ...revealed, cursorId: spanId };
  }

  /** The trace the cursor sits in — what a timeline view opens on.
   *  Synthetic rows (`<leafId>:...`) resolve through their real leaf. */
  cursorTraceId(): string {
    const node = findNode(this.state.roots, this.cursorRealId() ?? "");
    return node?.traceId ?? this.state.roots[0]?.traceId ?? "";
  }

  setFollowIndicator(on: boolean): void {
    this.state = { ...this.state, followOn: on };
  }

  /** Test probes. */
  cursorRowId(): string {
    return this.state.cursorId;
  }
  expandedIds(): string[] {
    return [...this.state.expanded];
  }
  messageBar(): string | undefined {
    return this.state.messageBar;
  }

  private cursorRealId(): string | undefined {
    const id = this.state.cursorId;
    if (id === "") return undefined;
    if (findNode(this.state.roots, id) !== undefined) return id;
    const colon = id.indexOf(":");
    return colon > 0 ? id.slice(0, colon) : id;
  }

  private paginate(event: KeyEvent, viewport: Viewport): ViewerState | undefined {
    const fmt = formatKey(event);
    const pageRows = Math.max(1, this.paneRows(viewport) - 1);
    const halfPage = Math.max(1, Math.floor(pageRows / 2));
    let delta = 0;
    if (fmt === "Ctrl+F" || fmt === "PageDown") delta = +pageRows;
    else if (fmt === "Ctrl+B" || fmt === "PageUp") delta = -pageRows;
    else if (fmt === "Ctrl+D") delta = +halfPage;
    else if (fmt === "Ctrl+U") delta = -halfPage;
    else return undefined;
    const rows = flattenVisibleRows(this.state);
    if (rows.length === 0) return this.state;
    const curIdx = Math.max(0, rows.findIndex((r) => r.node.id === this.state.cursorId));
    const nextIdx = Math.min(rows.length - 1, Math.max(0, curIdx + delta));
    return { ...this.state, cursorId: rows[nextIdx].node.id };
  }

  private applyScroll(state: ViewerState, viewport: Viewport): ViewerState {
    const rows = flattenVisibleRows(state);
    const cursorIdx = rows.findIndex((r) => r.node.id === state.cursorId);
    const visible = this.paneRows(viewport, state);
    const clamped = clampScroll(state.scrollTop, rows.length, visible);
    const scrollTop = cursorIdx >= 0
      ? followCursor(clamped, cursorIdx, visible)
      : clamped;
    return scrollTop === state.scrollTop ? state : { ...state, scrollTop };
  }

  private applySearch(query: string, viewport: Viewport): ViewerState {
    const state = this.state;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return { ...state, query: undefined, matches: undefined, matchIdx: undefined };
    }
    const matches = findMatches(state.roots, trimmed, state.viewportCols);
    if (matches.length === 0) {
      return {
        ...state,
        query: trimmed,
        matches: [],
        matchIdx: undefined,
        messageBar: `no matches for "${trimmed}"`,
      };
    }
    const withAncestors = expandAncestorsOf(state, matches);
    const jumped: ViewerState = {
      ...withAncestors,
      query: trimmed,
      matches,
      matchIdx: 0,
      cursorId: matches[0],
    };
    return this.applyScroll(jumped, viewport);
  }

  private copyText(): string | undefined {
    const node = findNode(this.state.roots, this.state.cursorId);
    if (node === undefined) return undefined;
    if (detectClipboard() === null) {
      this.notify("clipboard unavailable");
      return undefined;
    }
    const payload = node.event ?? {
      label: node.label,
      traceId: node.traceId,
      metrics: { duration: node.duration, tokens: node.tokens, cost: node.cost },
    };
    return JSON.stringify(payload, null, 2);
  }

  private paneRows(viewport: Viewport, _state: ViewerState = this.state): number {
    // One row is always reserved: the status line now doubles as the
    // view tag ("[tree]", bottom right), so it is always present.
    return Math.max(1, viewport.rows - 1);
  }


  private renderStatusBar(viewport: Viewport): Element {
    const state = this.state;
    const parts: string[] = [];
    if (state.query && state.matches !== undefined) {
      const total = state.matches.length;
      const idx = (state.matchIdx ?? 0) + 1;
      parts.push(total > 0
        ? `match ${idx}/${total} — "${state.query}"`
        : `no matches — "${state.query}"`);
    }
    if (state.followOn) parts.push("[FOLLOW]");
    if (state.messageBar) parts.push(state.messageBar);
    return line(bottomHints(parts.join("  "), "tree", viewport.cols), { fg: "gray" });
  }
}

function findNode(roots: TreeNode[], id: string): TreeNode | undefined {
  const stack: TreeNode[] = [...roots];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.id === id) return n;
    stack.push(...n.children);
  }
  return undefined;
}
