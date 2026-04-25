export function heading(level: number, text: string): string {
  return `${"#".repeat(level)} ${text}`;
}

export function codeFence(code: string, lang: string = "ts"): string {
  return `\`\`\`${lang}\n${code}\n\`\`\``;
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
