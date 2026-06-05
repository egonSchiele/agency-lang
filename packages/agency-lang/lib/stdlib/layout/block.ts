// std::layout — `Block` primitive + algebra (pad / beside / above / styled).
//
// A `Block` is a rectangular array of lines. All composition in
// std::layout reduces to four operators:
//   * `pad`     — widen / heighten a block, aligning original content
//   * `beside`  — concatenate two blocks horizontally
//   * `above`   — stack two blocks vertically
//   * `styled`  — wrap each line with an SGR start + RESET
// Width is always measured via `visualWidth`, so ANSI sequences do
// not perturb layout arithmetic.

import { RESET, Style, sgr, visualWidth } from "./ansi.js";

export type Align = "start" | "center" | "end";

export class Block {
  readonly lines: readonly string[];
  private constructor(lines: readonly string[]) {
    this.lines = lines;
  }
  static empty(): Block { return new Block([]); }
  static of(content: string | string[]): Block {
    if (typeof content === "string") {
      return new Block(content.split("\n"));
    }
    return new Block(content.slice());
  }
  get height(): number { return this.lines.length; }
  get width(): number {
    let w = 0;
    for (const line of this.lines) {
      const lw = visualWidth(line);
      if (lw > w) w = lw;
    }
    return w;
  }
  toString(): string { return this.lines.join("\n"); }
}

export function padLine(line: string, w: number, align: Align = "start"): string {
  const lw = visualWidth(line);
  if (lw >= w) return line;
  const extra = w - lw;
  switch (align) {
    case "start":  return line + " ".repeat(extra);
    case "end":    return " ".repeat(extra) + line;
    case "center": {
      const left  = Math.floor(extra / 2);
      const right = extra - left;
      return " ".repeat(left) + line + " ".repeat(right);
    }
  }
}

export function pad(
  block: Block,
  w: number,
  h: number,
  hAlign: Align = "start",
  vAlign: Align = "start",
): Block {
  const widened = block.lines.map(l => padLine(l, w, hAlign));
  if (widened.length >= h) return Block.of(widened);
  const emptyRow = " ".repeat(Math.max(w, block.width));
  const extra = h - widened.length;
  let lines: string[];
  switch (vAlign) {
    case "start":
      lines = [...widened, ...Array(extra).fill(emptyRow)];
      break;
    case "end":
      lines = [...Array(extra).fill(emptyRow), ...widened];
      break;
    case "center": {
      const top = Math.floor(extra / 2);
      const bot = extra - top;
      lines = [
        ...Array(top).fill(emptyRow),
        ...widened,
        ...Array(bot).fill(emptyRow),
      ];
      break;
    }
  }
  return Block.of(lines);
}

export function styled(block: Block, style: Style): Block {
  const start = sgr(style);
  if (start === "") return block;
  return Block.of(block.lines.map(l => start + l + RESET));
}

export function beside(left: Block, right: Block): Block {
  if (left.lines.length === 0) return right;
  if (right.lines.length === 0) return left;
  const h = Math.max(left.height, right.height);
  const lp = pad(left,  left.width,  h, "start", "start").lines;
  const rp = pad(right, right.width, h, "start", "start").lines;
  return Block.of(lp.map((l, i) => l + rp[i]));
}

export function above(top: Block, bottom: Block): Block {
  if (top.lines.length === 0) return bottom;
  if (bottom.lines.length === 0) return top;
  const w = Math.max(top.width, bottom.width);
  const tp = pad(top,    w, top.height,    "start", "start").lines;
  const bp = pad(bottom, w, bottom.height, "start", "start").lines;
  return Block.of([...tp, ...bp]);
}
