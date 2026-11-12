/** What a terminal would show: on each line, the text after the last
 *  carriage return. A `\r\n` line ending is a line ending, not an
 *  overwrite, and a line that ends in `\r` keeps the text before it, so a
 *  progress bar that was just cleared still shows its last state. */
export function collapseCarriageReturns(text: string): string {
  if (!text.includes("\r")) {
    return text;
  }
  return text.split("\n").map(lastShownSegment).join("\n");
}

function lastShownSegment(line: string): string {
  const segments = line.split("\r").filter((segment) => segment !== "");
  return segments.length === 0 ? "" : segments[segments.length - 1];
}
