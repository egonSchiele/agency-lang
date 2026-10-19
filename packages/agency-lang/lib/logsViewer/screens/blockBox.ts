// A transcript block drawn as a box: a top rule carrying its title and
// stats, its lines between side bars, and a bottom rule. The active box
// takes heavy rules and a background, so it reads with and without color.
import { joinPainted, paint, segment, type Painted, type Piece } from "../../tui/paint.js";
import { parseStyledText } from "../../tui/styleParser.js";
import { THEME } from "../theme.js";

export type BoxSpec = {
  title: string;
  /** Right-aligned on the top rule, faded: `22.0s · 20k in · $0.0034`. */
  stats: string;
  /** The rule and title color: the block's kind color. */
  color: string;
  /** Cells of indent before the box, one step per level of tool depth. */
  indent: number;
  active: boolean;
  /** Whether to draw side bars. A narrow pane keeps only the rules. */
  sides: boolean;
};

const RULES = {
  light: { top: "┌", bottom: "└", rule: "─", topEnd: "┐", bottomEnd: "┘", side: "│" },
  heavy: { top: "┏", bottom: "┗", rule: "━", topEnd: "┓", bottomEnd: "┛", side: "┃" },
};
/** Below this many cells of text the side bars go, to keep room for words. */
export const SIDES_MIN_WIDTH = 60;
/** Cells the side bars and their padding take from the text. */
export const SIDES_WIDTH = 4;

/** How wide the text inside a box of `width` cells may be. */
export function boxInnerWidth(width: number, spec: Pick<BoxSpec, "indent" | "sides">): number {
  return Math.max(1, width - spec.indent - (spec.sides ? SIDES_WIDTH : 0));
}

/** Paint `body` lines, already wrapped to `boxInnerWidth`, into a box of
 *  `width` cells. */
export function boxLines(body: Painted[], width: number, spec: BoxSpec): Painted[] {
  const glyph = spec.active ? RULES.heavy : RULES.light;
  const bg = spec.active ? THEME.cursorBg : undefined;
  const margin = paint(" ".repeat(spec.indent));
  const span = width - spec.indent;
  const inner = boxInnerWidth(width, spec);
  const corner = (open: string, close: string): [Painted, Painted] =>
    spec.sides
      ? [paint(open, { fg: spec.color, bg }), paint(close, { fg: spec.color, bg })]
      : [paint("", { bg }), paint("", { bg })];
  const [topOpen, topClose] = corner(glyph.top, glyph.topEnd);
  const [bottomOpen, bottomClose] = corner(glyph.bottom, glyph.bottomEnd);
  const rule = `${glyph.rule}${glyph.rule}`;
  const title: Piece[] = [
    { text: `${glyph.rule} `, style: { fg: spec.color, bg } },
    { text: spec.title, style: { fg: spec.color, bg, bold: true } },
    { text: " ", style: { fg: spec.color, bg } },
  ];
  const stats: Piece[] = spec.stats
    ? [
        { text: " ", style: { bg } },
        { text: spec.stats, style: { fg: THEME.muted, bg } },
        { text: ` ${rule}`, style: { fg: spec.color, bg } },
      ]
    : [];
  const ends = spec.sides ? 2 : 0;
  const titleWidth = Math.max(0, span - ends - pieceWidth(stats));
  const top = joinPainted(
    margin,
    topOpen,
    fillRule(title, titleWidth, glyph.rule, spec.color, bg),
    segment(stats, Math.min(pieceWidth(stats), Math.max(0, span - ends)), { style: { bg } }),
    topClose,
  );
  const sideOpen = spec.sides ? paint(`${glyph.side} `, { fg: spec.color, bg }) : paint("");
  const sideClose = spec.sides ? paint(` ${glyph.side}`, { fg: spec.color, bg }) : paint("");
  const rows = body.map((line) =>
    joinPainted(margin, sideOpen, withBackground(line, inner, bg), sideClose),
  );
  const bottom = joinPainted(
    margin,
    bottomOpen,
    paint(glyph.rule.repeat(Math.max(0, span - ends)), { fg: spec.color, bg }),
    bottomClose,
  );
  return [top, ...rows, bottom];
}

/** The title pieces, then the rule out to `width`. */
function fillRule(
  pieces: Piece[],
  width: number,
  rule: string,
  color: string,
  bg: string | undefined,
): Painted {
  const shown = segment(pieces, Math.min(width, pieceWidth(pieces)), { style: { bg } });
  const rest = Math.max(0, width - pieceWidth(pieces));
  return joinPainted(shown, paint(rule.repeat(rest), { fg: color, bg }));
}
function pieceWidth(pieces: Piece[]): number {
  return pieces.reduce((total, piece) => total + piece.text.length, 0);
}
/** A painted line padded to `width`, every span and the padding on `bg`;
 *  a span that has a background of its own keeps it. */
export function withBackground(line: Painted, width: number, bg: string | undefined): Painted {
  const pieces: Piece[] = parseStyledText(line).map(({ text, ...style }) => ({
    text,
    style: { ...style, bg: style.bg ?? bg },
  }));
  return segment(pieces, width, { style: { bg } });
}
