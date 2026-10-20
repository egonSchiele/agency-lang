// A single-line text field edited one key at a time. The field's draft lives
// in the caller's state; this file only says what a key means while the field
// is being edited, and how an edit changes the draft. The label screen and the
// eval test form both type through it.
import type { KeyEvent } from "./input/types.js";
import { pastedText } from "./untrusted.js";

export type LineEditAction =
  | { kind: "append"; text: string }
  | { kind: "backspace" }
  | { kind: "backspaceWord" }
  | { kind: "cancel" }
  | { kind: "submit" };

/** What a key does while a line is being edited; null for a key that does
 *  nothing there (a Ctrl chord, an arrow). */
export function lineEditAction(event: KeyEvent): LineEditAction | null {
  if (event.key === "enter") return { kind: "submit" };
  if (event.key === "escape") return { kind: "cancel" };
  if (event.key === "backspace") {
    return event.alt === true ? { kind: "backspaceWord" } : { kind: "backspace" };
  }
  // Bracketed paste arrives as one event carrying the whole clipboard, not
  // as a stream of characters.
  if (event.key === "paste") {
    const pasted = pastedText(event.text ?? "");
    return pasted.length === 0 ? null : { kind: "append", text: pasted };
  }
  // A stray Ctrl-F or Option+Left while typing must not land in the text.
  if (event.ctrl === true || event.alt === true) return null;
  if (event.key.length === 1 && event.key >= " ") {
    return { kind: "append", text: event.key };
  }
  return null;
}

/** The draft after an edit. Cancel and submit leave the draft alone: what
 *  they mean belongs to the caller. Backspace removes a whole code point:
 *  an emoji arrives as two UTF-16 halves, and leaving one behind would put
 *  a broken character in the draft. Option+Backspace removes the last word
 *  and the spaces after it, as it does in a shell. */
export function applyLineEdit(draft: string, action: LineEditAction): string {
  switch (action.kind) {
    case "append":
      return draft + action.text;
    case "backspace":
      return [...draft].slice(0, -1).join("");
    case "backspaceWord":
      return draft.replace(/\S*\s*$/, "");
    case "cancel":
    case "submit":
      return draft;
  }
}
