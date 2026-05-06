import type { Cell } from "../elements.js";
import type { Frame } from "../frame.js";
import { ansiColors, ansiBgColors } from "../colors.js";
import { flatten } from "./flatten.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function cellEscapes(cell: Cell): string {
  let seq = "";
  if (cell.bold) seq += BOLD;
  if (cell.fg) seq += ansiColors[cell.fg] ?? "";
  if (cell.bg) seq += ansiBgColors[cell.bg] ?? "";
  return seq;
}

function sameStyle(a: Cell, b: Cell): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold;
}

export function toANSI(frame: Frame): string {
  const grid = flatten(frame, frame.width, frame.height);
  const lines: string[] = [];

  for (const row of grid) {
    let line = "";
    let i = 0;
    while (i < row.length) {
      const cell = row[i];
      const esc = cellEscapes(cell);

      // Collect run of cells with same style
      let run = cell.char;
      let j = i + 1;
      while (j < row.length && sameStyle(row[j], cell)) {
        run += row[j].char;
        j++;
      }

      if (esc) {
        line += esc + run + RESET;
      } else {
        line += run;
      }
      i = j;
    }
    lines.push(line);
  }

  return lines.join("\n");
}
