// The one interface every top-level view implements, and the stack the
// shell keeps them on. handleKey is synchronous; anything a view cannot
// do alone comes back as a ViewAction (this replaces the old reducer's
// ViewerCommand side channel, widened to cover every cross-view effect).
import type { Element } from "../../tui/elements.js";
import type { KeyEvent } from "../../tui/input/types.js";
import type { TreeNode } from "../types.js";

export type Viewport = { rows: number; cols: number };

export type ViewAction =
  | { kind: "open"; view: "tree" | "flame" | "byName" }
  | { kind: "openFlameAt"; spanId: string }
  | { kind: "openOccurrences"; groupKey: string }
  | { kind: "openDetail"; spanId: string }
  | { kind: "focusInTree"; spanId: string }
  | { kind: "back" }
  | { kind: "promptLine"; label: string; onResult: (text: string) => void }
  | { kind: "copy"; text: string }
  | { kind: "labelTrace"; traceId: string }
  | { kind: "none" };

export type View = {
  viewName: "tree" | "flame" | "byName" | "occurrences" | "detail";
  /** Synchronous. Viewport is a parameter so views own their paging keys
   *  (Ctrl-F/B/D/U are viewport arithmetic — the old shell kept them out
   *  of the reducer for exactly that reason). */
  handleKey(ev: KeyEvent, viewport: Viewport): ViewAction;
  render(viewport: Viewport): Element;
  /** Follow mode: a fresh forest. UI state (cursor, drill, zoom) survives
   *  by id / absolute time; ids that no longer resolve fall back. */
  setData(roots: TreeNode[]): void;
  /** Content of the shell's `?` overlay while this view is active. */
  helpLines(): string[];
  /** Shell feedback (copy result, stale-view notes) → the view's message bar. */
  notify(message: string): void;
  /** Follow mode is shell-owned; views only display it (status bar / header). */
  setFollowIndicator(on: boolean): void;
};

export type ViewStack = {
  active(): View;
  all(): View[];
  push(view: View): void;
  /** `open` semantics: pop back to an existing instance of `name` if one
   *  is on the stack (true), else report absent (false) so the shell
   *  constructs and pushes one. */
  popTo(name: View["viewName"]): boolean;
  /** Never pops the bottom (the tree view). */
  pop(): void;
};

export function makeViewStack(bottom: View): ViewStack {
  const stack: View[] = [bottom];
  return {
    active: () => stack[stack.length - 1],
    all: () => [...stack],
    push: (view) => {
      stack.push(view);
    },
    popTo: (name) => {
      const at = stack.map((v) => v.viewName).lastIndexOf(name);
      if (at === -1) return false;
      stack.length = at + 1;
      return true;
    },
    pop: () => {
      if (stack.length > 1) {
        stack.pop();
      }
    },
  };
}
