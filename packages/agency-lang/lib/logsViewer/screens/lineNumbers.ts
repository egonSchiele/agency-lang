import { joinPainted, paint, segment, type Painted } from "../../tui/paint.js";
import { THEME } from "../theme.js";

export function lineNumberWidth(total: number): number {
  return Math.max(2, String(total).length) + 1;
}

export function lineNumber(number: number, width: number): Painted {
  return joinPainted(
    segment(String(number), Math.max(0, width - 1), { align: "right", style: { fg: THEME.muted } }),
    paint(" "),
  );
}

/** Reserve room before wrapping, then number continuously across blocks. */
export function numberedBlocks<Block extends { lines: Painted[] }>(
  width: number,
  render: (contentWidth: number) => Block[],
): Block[] {
  let gutter = lineNumberWidth(0);
  while (true) {
    const blocks = render(Math.max(1, width - gutter));
    const total = blocks.reduce((sum, block) => sum + block.lines.length, 0);
    const needed = lineNumberWidth(total);
    if (needed > gutter) {
      gutter = needed;
      continue;
    }
    let number = 0;
    return blocks.map((block) => ({
      ...block,
      lines: block.lines.map((line) => joinPainted(lineNumber(++number, gutter), line)),
    }));
  }
}
