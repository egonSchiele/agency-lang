// Whether the line the REPL is handling was typed and entered by hand. A
// caller that acts on a line with no approval, such as the agent's `!`
// shell command, asks this first, so pasted text is never acted on.
export type TypedLine = {
  /** True when the user pressed Enter by hand to submit the current line. */
  wasTyped(): boolean;
  /** The current line was replaced by text from somewhere else, such as
   *  `/paste` or the editor. */
  notTyped(): void;
  /** Restore readline's own key handler. */
  teardown(): void;
};

type KeyMeta = { name?: string };

/** The part of a readline interface this file wraps. */
type KeyHandler = { _ttyWrite: (s: unknown, key: KeyMeta | undefined) => void };

/**
 * Watch the keys that reach readline and note how each line was submitted.
 * A terminal delivers pasted text as one piece, so the Enter inside a
 * paste arrives together with other keys. An Enter the user pressed
 * arrives alone. Only that one counts as typed. Without a terminal no line
 * is typed.
 *
 * `afterThisBurst` runs its callback once the keys already waiting have
 * been handled. The REPL passes `setImmediate`.
 */
export function watchTypedLine(
  rl: KeyHandler,
  useTTY: boolean,
  afterThisBurst: (done: () => void) => void,
): TypedLine {
  let typed = false;
  const notTyped = (): void => {
    typed = false;
  };
  if (!useTTY) {
    return { wasTyped: () => false, notTyped, teardown: () => {} };
  }
  // The keys of one piece of input are handled without a pause between
  // them, so they all arrive before `afterThisBurst` runs.
  let keysInBurst = 0;
  const originalTtyWrite = rl._ttyWrite;
  rl._ttyWrite = function (this: KeyHandler, s: unknown, key: KeyMeta | undefined): void {
    if (keysInBurst === 0) {
      afterThisBurst(() => {
        keysInBurst = 0;
      });
    }
    keysInBurst++;
    if (key?.name === "return" || key?.name === "enter") {
      typed = keysInBurst === 1;
    }
    originalTtyWrite.call(this, s, key);
  };
  const teardown = (): void => {
    rl._ttyWrite = originalTtyWrite;
  };
  return { wasTyped: () => typed, notTyped, teardown };
}
