/** Break plain text into chunks no wider than `width`, preferring the last
 *  space at or before the limit and hard-breaking a word that has none. The
 *  text must carry no escape sequences: width is counted in characters. */
export function wrapLine(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut));
    // Drop the space we broke on so the next chunk has no leading blank.
    rest = rest.slice(cut).replace(/^ +/, "");
  }
  if (rest.length > 0) out.push(rest);
  return out;
}
