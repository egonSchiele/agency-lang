// std::layout — border framing.
//
// Wraps a Block with corner / edge characters from a `BorderStyle`,
// optionally embedding a title in the top edge (Claude-Code style:
// `╭─ Title ───╮`). Title-driven width growth lives here too so
// callers (box, table) get consistent sizing.

import { Style, styledWrapper, visualWidth, wrapText } from "./ansi.js";
import { Align, Block, above, pad, padLine, styled } from "./block.js";

export type BorderStyle = "rounded" | "heavy" | "double" | "light";

export type BorderChars = {
  // Corners + edges of the outer frame.
  tl: string; tr: string; bl: string; br: string;
  h:  string; v:  string;
  // Junction chars for horizontal section dividers crossing vertical
  // column dividers (`cross`) or the outer side borders (`leftTee` /
  // `rightTee`). Rounded shares its interior with light, so they use
  // the same junctions.
  cross:     string;
  leftTee:   string;
  rightTee:  string;
};

export const BORDER_CHARS: Record<BorderStyle, BorderChars> = {
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│",
             cross: "┼", leftTee: "├", rightTee: "┤" },
  heavy:   { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃",
             cross: "╋", leftTee: "┣", rightTee: "┫" },
  double:  { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║",
             cross: "╬", leftTee: "╠", rightTee: "╣" },
  light:   { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│",
             cross: "┼", leftTee: "├", rightTee: "┤" },
};

const warnedUnknownStyles = new Set<string>();
export function resolveBorderStyle(s: string | undefined): BorderStyle {
  if (s == null || s === "") return "rounded";
  // `Object.hasOwn` (not `in`) so we don't traverse the prototype
  // chain — otherwise `"__proto__" in BORDER_CHARS` is truthy and
  // would hand back `Object.prototype` to the renderer, which crashes
  // on the missing `.tl` / `.tr` fields.
  if (Object.hasOwn(BORDER_CHARS, s)) return s as BorderStyle;
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
  targetWidth?: number;
};

// Number of cells a single `│`-style side border takes (one on each
// side, so a framed box is `BORDER_CELLS` wider than its inner content).
export const BORDER_CELLS = 2;

// Minimum inner width required to fit a title embedded in the top edge.
// The top edge is `tl + h + " Title " + h*N + tr` — so we need at least
// one `h` before the title, the title text plus two spaces of padding,
// and one `h` after. That's `1 + (titleLen + 2) + 1 = titleLen + 4`.
const TITLE_BORDER_OVERHEAD = 4;

export function minWidthForTitle(titleText: string): number {
  return visualWidth(titleText) + TITLE_BORDER_OVERHEAD;
}

// Decide how to render a title given a fixed inner width.
//
// When the title fits on the top edge (`╭─ Title ───╮`), it goes there.
// When it would overflow, it wraps inside the frame as its own block of
// rows, and the top edge is drawn plain. This is the rule both `box`
// (via `bordered`) and `table` (via `composeTable`) use, so it lives
// here as a single source of truth.
export type TitlePlacement =
  | { kind: "top"; title: string }
  | { kind: "wrapped"; block: Block };

export function placeTitle(
  title: string,
  innerWidth: number,
  titleStyle: Style,
): TitlePlacement {
  if (title === "" || minWidthForTitle(title) <= innerWidth) {
    return { kind: "top", title };
  }
  return {
    kind: "wrapped",
    block: styled(Block.of(wrapText(title, innerWidth)), titleStyle),
  };
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
  const padded      = withPaddingApplied(block, padding);

  if (opts.targetWidth !== undefined) {
    const innerWidth = Math.max(0, opts.targetWidth - BORDER_CELLS);
    const titleStyle: Style = opts.titleColor ? { fgColor: opts.titleColor } : {};
    const placement = placeTitle(titleText, innerWidth, titleStyle);
    const titleBlock = placement.kind === "wrapped" ? placement.block : Block.empty();
    const topTitle   = placement.kind === "top"     ? placement.title : "";
    const content = above(titleBlock, padded);
    const inner = pad(content, innerWidth, content.height, "start", "start");
    return frameWithBorder(inner, borderChars, innerWidth, opts, topTitle);
  }

  const inner = titleText !== "" ? growToFitTitle(padded, titleText, padding) : padded;
  return frameWithBorder(inner, borderChars, inner.width, opts, titleText);
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
export function buildTopEdge(
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
