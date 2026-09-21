// Styled strings of a known visible width, escaped on the way in. Content
// from a statelog can contain `{bold}` or `{x-fg}`, which the style parser
// would swallow, and escaping changes a string's length without changing
// its width. Both problems are solved here so callers cannot hit either.
import { line } from "./builders.js";
import type { Element, Style } from "./elements.js";
import { escapeStyleTags, parseStyledText, type StyledSpan } from "./styleParser.js";

declare const paintedBrand: unique symbol;

/** A string that is safe to hand to the style parser: its content was
 * escaped and any tags in it were written by this module. */
export type Painted = string & { readonly [paintedBrand]: true };

export type PaintStyle = { fg?: string; bg?: string; bold?: boolean; dim?: boolean };

export type Piece = { text: string; style?: PaintStyle };

export type SegmentOptions = { align?: "left" | "right"; style?: PaintStyle };

export const EMPTY = "" as Painted;

// Parsed as zero-width ANSI reset. Tag-origin styles remain untouched.
const STYLE_BOUNDARY = "\x1b[0m";
const ELLIPSIS = "…";

export function paint(text: string, style?: PaintStyle): Painted {
  const escaped = escapeStyleTags(text);
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
): Painted {
  const gap = Math.max(0, width - visibleWidth(content));
  const spaces = " ".repeat(gap) as Painted;
  return align === "right" ? joinPainted(spaces, content) : joinPainted(content, spaces);
}

/** Clip already-painted content by visible width. It is parsed into
 * styled spans and painted again, so colors survive the cut. */
export function clipPainted(content: Painted, width: number): Painted {
  if (visibleWidth(content) <= width) {
    return content;
  }
  return paintPieces(parseStyledText(content).map(spanToPiece), width);
}

/** Content flattened to one line, clipped or padded to exactly `width`.
 * A string receives `options.style`. Pieces carry their own styles, and a
 * piece without a style remains unstyled even when `options.style` is set. */
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
  return padPainted(paintPieces(oneLine, width), width, options.align);
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

/** Paint each piece with the part of it that fits. */
function paintPieces(pieces: Piece[], width: number): Painted {
  const total = textLength(pieces);
  const parts = pieces.map((piece, position) => {
    const start = textLength(pieces.slice(0, position));
    const shown = visiblePart(piece.text, width - start, total - start);
    return { shown, style: piece.style };
  });
  const painted = parts
    .filter((part) => part.shown.length > 0)
    .map((part) => paint(part.shown, part.style));
  return joinPainted(...painted);
}

/** Return the part that fits, marking either shape of overflow. */
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

/** The tags a style needs, outermost first. */
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
