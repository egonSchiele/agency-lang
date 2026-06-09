// std::layout — ANSI / SGR primitives.
//
// All ANSI awareness in std::layout lives here. The Block / border /
// table layers below treat strings as opaque, measure them with
// `visualWidth`, and only emit escape sequences via `sgr` (or by
// asking `stripAnsi` to remove them).

const CSI_RE = /\x1b\[[\d;]*[A-Za-z]/g;
const CSI_TOKEN_RE = /\x1b\[[\d;]*[A-Za-z]/y;

export function visualWidth(s: string): number {
  return s.replace(CSI_RE, "").length;
}

export function stripAnsi(s: string): string {
  return s.replace(CSI_RE, "");
}

export function wrapText(content: string, width: number): string[] {
  if (width <= 0) return [];
  return content.split("\n").flatMap((line) => wrapSingleLine(line, width));
}

function wrapSingleLine(line: string, width: number): string[] {
  if (line === "") return [""];
  if (visualWidth(line) <= width) return [line.trimEnd()];

  const tokens = line.split(/(\s+)/);
  const out: string[] = [];
  let current = "";

  for (const token of tokens) {
    if (token === "") continue;
    const tentative = current + token;
    if (visualWidth(tentative) <= width) {
      current = tentative;
      continue;
    }
    if (current.trim().length > 0) {
      out.push(current.trimEnd());
      current = "";
    }
    if (token.trim().length === 0) {
      continue;
    }
    if (visualWidth(token) <= width) {
      current = token;
      continue;
    }
    const chunks = breakLongToken(token, width);
    out.push(...chunks.slice(0, -1));
    current = chunks[chunks.length - 1] ?? "";
  }

  if (current.length > 0) out.push(current.trimEnd());
  return out;
}

function breakLongToken(token: string, width: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentWidth = 0;
  let index = 0;

  while (index < token.length) {
    CSI_TOKEN_RE.lastIndex = index;
    const escape = CSI_TOKEN_RE.exec(token);
    if (escape && escape.index === index) {
      current += escape[0];
      index = CSI_TOKEN_RE.lastIndex;
      continue;
    }

    const char = token[index];
    if (currentWidth >= width) {
      chunks.push(current);
      current = "";
      currentWidth = 0;
    }
    current += char;
    currentWidth += 1;
    index += 1;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

export type Style = {
  fgColor?: string;
  bgColor?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
};

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

export function colorToRgb(c: string): [number, number, number] | null {
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
// CSI (`\x1b[`) and the `m` terminator. `FG_24BIT` and `BG_24BIT` are
// extended sequences: prefix code, color-space `2` (24-bit RGB), then
// three R/G/B bytes.
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

const CSI     = "\x1b[";
const SGR_END = "m";
export const RESET = `${CSI}${SGR.RESET}${SGR_END}`;

export function sgr(style: Style): string {
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

// Apply a styled-string wrapper: returns a function that wraps any
// substring with the given SGR start + RESET. When the start sequence
// is empty (no styling configured), wrapping is a no-op — no spurious
// `\x1b[m` (which is a RESET on some terminals).
export function styledWrapper(style: Style): (s: string) => string {
  const startSeq = sgr(style);
  if (startSeq === "") return (s) => s;
  return (s) => startSeq + s + RESET;
}
