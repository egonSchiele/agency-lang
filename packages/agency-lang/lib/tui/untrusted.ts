// Text this tool did not author, made safe to draw. Agent output, task text
// and clipboard contents are all untrusted: a model can emit cursor movement,
// clear-screen, or clipboard-write sequences, and the TUI's style parser reads
// `{black-fg}` as markup, so plain text alone can hide what is on screen.
import { stripControlCharacters } from "../utils/controlCharacters.js";
import { escapeStyleTags } from "./styleParser.js";

export { stripControlCharacters };

/** Neutralize controls and escape style tags before applying TUI styling. */
export function sanitizeUntrusted(text: string): string {
  return escapeStyleTags(stripControlCharacters(text));
}

/**
 * Clipboard text, made safe for a single-line editor.
 *
 * Newlines and tabs are collapsed to spaces because the draft renders on one
 * footer row, and every other control character is dropped rather than
 * replaced — a paste is the user's own text, so a visible replacement marker
 * would be noise rather than evidence.
 */
export function pastedText(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n" || character === "\r" || character === "\t") {
      out += " ";
      continue;
    }
    const isControl = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    if (!isControl) {
      out += character;
    }
  }
  return out;
}
