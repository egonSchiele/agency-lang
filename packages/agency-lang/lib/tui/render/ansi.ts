import type { Cell } from "../elements.js";
import type { Frame } from "../frame.js";
import { ansiColors, ansiBgColors } from "../colors.js";
import { sameStyle } from "../utils.js";
import { flatten } from "./flatten.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function expandHex(hex: string): [number, number, number] {
  const h = hex.slice(1);
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ];
  }
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function colorEscape(value: string | undefined, kind: "fg" | "bg"): string {
  if (!value) return "";
  const palette = kind === "fg" ? ansiColors : ansiBgColors;
  if (Object.prototype.hasOwnProperty.call(palette, value)) {
    return palette[value];
  }
  if (HEX_COLOR_RE.test(value)) {
    const [r, g, b] = expandHex(value);
    const introducer = kind === "fg" ? 38 : 48;
    return `\x1b[${introducer};2;${r};${g};${b}m`;
  }
  return "";
}

function cellEscapes(cell: Cell): string {
  let seq = "";
  if (cell.bold) seq += BOLD;
  seq += colorEscape(cell.fg, "fg");
  seq += colorEscape(cell.bg, "bg");
  return seq;
}

export function toANSI(frame: Frame): string {
  const grid = flatten(frame, frame.width, frame.height);
  const lines: string[] = [];

  for (const row of grid) {
    const parts: string[] = [];
    let i = 0;
    while (i < row.length) {
      const cell = row[i];
      const esc = cellEscapes(cell);

      // Collect run of cells with same style
      const runChars: string[] = [cell.char];
      let j = i + 1;
      while (j < row.length && sameStyle(row[j], cell)) {
        runChars.push(row[j].char);
        j++;
      }
      const run = runChars.join("");

      if (esc) {
        parts.push(esc, run, RESET);
      } else {
        parts.push(run);
      }
      i = j;
    }
    lines.push(parts.join(""));
  }

  return lines.join("\n");
}
