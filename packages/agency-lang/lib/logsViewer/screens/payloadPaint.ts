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
  if (line.faded) {
    return paintPayloadLine({ ...line, faded: false }, width).map((painted) =>
      paint(
        parseStyledText(painted)
          .map((span) => span.text)
          .join(""),
        { fg: THEME.muted },
      ),
    );
  }
  if (line.kind === "blank") {
    return [paint("")];
  }
  if (line.kind === "code") {
    const indent = Math.min(line.indent ?? 0, Math.max(0, width - 1));
    return syntaxHighlight(escapeControls(line.text), line.language)
      .split("\n")
      .flatMap((text) => wrapCodeLine(text, width - indent, indent));
  }
  if (line.kind === "pair") {
    return paintPair(line.key, line.text, line.indent, width);
  }
  if (line.kind === "table") {
    return paintTable(line, width);
  }
  let foreground: string = THEME.text;
  if (line.kind === "heading") {
    foreground = HEADING_COLORS[line.tone];
  }
  if (line.kind === "meta") {
    foreground = THEME.muted;
  }
  if (line.kind === "text" && line.role === "error") {
    foreground = THEME.kind.error;
  }
  if (line.kind === "text" && line.role === "key") {
    foreground = THEME.key;
  }
  const indent = line.kind === "text" ? Math.min(line.indent, Math.max(0, width - 1)) : 0;
  const text = escapeControls(line.text);
  const rows = line.oneRow
    ? [firstRow(text, width - indent)]
    : text.split("\n").flatMap((part) => wrapLine(part, width - indent));
  return rows.map((row) =>
    paint(" ".repeat(indent) + row, { fg: foreground, bold: line.kind === "heading" }),
  );
}

/** What fits on one row, ending in an ellipsis when the rest was cut. */
function firstRow(text: string, width: number): string {
  const [first] = text.split("\n");
  if (wrapLine(first, width).length <= 1 && first === text) {
    return first;
  }
  return wrapLine(first, Math.max(1, width - 1))[0] + "…";
}

/** `key: value` with the key in its own color; a wrapped value continues
 *  at the key's indent. */
function paintPair(key: string, value: string, indent: number, width: number): Painted[] {
  const inset = Math.min(indent, Math.max(0, width - 1));
  const label = `${escapeControls(key)}:`;
  const parts = wrapLine(`${label} ${escapeControls(value)}`, width - inset);
  return parts.map((part, position) => {
    const padding = " ".repeat(inset);
    if (position === 0 && part.startsWith(label)) {
      return joinPainted(
        paint(padding + label, { fg: THEME.key }),
        paint(part.slice(label.length), { fg: THEME.text }),
      );
    }
    return paint(padding + part, { fg: THEME.text });
  });
}

const TABLE_GAP = 2;

/** Rows under a header when they fit the width; otherwise each row as an
 *  index and its fields, the shape a mixed list gets. */
function paintTable(line: Extract<PayloadLine, { kind: "table" }>, width: number): Painted[] {
  const columns = line.columns.map(escapeControls);
  const rows = line.rows.map((row) => row.map(escapeControls));
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => row[index].length)),
  );
  const total =
    line.indent + widths.reduce((sum, w) => sum + w, 0) + TABLE_GAP * (widths.length - 1);
  if (total > width) {
    return rows.flatMap((row, position) => [
      paint(" ".repeat(line.indent) + `[${position}]`, { fg: THEME.text }),
      ...row.flatMap((cell, index) => paintPair(columns[index], cell, line.indent + 2, width)),
    ]);
  }
  const padded = (cells: string[]) =>
    " ".repeat(line.indent) +
    cells
      .map((cell, index) => cell.padEnd(widths[index]))
      .join(" ".repeat(TABLE_GAP))
      .trimEnd();
  return [
    paint(padded(columns), { fg: THEME.key }),
    ...rows.map((row) => paint(padded(row), { fg: THEME.text })),
  ];
}

const HEADING_COLORS: Record<Extract<PayloadLine, { kind: "heading" }>["tone"], string> = {
  ...THEME.kind,
  chrome: THEME.chrome,
  accent: THEME.accent,
};

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
