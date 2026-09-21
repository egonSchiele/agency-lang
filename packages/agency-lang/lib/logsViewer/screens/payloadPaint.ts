import { syntaxHighlight } from "../../stdlib/syntax.js";
import { clipPainted, paint, paintAnsi, type Painted } from "../../tui/paint.js";
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
    return syntaxHighlight(escapeControls(line.text), line.language)
      .split("\n")
      .map((text) => clipPainted(paintAnsi(text), width));
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
