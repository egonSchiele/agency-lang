// Compose styled text and fit it to fixed-width rows. Plain text displays
// braces literally and replaces ESC with ␛. Use paintAnsi for ANSI colors.
import { line } from "./builders.js";
import type { Element, Style } from "./elements.js";
import { escapeStyleTags, parseStyledText, type StyledSpan } from "./styleParser.js";

declare const paintedBrand: unique symbol;

/** Text prepared for the style parser by paint or paintAnsi. */
export type Painted = string & { readonly [paintedBrand]: true };

export type PaintStyle = { fg?: string; bg?: string; bold?: boolean; dim?: boolean };

export type Piece = { text: string; style?: PaintStyle };

export type SegmentOptions = { align?: "left" | "right"; style?: PaintStyle };

export const EMPTY = "" as Painted;

// Separate fragments so a trailing backslash cannot escape the next tag.
// The ANSI reset also prevents colors from leaking across fragments.
const STYLE_BOUNDARY = "\x1b[0m";
const ELLIPSIS = "…";

export function paint(text: string, style?: PaintStyle): Painted {
  const escaped = escapeStyleTags(text.replaceAll("\x1b", "␛"));
  const bounded = escaped.endsWith("\\") ? `${escaped}${STYLE_BOUNDARY}` : escaped;
  const wrapped = tagsFor(style).reduceRight((inner, tag) => `{${tag}}${inner}{/${tag}}`, bounded);
  return wrapped as Painted;
}

/** For text that already carries ANSI color, such as std::syntax output.
 * Braces are escaped; escape sequences are left for the parser to read. */
export function paintAnsi(text: string): Painted {
  return escapeStyleTags(text) as Painted;
}

export function joinPainted(...parts: Painted[]): Painted {
  return parts.join(STYLE_BOUNDARY) as Painted;
}

export function visibleWidth(content: Painted): number {
  const spans = parseStyledText(content);
  return spans.reduce((total, span) => total + span.text.length, 0);
}

/** Clip plain text to `width` cells with a trailing ellipsis. */
export function clipText(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (text.length <= width) {
    return text;
  }
  return `${text.slice(0, width - 1)}${ELLIPSIS}`;
}

export function padPainted(
  content: Painted,
  width: number,
  align: "left" | "right" = "left",
  style?: PaintStyle,
): Painted {
  const gap = Math.max(0, width - visibleWidth(content));
  const spaces = paint(" ".repeat(gap), style);
  return align === "right" ? joinPainted(spaces, content) : joinPainted(content, spaces);
}

/** Clip painted content by visible width, preserving its colors. */
export function clipPainted(content: Painted, width: number): Painted {
  if (visibleWidth(content) <= width) {
    return content;
  }
  return paintPieces(parseStyledText(content).map(spanToPiece), width);
}

/** Content flattened to one line, clipped or padded to exactly `width`.
 * A string and its padding receive `options.style`. Pieces carry their own
 * styles; `options.style` applies only to padding when content is pieces. */
export function segment(
  content: string | Piece[],
  width: number,
  options: SegmentOptions = {},
): Painted {
  if (width <= 0) {
    return EMPTY;
  }
  const pieces = typeof content === "string" ? [{ text: content, style: options.style }] : content;
  const oneLine = pieces.map((piece) => ({
    ...piece,
    text: piece.text.replace(/\r\n|[\r\n\t]/g, " "),
  }));
  return padPainted(paintPieces(oneLine, width), width, options.align, options.style);
}

export function paintedLine(content: Painted, style?: Style): Element {
  return line(content, style);
}

function spanToPiece(span: StyledSpan): Piece {
  const { text, ...style } = span;
  return { text, style };
}

function textLength(pieces: Piece[]): number {
  return pieces.reduce((total, piece) => total + piece.text.length, 0);
}

function paintPieces(pieces: Piece[], width: number): Painted {
  const total = textLength(pieces);
  let start = 0;
  const parts = pieces.map((piece) => {
    const shown = visiblePart(piece.text, width - start, total - start);
    start += piece.text.length;
    return { shown, style: piece.style };
  });
  const painted = parts
    .filter((part) => part.shown.length > 0)
    .map((part) => paint(part.shown, part.style));
  return joinPainted(...painted);
}

function visiblePart(text: string, room: number, remaining: number): string {
  if (room <= 0) {
    return "";
  }
  const everythingFits = remaining <= room;
  if (everythingFits || text.length < room) {
    return text;
  }
  return clipText(`${text}${ELLIPSIS}`, room);
}

function tagsFor(style: PaintStyle | undefined): string[] {
  if (style === undefined) {
    return [];
  }
  const candidates = [
    { tag: "dim", wanted: style.dim === true },
    { tag: "bold", wanted: style.bold === true },
    { tag: `${style.bg}-bg`, wanted: style.bg !== undefined },
    { tag: `${style.fg}-fg`, wanted: style.fg !== undefined },
  ];
  return candidates.filter((candidate) => candidate.wanted).map((candidate) => candidate.tag);
}
