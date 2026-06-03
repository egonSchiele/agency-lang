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

// SGR (Select Graphic Rendition) parameter numbers from the ANSI/ECMA-48
// spec. Each one toggles a single styling attribute when emitted between
// CSI (`\x1b[`) and the `m` terminator. `SGR_FG_24BIT` and `SGR_BG_24BIT`
// are extended sequences: prefix code, color-space `2` (24-bit RGB),
// then three R/G/B bytes.
const SGR = {
  RESET:     0,
  BOLD:      1,
  DIM:       2,
  ITALIC:    3,
  UNDERLINE: 4,
  FG_24BIT:  38,
  BG_24BIT:  48,
  RGB_SPACE: 2,
} as const;

const CSI    = "\x1b[";
const SGR_END = "m";
const RESET  = `${CSI}${SGR.RESET}${SGR_END}`;

function sgr(style: Style): string {
  const codes: number[] = [];
  if (style.bold)      codes.push(SGR.BOLD);
  if (style.dim)       codes.push(SGR.DIM);
  if (style.italic)    codes.push(SGR.ITALIC);
  if (style.underline) codes.push(SGR.UNDERLINE);

  const fgRgb = style.fgColor ? colorToRgb(style.fgColor) : null;
  if (fgRgb) codes.push(SGR.FG_24BIT, SGR.RGB_SPACE, ...fgRgb);

  const bgRgb = style.bgColor ? colorToRgb(style.bgColor) : null;
  if (bgRgb) codes.push(SGR.BG_24BIT, SGR.RGB_SPACE, ...bgRgb);

  if (codes.length === 0) return "";
  return `${CSI}${codes.join(";")}${SGR_END}`;
}

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
  // Typed as the literal union so callers passing untyped JSON still
  // type-check through the surface; `resolveBorderStyle` provides the
  // runtime guard for values that slip in via `as` casts.
  borderStyle?: BorderStyle;
  borderColor?: string;
  padding?: number;
  title?: string;
  titleColor?: string;
};

// Minimum inner width required to fit a title embedded in the top edge.
// The top edge is `tl + h + " Title " + h*N + tr` — so we need at least
// one `h` before the title, the title text plus two spaces of padding,
// and one `h` after. That's `1 + (titleLen + 2) + 1 = titleLen + 4`.
const TITLE_BORDER_OVERHEAD = 4;

function minWidthForTitle(titleText: string): number {
  return visualWidth(titleText) + TITLE_BORDER_OVERHEAD;
}

// Grow `inner` horizontally so a title can fit. Padded children stay
// centred; unpadded children stay left-aligned (their visual anchor).
function growToFitTitle(inner: Block, titleText: string, padding: number): Block {
  const needed = minWidthForTitle(titleText);
  if (needed <= inner.width) return inner;
  const hAlign: Align = padding > 0 ? "center" : "start";
  return pad(inner, needed, inner.height, hAlign, "start");
}

function withPaddingApplied(block: Block, padding: number): Block {
  if (padding <= 0) return block;
  return pad(
    block,
    block.width  + 2 * padding,
    block.height + 2 * padding,
    "center",
    "center",
  );
}

export function bordered(block: Block, opts: BorderOpts): Block {
  const borderChars = BORDER_CHARS[resolveBorderStyle(opts.borderStyle)];
  const padding     = opts.padding ?? 0;
  const titleText   = opts.title   ?? "";

  const padded = withPaddingApplied(block, padding);
  const inner  = titleText !== "" ? growToFitTitle(padded, titleText, padding) : padded;

  return frameWithBorder(inner, borderChars, inner.width, opts, titleText);
}

// Apply a styled-string wrapper: returns a function that wraps any
// substring with the given SGR start + RESET. When the start sequence
// is empty (no styling configured), wrapping is a no-op — no spurious
// `\x1b[m` (which is a RESET on some terminals).
function styledWrapper(style: Style): (s: string) => string {
  const startSeq = sgr(style);
  if (startSeq === "") return (s) => s;
  return (s) => startSeq + s + RESET;
}

// Render the title segment that gets embedded in the top edge:
// `<title-style-start> Title <title-style-end>`. Returns both the
// segment string and its visual width (caller uses the width to know
// how much horizontal `h` it has to draw after the title).
function renderTitleSegment(
  titleText: string,
  titleStyle: Style,
): { segment: string; width: number } {
  const wrap = styledWrapper(titleStyle);
  const segment = wrap(` ${titleText} `);
  return { segment, width: visualWidth(segment) };
}

// Build the top edge of a bordered box, either plain or with a title
// embedded after one `h` segment (Claude-Code style).
function buildTopEdge(
  ch: BorderChars,
  innerWidth: number,
  wrapBorder: (s: string) => string,
  titleText: string,
  titleStyle: Style,
): string {
  if (titleText === "") {
    return wrapBorder(ch.tl + ch.h.repeat(innerWidth) + ch.tr);
  }
  const { segment, width: titleWidth } = renderTitleSegment(titleText, titleStyle);
  // Layout: `tl + h + <title> + h*remaining + tr`. The leading single
  // `h` separates the corner from the title; `remaining` fills the
  // rest. innerWidth covers everything between the corners.
  const remaining = Math.max(0, innerWidth - 1 - titleWidth);
  return (
    wrapBorder(ch.tl + ch.h) +
    segment +
    wrapBorder(ch.h.repeat(remaining) + ch.tr)
  );
}

function frameWithBorder(
  inner: Block,
  ch: BorderChars,
  innerWidth: number,
  opts: BorderOpts,
  titleText: string,
): Block {
  const borderStyle: Style = opts.borderColor ? { fgColor: opts.borderColor } : {};
  const titleStyle:  Style = opts.titleColor  ? { fgColor: opts.titleColor  } : {};
  const wrapBorder = styledWrapper(borderStyle);

  const topEdge    = buildTopEdge(ch, innerWidth, wrapBorder, titleText, titleStyle);
  const bottomEdge = wrapBorder(ch.bl + ch.h.repeat(innerWidth) + ch.br);
  const bodyRows   = inner.lines.map((line) =>
    wrapBorder(ch.v) + padLine(line, innerWidth, "start") + wrapBorder(ch.v),
  );

  return Block.of([topEdge, ...bodyRows, bottomEdge]);
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
  // Single-child box uses that child directly; multi-child (or empty)
  // wraps in an implicit column. `composeColumn([])` already returns
  // `Block.empty()`, so no separate empty-children branch is needed.
  const inner: LayoutNode = node.children.length === 1
    ? node.children[0]
    : { type: "column", attrs: {}, children: node.children };
  return bordered(renderNode(inner), {
    title:       node.attrs.title       as string | undefined,
    titleColor:  node.attrs.titleColor  as string | undefined,
    borderStyle: node.attrs.borderStyle as BorderStyle | undefined,
    borderColor: node.attrs.borderColor as string | undefined,
    padding:     node.attrs.padding     as number | undefined,
  });
}

// --- Axis composition ----------------------------------------------
//
// `row` and `column` are symmetric: each lays its children out along a
// "main axis" (left-to-right / top-to-bottom) and aligns short children
// in the "cross axis" (vertical / horizontal). The differences are all
// captured in `AXIS_OPS` below; the actual compose / render logic is
// shared.

type Axis = "row" | "column";

// Per-axis bundle of "how does this axis differ from the other one":
//   * which leaf node type stretches (vline in row, hline in column)
//   * how to measure cross-axis size from a block
//   * how to align a block in the cross axis
//   * the join operator to concatenate aligned blocks
//   * how to render a `space(n)` leaf to a Block on this axis
type AxisOps = {
  stretchyType: "vline" | "hline";
  crossSize:    (b: Block) => number;
  alignCross:   (b: Block, cross: number, align: Align) => Block;
  join:         (a: Block, b: Block) => Block;
  spaceBlock:   (count: number) => Block;
};

const AXIS_OPS: Record<Axis, AxisOps> = {
  row: {
    stretchyType: "vline",
    crossSize:    (b) => b.height,
    alignCross:   (b, h, align) => pad(b, b.width, h, "start", align),
    join:         beside,
    spaceBlock:   (count) => Block.of(" ".repeat(count)),
  },
  column: {
    stretchyType: "hline",
    crossSize:    (b) => b.width,
    alignCross:   (b, w, align) => pad(b, w, b.height, align, "start"),
    join:         above,
    spaceBlock:   (count) => Block.of(Array(count).fill("")),
  },
};

function maxOf<T>(items: T[], pick: (item: T) => number, floor: number): number {
  return items.reduce((acc, item) => Math.max(acc, pick(item)), floor);
}

function isStretchyLine(child: LayoutNode, axis: Axis): boolean {
  if (child.type !== AXIS_OPS[axis].stretchyType) return false;
  const explicitLength = child.attrs.length;
  return explicitLength == null || explicitLength === 0;
}

function isDynamic(child: LayoutNode, axis: Axis): boolean {
  return child.type === "space" || isStretchyLine(child, axis);
}

function renderDynamicChild(
  child: LayoutNode,
  axis: Axis,
  crossSize: number,
): Block {
  if (isStretchyLine(child, axis)) {
    return renderNode({ ...child, attrs: { ...child.attrs, length: crossSize } });
  }
  // `space(count)`: `count` columns wide inside a row, `count` empty
  // rows inside a column.
  const count = (child.attrs.count as number) ?? 1;
  return AXIS_OPS[axis].spaceBlock(count);
}

// Render every child of an axis container exactly once, resolving
// stretchy lines and `space` nodes against the cross-axis size of the
// concrete siblings.
function renderChildrenAlongAxis(children: LayoutNode[], axis: Axis): Block[] {
  // First pass: render every concrete child; leave `null` placeholders
  // for the dynamic ones (we need their indices to keep source order).
  const concreteBlocks: (Block | null)[] = children.map((child) =>
    isDynamic(child, axis) ? null : renderNode(child),
  );

  // Measure cross-axis size from the concrete blocks only. Floor at 1
  // so an all-dynamic row (e.g. `row { r.vline() }`) still renders.
  const measured = concreteBlocks.filter((b): b is Block => b !== null);
  const crossSize = maxOf(measured, AXIS_OPS[axis].crossSize, 1);

  // Second pass: fill in the dynamic blocks using the measured size.
  return children.map((child, index) => {
    const pre = concreteBlocks[index];
    if (pre !== null) return pre;
    return renderDynamicChild(child, axis, crossSize);
  });
}

// Interleave a gap block between consecutive children (skipped when
// `gapBlock` is null). Used by `composeAxis` to add `row`/`column` `gap`.
function joinWithGap(
  blocks: Block[],
  gapBlock: Block | null,
  join: (a: Block, b: Block) => Block,
): Block {
  return blocks.reduce<Block>((accumulated, block, index) => {
    if (index === 0) return block;
    const withGap = gapBlock ? join(accumulated, gapBlock) : accumulated;
    return join(withGap, block);
  }, Block.empty());
}

function composeAxis(node: LayoutNode, axis: Axis): Block {
  if (node.children.length === 0) return Block.empty();

  const gapCells   = (node.attrs.gap   as number) ?? 0;
  const childAlign = (node.attrs.align as Align)  ?? "start";
  const ops        = AXIS_OPS[axis];

  const rendered  = renderChildrenAlongAxis(node.children, axis);
  const crossSize = maxOf(rendered, ops.crossSize, 0);
  const aligned   = rendered.map((b) => ops.alignCross(b, crossSize, childAlign));

  const gapBlock = gapCells > 0 ? ops.spaceBlock(gapCells) : null;
  return joinWithGap(aligned, gapBlock, ops.join);
}

function composeRow(node: LayoutNode):    Block { return composeAxis(node, "row"); }
function composeColumn(node: LayoutNode): Block { return composeAxis(node, "column"); }

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

// "auto" color resolution follows the de-facto ecosystem convention:
//   * `NO_COLOR` set (any value)         → disable, no matter what.
//   * `FORCE_COLOR` set to a truthy value → enable, no matter what.
//   * otherwise                           → enable iff stdout is a TTY.
//
// `process.stdout.isTTY` alone is unreliable when Agency runs through
// nested spawns (`pnpm run agency …` spawns the CLI which spawns the
// compiled script); some intermediate hops can drop the TTY flag even
// when the user is at an interactive terminal. The env-var fallbacks
// give the user explicit overrides.
function _autoUseColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0" && force !== "false") {
    return true;
  }
  return process.stdout.isTTY === true;
}

export function _render(node: LayoutNode, color: "auto" | boolean): string {
  const useColor = color === "auto" ? _autoUseColor() : color === true;
  const out = render(node);
  return useColor ? out : stripAnsi(out);
}

// Internal exports for tests only.
export const _internal = {
  visualWidth, sgr, padLine, stripAnsi, colorToRgb,
  BORDER_CHARS, resolveBorderStyle,
  styleOf, RENDERERS,
};
