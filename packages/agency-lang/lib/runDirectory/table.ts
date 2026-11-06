import { ttyColor } from "@/utils/termcolors.js";

/** A plain left-aligned text table: header row, then rows, columns padded to
 *  the widest cell. The header is painted (bold cyan on a terminal, plain
 *  when piped) AFTER padding, so the paint never disturbs alignment. For CLI
 *  listings, not the interactive explorer. */
export function formatTextTable(
  header: string[],
  rows: string[][],
  paintHeader: (text: string) => string = ttyColor.cyan.bold,
): string {
  const all = [header, ...rows];
  const widths = header.map((_, column) =>
    Math.max(...all.map((row) => (row[column] ?? "").length)),
  );
  const line = (row: string[]): string =>
    row
      .map((cell, column) => (cell ?? "").padEnd(widths[column]))
      .join("  ")
      .trimEnd();
  return [paintHeader(line(header)), ...rows.map(line)].join("\n");
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
