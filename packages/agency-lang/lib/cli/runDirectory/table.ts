/** A plain left-aligned text table: header row, then rows, columns padded to
 *  the widest cell. For CLI listings, not the interactive explorer. */
export function formatTextTable(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, column) =>
    Math.max(...all.map((row) => (row[column] ?? "").length)),
  );
  return all
    .map((row) =>
      row
        .map((cell, column) => (cell ?? "").padEnd(widths[column]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
