export type StyledSpan = {
  text: string;
  // Color is either a known palette name (e.g. "red", "bright-cyan") or a
  // hex string ("#rgb" or "#rrggbb"). The HTML and ANSI adapters know how
  // to render both forms.
  fg?: string;
  bg?: string;
  bold?: boolean;
};

type Origin = "tag" | "ansi";

type StyleEntry =
  | { type: "bold"; origin: Origin }
  | { type: "fg"; color: string; origin: Origin }
  | { type: "bg"; color: string; origin: Origin };

// Matches either a `{tag}` (not preceded by a backslash) or an ANSI SGR
// escape sequence `ESC[<params>m`. Tag bodies may not contain `}`, so an
// escaped `}` inside a tag body is not supported by design.
const TAG_PATTERN_SOURCE = String.raw`(?<!\\)\{(\/?)([^}]+)\}|\x1b\[([\d;]*)m`;
const TAG_FLAGS = "g";

// Map standard ANSI color codes (30-37, 40-47, 90-97, 100-107) to our
// palette names. Used when ANSI escapes are encountered in styled text.
const ANSI_FG_NAMES: Record<number, string> = {
  30: "black", 31: "red", 32: "green", 33: "yellow",
  34: "blue", 35: "magenta", 36: "cyan", 37: "white",
  90: "gray",
  91: "bright-red", 92: "bright-green", 93: "bright-yellow",
  94: "bright-blue", 95: "bright-magenta", 96: "bright-cyan",
  97: "bright-white",
};
const ANSI_BG_NAMES: Record<number, string> = {
  40: "black", 41: "red", 42: "green", 43: "yellow",
  44: "blue", 45: "magenta", 46: "cyan", 47: "white",
  100: "gray",
  101: "bright-red", 102: "bright-green", 103: "bright-yellow",
  104: "bright-blue", 105: "bright-magenta", 106: "bright-cyan",
  107: "bright-white",
};

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function removeWhere(stack: StyleEntry[], pred: (e: StyleEntry) => boolean): void {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (pred(stack[i])) stack.splice(i, 1);
  }
}

/**
 * Apply a sequence of ANSI SGR codes to the style stack in-place. ANSI
 * codes only modify ANSI-origin entries: resets and color-defaults will
 * not clobber styles applied via `{tag}` syntax.
 *
 * Recognized codes:
 *   0       — reset (clears all ANSI-origin entries)
 *   1       — bold
 *   22      — bold off (clears all ANSI-origin bold entries)
 *   30-37   — standard fg color
 *   38;5;N  — 256-color fg
 *   38;2;R;G;B — true-color fg
 *   39      — default fg (clears all ANSI-origin fg entries, per spec)
 *   40-47   — standard bg color
 *   48;5;N  / 48;2;R;G;B — 256/true-color bg
 *   49      — default bg (clears all ANSI-origin bg entries)
 *   90-97, 100-107 — bright variants
 * Unknown or malformed codes are ignored.
 */
function applyAnsiCodes(stack: StyleEntry[], codes: number[]): void {
  // Empty parameters mean ESC[m which is equivalent to reset.
  if (codes.length === 0) {
    removeWhere(stack, (e) => e.origin === "ansi");
    return;
  }
  let i = 0;
  while (i < codes.length) {
    const code = codes[i];
    if (code === 0) {
      removeWhere(stack, (e) => e.origin === "ansi");
      i++;
    } else if (code === 1) {
      stack.push({ type: "bold", origin: "ansi" });
      i++;
    } else if (code === 22) {
      removeWhere(stack, (e) => e.origin === "ansi" && e.type === "bold");
      i++;
    } else if (code === 39) {
      removeWhere(stack, (e) => e.origin === "ansi" && e.type === "fg");
      i++;
    } else if (code === 49) {
      removeWhere(stack, (e) => e.origin === "ansi" && e.type === "bg");
      i++;
    } else if (code === 38 || code === 48) {
      const target: "fg" | "bg" = code === 38 ? "fg" : "bg";
      const mode = codes[i + 1];
      if (mode === 2) {
        // Need three additional params (R, G, B). If any are missing the
        // sequence is malformed; skip the whole introducer.
        if (codes.length < i + 5) {
          i = codes.length;
        } else {
          const color = rgbToHex(codes[i + 2], codes[i + 3], codes[i + 4]);
          stack.push({ type: target, color, origin: "ansi" });
          i += 5;
        }
      } else if (mode === 5) {
        // Need one additional param (palette index). Otherwise malformed.
        if (codes.length < i + 3) {
          i = codes.length;
        } else {
          stack.push({ type: target, color: xterm256ToHex(codes[i + 2]), origin: "ansi" });
          i += 3;
        }
      } else {
        // Unknown extended color form (or missing mode); skip rest of run.
        i = codes.length;
      }
    } else {
      const fgName = ANSI_FG_NAMES[code];
      const bgName = ANSI_BG_NAMES[code];
      if (fgName) stack.push({ type: "fg", color: fgName, origin: "ansi" });
      else if (bgName) stack.push({ type: "bg", color: bgName, origin: "ansi" });
      // Unknown codes are silently ignored.
      i++;
    }
  }
}

function xterm256ToHex(idx: number): string {
  if (idx < 16) {
    // Standard 16-color palette (approximate hex).
    const standard = [
      "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
      "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
    ];
    return standard[idx];
  }
  if (idx < 232) {
    // 6×6×6 color cube
    const i = idx - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const v = (n: number) => (n === 0 ? 0 : 55 + n * 40);
    return rgbToHex(v(r), v(g), v(b));
  }
  // Grayscale ramp
  const g = 8 + (idx - 232) * 10;
  return rgbToHex(g, g, g);
}

function currentStyle(stack: StyleEntry[]): Omit<StyledSpan, "text"> {
  const style: Omit<StyledSpan, "text"> = {};
  for (const entry of stack) {
    if (entry.type === "bold") style.bold = true;
    else if (entry.type === "fg") style.fg = entry.color;
    else if (entry.type === "bg") style.bg = entry.color;
  }
  return style;
}

function unescape(text: string): string {
  return text.replace(/\\([{}])/g, "$1");
}

function makeSpan(text: string, style: Omit<StyledSpan, "text">): StyledSpan {
  const span: StyledSpan = { text: unescape(text) };
  if (style.bold) span.bold = true;
  if (style.fg) span.fg = style.fg;
  if (style.bg) span.bg = style.bg;
  return span;
}

function matchesEntry(a: StyleEntry, b: StyleEntry): boolean {
  if (a.origin !== "tag") return false;
  if (a.type !== b.type) return false;
  if (a.type === "bold") return true;
  return (a as { color: string }).color === (b as { color: string }).color;
}

function parseTag(tag: string): StyleEntry | null {
  if (tag === "bold") return { type: "bold", origin: "tag" };
  if (tag.endsWith("-fg")) return { type: "fg", color: tag.slice(0, -3), origin: "tag" };
  if (tag.endsWith("-bg")) return { type: "bg", color: tag.slice(0, -3), origin: "tag" };
  return null;
}

export function parseStyledText(input: string): StyledSpan[] {
  if (input === "") return [];

  const spans: StyledSpan[] = [];
  const stack: StyleEntry[] = [];
  let lastIndex = 0;

  // Fresh regex per call; can't share a `g` regex because of `lastIndex` state.
  const tagRe = new RegExp(TAG_PATTERN_SOURCE, TAG_FLAGS);
  let match;
  while ((match = tagRe.exec(input)) !== null) {
    const [fullMatch, isClosing, tagName, ansiParams] = match;

    // Text before this tag
    if (match.index > lastIndex) {
      const textBefore = input.slice(lastIndex, match.index);
      spans.push(makeSpan(textBefore, currentStyle(stack)));
    }

    if (ansiParams !== undefined) {
      // ANSI SGR sequence — apply codes to the style stack.
      const codes = ansiParams === "" ? [] : ansiParams.split(";").map((p) => parseInt(p, 10) || 0);
      applyAnsiCodes(stack, codes);
    } else {
      const entry = parseTag(tagName);
      if (entry) {
        if (isClosing) {
          for (let i = stack.length - 1; i >= 0; i--) {
            if (matchesEntry(stack[i], entry)) {
              stack.splice(i, 1);
              break;
            }
          }
        } else {
          stack.push(entry);
        }
      } else {
        // Unrecognized tag — treat as literal text
        spans.push(makeSpan(fullMatch, currentStyle(stack)));
      }
    }

    lastIndex = match.index + fullMatch.length;
  }

  // Remaining text after last tag
  if (lastIndex < input.length) {
    spans.push(makeSpan(input.slice(lastIndex), currentStyle(stack)));
  }

  return spans;
}

export function escapeStyleTags(text: string): string {
  return text.replace(/[{}]/g, (ch) => `\\${ch}`);
}
