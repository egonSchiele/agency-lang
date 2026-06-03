// std::layout — text layout renderer.
//
// Two layers (see docs/superpowers/specs/2026-06-02-layout-module-design.md):
//   * Agency-side (stdlib/layout.agency) — pure data construction.
//   * TS-side (this file)                — pure render.
//
// All ANSI awareness lives in `visualWidth`; nothing else in this file
// touches escape sequences directly.

const CSI_RE = /\x1b\[[\d;]*[A-Za-z]/g;

function visualWidth(s: string): number {
  return s.replace(CSI_RE, "").length;
}

function stripAnsi(s: string): string {
  return s.replace(CSI_RE, "");
}

export type Style = {
  fgColor?: string;
  bgColor?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
};

export type Align = "start" | "center" | "end";

const NAMED_COLORS: Record<string, [number, number, number]> = {
  black:        [0, 0, 0],
  red:          [205, 49, 49],
  green:        [13, 188, 121],
  yellow:       [229, 229, 16],
  blue:         [36, 114, 200],
  magenta:      [188, 63, 188],
  cyan:         [17, 168, 205],
  white:        [229, 229, 229],
  gray:         [128, 128, 128],
  grey:         [128, 128, 128],
  orange:       [204, 122, 74],
  brightred:    [241, 76, 76],
  brightgreen:  [35, 209, 139],
  brightyellow: [245, 245, 67],
  brightblue:   [59, 142, 234],
  brightmagenta:[214, 112, 214],
  brightcyan:   [41, 184, 219],
  brightwhite:  [229, 229, 229],
};

function colorToRgb(c: string): [number, number, number] | null {
  if (!c) return null;
  if (c.startsWith("#")) {
    const hex = c.slice(1);
    const h = hex.length === 3
      ? hex.split("").map(ch => ch + ch).join("")
      : hex;
    if (h.length !== 6) return null;
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return null;
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }
  const rgb = NAMED_COLORS[c.toLowerCase()];
  return rgb ?? null;
}

function sgr(style: Style): string {
  const parts: number[] = [];
  if (style.bold)      parts.push(1);
  if (style.dim)       parts.push(2);
  if (style.italic)    parts.push(3);
  if (style.underline) parts.push(4);
  const fg = style.fgColor ? colorToRgb(style.fgColor) : null;
  if (fg) parts.push(38, 2, fg[0], fg[1], fg[2]);
  const bg = style.bgColor ? colorToRgb(style.bgColor) : null;
  if (bg) parts.push(48, 2, bg[0], bg[1], bg[2]);
  if (parts.length === 0) return "";
  return `\x1b[${parts.join(";")}m`;
}

const RESET = "\x1b[0m";

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

function padLine(line: string, w: number, align: Align = "start"): string {
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

export type BorderStyle = "rounded" | "heavy" | "double" | "light";

type BorderChars = {
  tl: string; tr: string; bl: string; br: string;
  h: string;  v: string;
};

const BORDER_CHARS: Record<BorderStyle, BorderChars> = {
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  heavy:   { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
  double:  { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
  light:   { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
};

const warnedUnknownStyles = new Set<string>();
function resolveBorderStyle(s: string | undefined): BorderStyle {
  if (s == null || s === "") return "rounded";
  if (s in BORDER_CHARS) return s as BorderStyle;
  if (!warnedUnknownStyles.has(s)) {
    warnedUnknownStyles.add(s);
    console.warn(
      `std::layout: unknown borderStyle "${s}"; falling back to "light"`,
    );
  }
  return "light";
}

export type BorderOpts = {
  borderStyle?: string;
  borderColor?: string;
  padding?: number;
  title?: string;
  titleColor?: string;
};

export function bordered(block: Block, opts: BorderOpts): Block {
  const ch = BORDER_CHARS[resolveBorderStyle(opts.borderStyle)];
  const padding = opts.padding ?? 0;
  const inner = padding > 0
    ? pad(
        block,
        block.width + 2 * padding,
        block.height + 2 * padding,
        "center",
        "center",
      )
    : block;
  let w = inner.width;

  const titleText = opts.title ?? "";
  // Top edge is `tl + h*N + " Title " + h*M + tr`. We want at least one `h`
  // on each side of the title, so the inner width `w` must be ≥
  // visualWidth(title) + 4 (`h` + ` title ` + `h`).
  if (titleText !== "") {
    const minW = visualWidth(titleText) + 4;
    if (minW > w) {
      const hAlign: Align = padding > 0 ? "center" : "start";
      const grown = pad(inner, minW, inner.height, hAlign, "start");
      return _frame(grown, ch, grown.width, opts, titleText);
    }
  }
  return _frame(inner, ch, w, opts, titleText);
}

function _frame(
  inner: Block,
  ch: BorderChars,
  w: number,
  opts: BorderOpts,
  titleText: string,
): Block {
  const borderStyle: Style = opts.borderColor
    ? { fgColor: opts.borderColor }
    : {};
  const titleStyle: Style = opts.titleColor
    ? { fgColor: opts.titleColor }
    : {};
  const borderStart = sgr(borderStyle);
  const borderEnd   = borderStart === "" ? "" : RESET;
  const wrap = (s: string) => borderStart + s + borderEnd;

  let top: string;
  if (titleText === "") {
    top = wrap(ch.tl + ch.h.repeat(w) + ch.tr);
  } else {
    const titleStart = sgr(titleStyle);
    const titleEnd   = titleStart === "" ? "" : RESET;
    const titleSegment = titleStart + " " + titleText + " " + titleEnd;
    const titleW = visualWidth(titleSegment);
    // Layout: tl ─ <title> ──...── tr
    const after = w - 1 - titleW;
    top =
      wrap(ch.tl + ch.h) +
      titleSegment +
      wrap(ch.h.repeat(Math.max(0, after)) + ch.tr);
  }
  const bottom = wrap(ch.bl + ch.h.repeat(w) + ch.br);
  const sides = inner.lines.map(l =>
    wrap(ch.v) + padLine(l, w, "start") + wrap(ch.v),
  );
  return Block.of([top, ...sides, bottom]);
}

// --- Node tree + renderers ----------------------------------------

export type NodeType =
  | "box" | "row" | "column"
  | "text" | "raw" | "space" | "hline" | "vline";

export type LayoutNode = {
  type: NodeType;
  attrs: Record<string, unknown>;
  children: LayoutNode[];
};

function styleOf(attrs: Record<string, unknown>): Style {
  const s: Style = {};
  if (typeof attrs.fgColor === "string"  && attrs.fgColor)  s.fgColor  = attrs.fgColor;
  if (typeof attrs.bgColor === "string"  && attrs.bgColor)  s.bgColor  = attrs.bgColor;
  if (attrs.bold      === true) s.bold      = true;
  if (attrs.italic    === true) s.italic    = true;
  if (attrs.dim       === true) s.dim       = true;
  if (attrs.underline === true) s.underline = true;
  return s;
}

const RENDERERS: Record<NodeType, (n: LayoutNode) => Block> = {
  text: (n) => {
    const content = (n.attrs.content as string) ?? "";
    return styled(Block.of(content), styleOf(n.attrs));
  },
  raw: (n) => {
    const content = (n.attrs.content as string) ?? "";
    return Block.of(content);
  },
  space: (_n) => {
    throw new Error(
      "std::layout: `space` must be resolved by its parent row/column. " +
      "Found one outside a container at render time.",
    );
  },
  hline: (n) => {
    const length = n.attrs.length as number | undefined;
    if (length == null || length === 0) {
      throw new Error(
        "std::layout: bare `hline()` (no `length`) must be resolved by " +
        "its parent column. Found one outside a container at render time.",
      );
    }
    const char = (n.attrs.char as string) ?? "─";
    return styled(Block.of(char.repeat(length)), styleOf(n.attrs));
  },
  vline: (n) => {
    const length = n.attrs.length as number | undefined;
    if (length == null || length === 0) {
      throw new Error(
        "std::layout: bare `vline()` (no `length`) must be resolved by " +
        "its parent row. Found one outside a container at render time.",
      );
    }
    const char = (n.attrs.char as string) ?? "│";
    return styled(Block.of(Array(length).fill(char)), styleOf(n.attrs));
  },
  row:    (n) => composeRow(n),
  column: (n) => composeColumn(n),
  box:    (n) => composeBox(n),
};

function composeBox(node: LayoutNode): Block {
  const inner: LayoutNode = node.children.length === 1
    ? node.children[0]
    : { type: "column", attrs: {}, children: node.children };
  const innerBlock = node.children.length === 0
    ? Block.empty()
    : RENDERERS[inner.type](inner);
  return bordered(innerBlock, {
    title:       node.attrs.title       as string | undefined,
    titleColor:  node.attrs.titleColor  as string | undefined,
    borderStyle: node.attrs.borderStyle as string | undefined,
    borderColor: node.attrs.borderColor as string | undefined,
    padding:     node.attrs.padding     as number | undefined,
  });
}

function composeRow(node: LayoutNode): Block {
  if (node.children.length === 0) return Block.empty();
  const resolved = resolveDynamicChildren(node.children, "row");
  const gap   = (node.attrs.gap   as number) ?? 0;
  const align = (node.attrs.align as Align)  ?? "start";
  const blocks = resolved.map(c => RENDERERS[c.type](c));
  const h = blocks.reduce((m, b) => Math.max(m, b.height), 0);
  const aligned = blocks.map(b => pad(b, b.width, h, "start", align));
  const gapBlock = gap > 0
    ? Block.of(" ".repeat(gap))
    : null;
  return aligned.reduce<Block>((acc, b, i) => {
    if (i === 0) return b;
    return gapBlock ? beside(beside(acc, gapBlock), b) : beside(acc, b);
  }, Block.empty());
}

function composeColumn(node: LayoutNode): Block {
  if (node.children.length === 0) return Block.empty();
  const resolved = resolveDynamicChildren(node.children, "column");
  const gap   = (node.attrs.gap   as number) ?? 0;
  const align = (node.attrs.align as Align)  ?? "start";
  const blocks = resolved.map(c => RENDERERS[c.type](c));
  const w = blocks.reduce((m, b) => Math.max(m, b.width), 0);
  const aligned = blocks.map(b => pad(b, w, b.height, align, "start"));
  const gapBlock = gap > 0
    ? Block.of(Array(gap).fill(""))
    : null;
  return aligned.reduce<Block>((acc, b, i) => {
    if (i === 0) return b;
    return gapBlock ? above(above(acc, gapBlock), b) : above(acc, b);
  }, Block.empty());
}

function resolveDynamicChildren(
  children: LayoutNode[],
  axis: "row" | "column",
): LayoutNode[] {
  // First pass — render every concrete (non-dynamic) child to measure the
  // cross-axis size needed by stretchy lines.
  const isDynamic = (c: LayoutNode): boolean => {
    if (c.type === "space") return true;
    if (axis === "row"    && c.type === "vline" &&
        (c.attrs.length == null || c.attrs.length === 0)) return true;
    if (axis === "column" && c.type === "hline" &&
        (c.attrs.length == null || c.attrs.length === 0)) return true;
    return false;
  };
  const concreteBlocks = children
    .filter(c => !isDynamic(c))
    .map(c => RENDERERS[c.type](c));
  const cross = axis === "row"
    ? Math.max(1, ...concreteBlocks.map(b => b.height))
    : Math.max(1, ...concreteBlocks.map(b => b.width));

  return children.map(c => {
    if (axis === "row" && c.type === "vline" &&
        (c.attrs.length == null || c.attrs.length === 0)) {
      return { ...c, attrs: { ...c.attrs, length: cross } };
    }
    if (axis === "column" && c.type === "hline" &&
        (c.attrs.length == null || c.attrs.length === 0)) {
      return { ...c, attrs: { ...c.attrs, length: cross } };
    }
    if (c.type === "space") {
      const n = (c.attrs.count as number) ?? 1;
      return axis === "row"
        ? {
            type: "raw" as NodeType,
            attrs: { content: " ".repeat(n) },
            children: [],
          }
        : {
            type: "raw" as NodeType,
            attrs: { content: Array(n).fill("").join("\n") },
            children: [],
          };
    }
    return c;
  });
}

export function renderNode(node: LayoutNode): Block {
  const renderer = RENDERERS[node.type];
  if (!renderer) {
    throw new Error(`std::layout: unknown node type "${node.type}"`);
  }
  return renderer(node);
}

export function render(node: LayoutNode): string {
  return renderNode(node).toString();
}

export function _render(node: LayoutNode, color: "auto" | boolean): string {
  const useColor = color === "auto"
    ? process.stdout.isTTY === true
    : color === true;
  const out = render(node);
  return useColor ? out : stripAnsi(out);
}

// Internal exports for tests only.
export const _internal = {
  visualWidth, sgr, padLine, stripAnsi, colorToRgb,
  BORDER_CHARS, resolveBorderStyle,
  styleOf, RENDERERS,
};
