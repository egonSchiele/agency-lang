// One table per screen says what its keys are. The key handler, the `?`
// overlay and the footer are all derived from it, so they cannot disagree
// and adding a key is one edit. Generic in the action type, so this file
// holds no viewer concepts: `lib/logsViewer/keymap.ts` binds it to
// `ViewAction`, and another TUI can bind it to its own.

export type KeyBinding<Action> = {
  keys: string[];
  help: string;
  hint?: string;
  when?: () => boolean;
  run: () => Action | void;
};

export type CursorMoves = {
  by: (delta: number) => void;
  toTop: () => void;
  toBottom: () => void;
  /** Rows in one page, read when the key is pressed. */
  page: () => number;
  /** Rows in half a page, at least one. */
  halfPage: () => number;
};

const HINT_GAP = "   ";

function isAvailable<Action>(binding: KeyBinding<Action>): boolean {
  return binding.when === undefined || binding.when();
}

export function findBinding<Action>(
  bindings: KeyBinding<Action>[],
  key: string,
): KeyBinding<Action> | undefined {
  return bindings.find((candidate) => candidate.keys.includes(key) && isAvailable(candidate));
}

export function runKey<Action>(
  bindings: KeyBinding<Action>[],
  key: string,
  fallback: Action,
): Action {
  const result = findBinding(bindings, key)?.run();
  return result ?? fallback;
}

export function helpFrom<Action>(bindings: KeyBinding<Action>[]): string[] {
  return bindings.map((binding) => `${binding.keys.join(" / ")} — ${binding.help}`);
}

export function hintsFrom<Action>(bindings: KeyBinding<Action>[]): string {
  return bindings
    .filter((binding) => binding.hint !== undefined && isAvailable(binding))
    .map((binding) => binding.hint)
    .join(HINT_GAP);
}

export function duplicateKeys<Action>(bindings: KeyBinding<Action>[]): string[] {
  const keys = bindings.flatMap((binding) => binding.keys);
  const repeated = keys.filter((key, position) => keys.indexOf(key) !== position);
  return repeated.filter((key, position) => repeated.indexOf(key) === position);
}

/** The movement keys every Agency TUI shares. A full page on Ctrl+F and
 *  the Page keys, half a page on Ctrl+D and Ctrl+U — the tree view's
 *  behavior today (`treeView.ts:216-221`), now the rule everywhere. */
export function cursorBindings<Action>(moves: CursorMoves): KeyBinding<Action>[] {
  return [
    { keys: ["j", "Down"], help: "move down", hint: "j k move", run: () => moves.by(1) },
    { keys: ["k", "Up"], help: "move up", run: () => moves.by(-1) },
    { keys: ["g"], help: "go to the top", run: () => moves.toTop() },
    { keys: ["G"], help: "go to the bottom", run: () => moves.toBottom() },
    { keys: ["Ctrl+F", "PageDown"], help: "page down", run: () => moves.by(moves.page()) },
    { keys: ["Ctrl+B", "PageUp"], help: "page up", run: () => moves.by(-moves.page()) },
    { keys: ["Ctrl+D"], help: "down half a page", run: () => moves.by(moves.halfPage()) },
    { keys: ["Ctrl+U"], help: "up half a page", run: () => moves.by(-moves.halfPage()) },
  ];
}
