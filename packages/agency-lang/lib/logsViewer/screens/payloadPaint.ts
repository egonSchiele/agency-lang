import { syntaxHighlight } from "../../stdlib/syntax.js";
import { joinPainted, paint, paintAnsi, type Painted } from "../../tui/paint.js";
import { parseStyledText } from "../../tui/styleParser.js";
import type { PayloadLine } from "../payload.js";
import { THEME } from "../theme.js";
import { wrapLine } from "../wrapLine.js";

export function paintPayload(lines: PayloadLine[], width: number): Painted[] {
  return lines.flatMap((line) => paintPayloadLine(line, Math.max(1, width)));
}
function paintPayloadLine(line: PayloadLine, width: number): Painted[] {
  if (line.kind === "blank") {
    return [paint("")];
  }
  if (line.kind === "code") {
    const indent = Math.min(line.indent ?? 0, Math.max(0, width - 1));
    return syntaxHighlight(escapeControls(line.text), line.language)
      .split("\n")
      .flatMap((text) => wrapCodeLine(text, width - indent, indent));
  }
  let foreground: string = THEME.text;
  if (line.kind === "heading") {
    foreground = line.tone === "chrome" ? THEME.chrome : THEME.kind[line.tone];
  }
  if (line.kind === "meta") {
    foreground = THEME.muted;
  }
  if (line.kind === "text" && line.role === "error") {
    foreground = THEME.kind.error;
  }
  const indent = line.kind === "text" ? Math.min(line.indent, Math.max(0, width - 1)) : 0;
  return escapeControls(line.text)
    .split("\n")
    .flatMap((text) =>
      wrapLine(text, width - indent).map((part) =>
        paint(" ".repeat(indent) + part, { fg: foreground, bold: line.kind === "heading" }),
      ),
    );
}

function escapeControls(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, (character) =>
    JSON.stringify(character).slice(1, -1),
  );
}

function wrapCodeLine(text: string, width: number, indent: number): Painted[] {
  const output: Painted[] = [];
  const padding = paint(" ".repeat(indent));
  let parts: Painted[] = [padding];
  let used = 0;
  for (const span of parseStyledText(paintAnsi(text))) {
    for (let offset = 0; offset < span.text.length;) {
      const count = Math.min(width - used, span.text.length - offset);
      parts.push(paint(span.text.slice(offset, offset + count), span));
      used += count;
      offset += count;
      if (used === width) {
        output.push(joinPainted(...parts));
        parts = [padding];
        used = 0;
      }
    }
  }
  if (used > 0 || output.length === 0) {
    output.push(joinPainted(...parts));
  }
  return output;
}
