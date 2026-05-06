export type StyledSpan = {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
};

type StyleEntry =
  | { type: "bold" }
  | { type: "fg"; color: string }
  | { type: "bg"; color: string };

const TAG_RE = /(?<!\\)\{(\/?)([^}]+)(?<!\\)\}/g;

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
  if (a.type !== b.type) return false;
  if (a.type === "bold") return true;
  return (a as { color: string }).color === (b as { color: string }).color;
}

function parseTag(tag: string): StyleEntry | null {
  if (tag === "bold") return { type: "bold" };
  if (tag.endsWith("-fg")) return { type: "fg", color: tag.slice(0, -3) };
  if (tag.endsWith("-bg")) return { type: "bg", color: tag.slice(0, -3) };
  return null;
}

export function parseStyledText(input: string): StyledSpan[] {
  if (input === "") return [];

  const spans: StyledSpan[] = [];
  const stack: StyleEntry[] = [];
  let lastIndex = 0;

  TAG_RE.lastIndex = 0;
  let match;
  while ((match = TAG_RE.exec(input)) !== null) {
    const [fullMatch, isClosing, tagName] = match;

    // Text before this tag
    if (match.index > lastIndex) {
      const textBefore = input.slice(lastIndex, match.index);
      spans.push(makeSpan(textBefore, currentStyle(stack)));
    }

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
