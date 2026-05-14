import type { Cell } from "../elements.js";
import type { Frame } from "../frame.js";
import { cssColors } from "../colors.js";
import { sameStyle, escapeHtml } from "../utils.js";
import { flatten } from "./flatten.js";

// SECURITY: only emit colors that match a strict allow-list. Either a
// known palette name (mapped via cssColors) or a literal hex string of
// the form "#rgb" / "#rrggbb". Any other value is dropped silently.
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function safeColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (Object.prototype.hasOwnProperty.call(cssColors, value)) {
    return cssColors[value];
  }
  if (HEX_COLOR_RE.test(value)) return value;
  return undefined;
}

function cellStyle(cell: Cell): string {
  const parts: string[] = [];
  const fg = safeColor(cell.fg);
  if (fg) parts.push(`color:${fg}`);
  const bg = safeColor(cell.bg);
  if (bg) parts.push(`background-color:${bg}`);
  if (cell.bold) parts.push("font-weight:bold");
  return parts.join(";");
}

export function toHTML(frame: Frame): string {
  const grid = flatten(frame, frame.width, frame.height);
  const lines: string[] = [];

  for (const row of grid) {
    const parts: string[] = [];
    let i = 0;
    while (i < row.length) {
      const cell = row[i];
      const style = cellStyle(cell);

      // Collect run of cells with same style
      const runChars: string[] = [escapeHtml(cell.char)];
      let j = i + 1;
      while (j < row.length && sameStyle(row[j], cell)) {
        runChars.push(escapeHtml(row[j].char));
        j++;
      }
      const run = runChars.join("");

      if (style) {
        parts.push(`<span style="${style}">`, run, `</span>`);
      } else {
        parts.push(run);
      }
      i = j;
    }
    lines.push(parts.join(""));
  }

  const body = lines.join("\n");
  return `<pre style="font-family:monospace;line-height:1;margin:0">${body}</pre>`;
}
