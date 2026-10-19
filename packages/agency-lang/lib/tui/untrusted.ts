// Text this tool did not author, made safe to draw. Agent output, task text
// and clipboard contents are all untrusted: a model can emit cursor movement,
// clear-screen, or clipboard-write sequences, and the TUI's style parser reads
// `{black-fg}` as markup, so plain text alone can hide what is on screen.
import { escapeStyleTags } from "./styleParser.js";

/**
 * Neutralize control characters in text this tool did not author.
 *
 * Agent output, task text, question text and notes are all untrusted: a model
 * can emit cursor movement, clear-screen, or OSC 52 clipboard writes, and
 * rendering those raw would let the thing being judged hide or forge the
 * evidence on screen. Only newline and tab survive, because the layout uses
 * them; everything else in C0, C1 and DEL becomes a visible replacement so the
 * reader can see something was there.
 *
 * Style tags are escaped too. The TUI parser reads `{black-fg}` as markup, so
 * plain text alone is enough to restyle or hide the very evidence being
 * judged — control characters are not the only way into a terminal.
 *
 * Styling is applied afterwards, so the tool's own colour is unaffected.
 */
export function stripControlCharacters(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n" || character === "\t") {
      out += character;
      continue;
    }
    const isC0 = code < 0x20;
    const isDelete = code === 0x7f;
    const isC1 = code >= 0x80 && code <= 0x9f;
    out += isC0 || isDelete || isC1 ? "�" : character;
  }
  return out;
}

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
