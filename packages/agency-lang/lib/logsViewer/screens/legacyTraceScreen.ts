import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { parseRoundId } from "../timeline/rounds.js";
import type { TreeNode } from "../types.js";
import type { TreeView } from "../views/treeView.js";
import type { ViewAction, Viewport } from "../views/view.js";
import type { Screen } from "./screen.js";
// screens/legacyTraceScreen.ts
// Slot 2 until the new trace screen lands (PR 6 deletes this file). It
// forwards to the old TreeView and swallows the keys that no longer exist.
const RETIRED_KEYS = ["t", "T", "Escape"];

export class LegacyTraceScreen implements Screen {
  readonly screenName = "trace" as const;
  constructor(private readonly tree: TreeView) {}

  handleKey(ev: KeyEvent, viewport: Viewport): ViewAction {
    if (RETIRED_KEYS.includes(formatKey(ev))) {
      return { kind: "none" };
    }
    return this.tree.handleKey(ev, viewport);
  }
  render(viewport: Viewport): Element {
    return this.tree.render(viewport);
  }
  setData(roots: TreeNode[]): void {
    this.tree.setData(roots);
  }
  helpLines(): string[] {
    return this.tree.helpLines();
  }
  notify(message: string): void {
    this.tree.notify(message);
  }
  setFollowIndicator(on: boolean): void {
    this.tree.setFollowIndicator(on);
  }
  focusId(): string | undefined {
    return this.tree.cursorSpanId();
  }
  setFocus(id: string): void {
    this.tree.reveal(parseRoundId(id)?.spanId ?? id);
  }
  setTrace(traceId: string): void {
    this.tree.reveal(`trace-${traceId}`);
  }
  applySearch(query: string): void {
    this.tree.search(query, this.tree.cursorTraceId());
  }
  escape(): boolean {
    return this.tree.clearSearch();
  }
}
