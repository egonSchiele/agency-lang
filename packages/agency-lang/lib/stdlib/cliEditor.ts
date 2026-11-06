// Ctrl+G in the line-mode REPL: write the prompt in `$EDITOR`.
import * as readline from "readline";
import process from "process";
import { RESET, styles } from "@/utils/termcolors.js";
import { editorCommand, openInEditor, type Releasable } from "../eval/newTest/editor.js";

/** The Ctrl+G key at the REPL prompt. */
export type EditorKey = {
  /** Tell the key whether the REPL is waiting at its prompt. */
  atPrompt(waiting: boolean): void;
  /** The text typed when Ctrl+G was pressed, once. Null when it was not. */
  takeTyped(): string | null;
  /** Restore readline's own key handler. */
  teardown(): void;
};

type KeyMeta = { name?: string; ctrl?: boolean };

/**
 * Intercept Ctrl+G at the prompt. The key records the text typed so far and
 * synthesizes Enter, so the pending `rl.question` resolves and the loop can
 * open the editor after asking `takeTyped`. While a turn runs the key
 * passes through. Does nothing when `useTTY` is false.
 */
export function installEditorKey(rl: readline.Interface, useTTY: boolean): EditorKey {
  let waiting = false;
  let typed: string | null = null;
  const takeTyped = (): string | null => {
    const taken = typed;
    typed = null;
    return taken;
  };
  const setWaiting = (on: boolean): void => {
    waiting = on;
  };
  if (!useTTY) {
    return { atPrompt: setWaiting, takeTyped, teardown: () => {} };
  }
  const rlAny = rl as unknown as {
    _ttyWrite: (s: unknown, key: KeyMeta | undefined) => void;
    line: string;
  };
  const originalTtyWrite = rlAny._ttyWrite;
  rlAny._ttyWrite = function (this: typeof rlAny, s: unknown, key: KeyMeta | undefined): void {
    if (key?.ctrl && key.name === "g" && waiting) {
      typed = this.line ?? "";
      originalTtyWrite.call(this, "\r", { name: "return" });
      return;
    }
    originalTtyWrite.call(this, s, key);
  };
  const teardown = (): void => {
    rlAny._ttyWrite = originalTtyWrite;
  };
  return { atPrompt: setWaiting, takeTyped, teardown };
}

/** Stdin as the half of the terminal an editor takes over. Readline stops
 *  reading and leaves raw mode, so the editor is the only reader. */
function releasableInput(rl: readline.Interface): Releasable {
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
  return {
    release: () => {
      rl.pause();
      stdin.setRawMode?.(false);
    },
    reclaim: () => {
      stdin.setRawMode?.(true);
      rl.resume();
    },
  };
}

/** The line-mode REPL draws nothing an editor would overwrite. */
const NOTHING_TO_RELEASE: Releasable = { release: () => {}, reclaim: () => {} };

/** Open `typed` in `$EDITOR` and return what the user saved. Null when
 *  `$EDITOR` is unset, the editor failed, or the saved text is blank. */
export function editInEditor(rl: readline.Interface, typed: string): string | null {
  const editor = editorCommand(process.env);
  if (editor === null) {
    process.stdout.write(`${styles.dim}Set $EDITOR to write a prompt in your editor.${RESET}\n`);
    return null;
  }
  const terminal = { input: releasableInput(rl), output: NOTHING_TO_RELEASE };
  try {
    const saved = openInEditor(typed, editor, terminal);
    return saved === null || saved.trim() === "" ? null : saved;
  } catch (err) {
    process.stdout.write(`Could not run ${editor.command}: ${(err as Error).message}\n`);
    return null;
  }
}
