export function heading(level: number, text: string): string {
  return `${"#".repeat(level)} ${text}`;
}

export function codeFence(code: string, lang: string = "ts"): string {
  const matches = code.match(/`+/g) ?? [];
  const longest = matches.reduce((m, s) => Math.max(m, s.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${code.trimEnd()}\n${fence}`;
}

export function bold(text: string): string {
  return `**${text}**`;
}

export function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function markdownTable(
  headers: string[],
  rows: string[][],
): string {
  const headerRow = `| ${headers.join(" | ")} |`;
  const separator = `|${headers.map(() => "---").join("|")}|`;
  const dataRows = rows.map(
    (row) => `| ${row.map(escapeTableCell).join(" | ")} |`,
  );
  return [headerRow, separator, ...dataRows].join("\n");
}

export function section(...parts: (string | null | false | undefined)[]): string {
  return parts.filter(Boolean).join("\n\n");
}
