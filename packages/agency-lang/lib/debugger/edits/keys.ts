import type { KeyBinding } from "../../tui/keymap.js";
import { actionsFor, type EditAction } from "./actions.js";
import type { PaneRow, StopView } from "./rows.js";

/** What the UI knows when a key arrives: where the person is looking,
 *  the row under the cursor, the composer, and how many edits wait. */
export type KeyContext = {
  view: StopView | null;
  focused: string | undefined;
  cursorRow: PaneRow | undefined;
  composer: { open: boolean; draft: string };
  pendingCount: number;
};

/** What a key does, for the UI to carry out. */
export type UiAction =
  | { kind: "moveCursor"; by: number }
  | { kind: "runAction"; action: EditAction; row: PaneRow }
  | { kind: "openComposer" }
  | { kind: "closeComposer" }
  | { kind: "sendComposer" }
  | { kind: "dropEdits" };

const LIST_PANES = ["locals", "globals", "callStack", "branches", "guards"];

const HINT_GAP = " · ";

function dropBinding(ctx: KeyContext): KeyBinding<UiAction>[] {
  return [
    {
      keys: ["x"],
      help: "drop the pending edits",
      hint: "x: drop edits",
      when: () => ctx.pendingCount > 0,
      run: () => ({ kind: "dropEdits" }),
    },
  ];
}

/** The keys on a pane that lists rows: the cursor, and each edit the
 *  row under it offers, from the action table. */
export function listPaneBindings(ctx: KeyContext): KeyBinding<UiAction>[] {
  const bindings: KeyBinding<UiAction>[] = [
    { keys: ["up"], help: "previous row", run: () => ({ kind: "moveCursor", by: -1 }) },
    { keys: ["down"], help: "next row", run: () => ({ kind: "moveCursor", by: 1 }) },
  ];
  const row = ctx.cursorRow;
  if (row !== undefined && ctx.view !== null) {
    for (const action of actionsFor(row, ctx.view)) {
      bindings.push({
        keys: [action.key],
        help: action.sentence(row, ctx.view),
        hint: `${action.key}: ${action.hint(row, ctx.view)}`,
        run: () => ({ kind: "runAction", action, row }),
      });
    }
  }
  return [...bindings, ...dropBinding(ctx)];
}

/** The threads pane keeps its keys; Enter opens the composer. */
export function threadsPaneBindings(ctx: KeyContext): KeyBinding<UiAction>[] {
  return [
    {
      keys: ["enter"],
      help: "open the composer",
      hint: "enter: say something to the model",
      when: () => ctx.view !== null,
      run: () => ({ kind: "openComposer" }),
    },
    ...dropBinding(ctx),
  ];
}

/** While the composer is open: Enter sends, Escape keeps the draft.
 *  Every other key goes to the line editor. */
export function composerBindings(): KeyBinding<UiAction>[] {
  return [
    { keys: ["enter"], help: "send", hint: "enter: send", run: () => ({ kind: "sendComposer" }) },
    {
      keys: ["escape"],
      help: "close, keeping the draft",
      hint: "esc: keep",
      run: () => ({ kind: "closeComposer" }),
    },
  ];
}

/** The table for the pane the person is on. Empty for a pane with no
 *  keys of its own, so the UI's older handling takes the key. */
export function bindingsFor(ctx: KeyContext): KeyBinding<UiAction>[] {
  if (ctx.composer.open) return composerBindings();
  if (ctx.focused === "threads") return threadsPaneBindings(ctx);
  if (ctx.focused !== undefined && LIST_PANES.includes(ctx.focused)) {
    return listPaneBindings(ctx);
  }
  return [];
}

/** The footer line: each binding's hint, from the same table that
 *  handles the keys, so the two cannot disagree. */
export function footerHints(bindings: KeyBinding<UiAction>[]): string {
  return bindings
    .filter((binding) => binding.hint !== undefined && (binding.when?.() ?? true))
    .map((binding) => binding.hint)
    .join(HINT_GAP);
}
