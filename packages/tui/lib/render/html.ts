import type { Cell } from "../elements.js";
import type { Frame } from "../frame.js";
import { cssColors } from "../colors.js";
import { sameStyle, escapeHtml } from "../utils.js";
import { flatten } from "./flatten.js";

function cellStyle(cell: Cell): string {
  const parts: string[] = [];
  if (cell.fg && Object.prototype.hasOwnProperty.call(cssColors, cell.fg)) {
    parts.push(`color:${cssColors[cell.fg]}`);
  }
  if (cell.bg && Object.prototype.hasOwnProperty.call(cssColors, cell.bg)) {
    parts.push(`background-color:${cssColors[cell.bg]}`);
  }
  if (cell.bold) {
    parts.push("font-weight:bold");
  }
  return parts.join(";");
}

export function toHTML(frame: Frame): string {
  const grid = flatten(frame, frame.width, frame.height);
  const lines: string[] = [];

  for (const row of grid) {
    let line = "";
    let i = 0;
    while (i < row.length) {
      const cell = row[i];
      const style = cellStyle(cell);

      // Collect run of cells with same style
      let run = escapeHtml(cell.char);
      let j = i + 1;
      while (j < row.length && sameStyle(row[j], cell)) {
        run += escapeHtml(row[j].char);
        j++;
      }

      if (style) {
        line += `<span style="${style}">${run}</span>`;
      } else {
        line += run;
      }
      i = j;
    }
    lines.push(line);
  }

  const body = lines.join("\n");
  return `<pre style="font-family:monospace;line-height:1;margin:0">${body}</pre>`;
}
