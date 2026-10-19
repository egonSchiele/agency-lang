// A payload as plain text, for the CLI and for anything else that reads a
// row outside the terminal. `PayloadLine` is already structured data, so
// this is one case per kind and needs no layout width; going through the
// frame renderer would wrap at whatever width it was laid out at.
import type { PayloadLine } from "./payload.js";

const INDENT = "  ";

export function payloadText(lines: readonly PayloadLine[]): string {
  return lines.flatMap(lineText).join("\n");
}

function lineText(line: PayloadLine): string[] {
  switch (line.kind) {
    case "heading":
      return [line.text];
    case "meta":
      return [line.text];
    case "rule":
      return [`── ${line.text} ──`];
    case "text":
      return line.text.split("\n").map((part) => INDENT.repeat(line.indent) + part);
    case "pair":
      return [`${INDENT.repeat(line.indent)}${line.key}: ${line.text}`];
    case "table": {
      const pad = INDENT.repeat(line.indent);
      return [
        `${pad}${line.columns.join(" | ")}`,
        ...line.rows.map((row) => `${pad}${row.join(" | ")}`),
      ];
    }
    case "code":
      return line.text.split("\n").map((part) => INDENT.repeat(line.indent ?? 0) + part);
    case "json":
      return [line.text];
    case "charts":
      // Bars drawn in cells; nothing to say in text.
      return [];
    case "blank":
      return [""];
  }
}
