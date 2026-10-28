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
 * Style tags stay unchanged. Escape them separately when rendering through
 * a style parser.
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
