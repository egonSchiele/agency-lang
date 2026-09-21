// Styled strings of a known visible width, escaped on the way in. Content
// from a statelog can contain `{bold}` or `{x-fg}`, which the style parser
// would swallow, and escaping changes a string's length without changing
// its width. Both problems are solved here so callers cannot hit either.
import { escapeStyleTags, parseStyledText } from "./styleParser.js";

declare const paintedBrand: unique symbol;

/** A string that is safe to hand to the style parser: its content was
 * escaped and any tags in it were written by this module. */
export type Painted = string & { readonly [paintedBrand]: true };

export type PaintStyle = { fg?: string; bg?: string; bold?: boolean; dim?: boolean };

export const EMPTY = "" as Painted;

// Parsed as zero-width ANSI reset. Tag-origin styles remain untouched.
const STYLE_BOUNDARY = "\x1b[0m";

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
