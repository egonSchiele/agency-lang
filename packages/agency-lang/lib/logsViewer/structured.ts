/** A role for a line that stands alone: a key or index whose value follows
 *  on the lines below it, one line of a multi-line string, or a bare value. */
export type FlatRole = "key" | "text" | "scalar" | "index";
export type StructuredLine =
  | { indent: number; role: FlatRole; text: string }
  /** A key with its value on the same line: `id: 1`. */
  | { indent: number; role: "pair"; key: string; text: string }
  /** A list whose items all have the same flat fields, as rows. */
  | { indent: number; role: "table"; columns: string[]; rows: string[][] };
export function decodeStructured(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
export function structuredLines(value: unknown): StructuredLine[] {
  return valueLines(value, 0);
}
function valueLines(value: unknown, indent: number): StructuredLine[] {
  if (typeof value === "string") {
    return value.split("\n").map((text) => ({ indent, role: "text", text }));
  }
  if (Array.isArray(value) && value.length > 0) {
    const table = tableOf(value);
    if (table !== undefined) {
      return [{ indent, role: "table", ...table }];
    }
    return value.flatMap((item, position) => entryLines(`[${position}]`, item, indent, "index"));
  }
  if (isRecord(value) && Object.keys(value).length > 0) {
    return Object.entries(value).flatMap(([key, item]) => entryLines(key, item, indent, "key"));
  }
  return [{ indent, role: "scalar", text: scalarText(value) }];
}
/** One field or item: on one line when its value is flat, else the label
 *  and the value indented beneath it. */
function entryLines(
  label: string,
  value: unknown,
  indent: number,
  role: "key" | "index",
): StructuredLine[] {
  if (isFlat(value)) {
    return [{ indent, role: "pair", key: label, text: scalarText(value) }];
  }
  return [{ indent, role, text: label }, ...valueLines(value, indent + 2)];
}
/** Longest JSON text of a list of plain values kept on its key's line. */
const SHORT_LIST_CHARS = 60;
/** A value that reads on one line: a one-line string, a number, a boolean,
 *  null, an empty list or object, or a short list of such values. */
function isFlat(value: unknown): boolean {
  if (typeof value === "string") {
    return !value.includes("\n");
  }
  if (Array.isArray(value)) {
    return value.every(isPrimitive) && JSON.stringify(value).length <= SHORT_LIST_CHARS;
  }
  if (isRecord(value)) {
    return Object.keys(value).length === 0;
  }
  return true;
}
function scalarText(value: unknown): string {
  if (typeof value === "string" && value !== "") {
    return value;
  }
  return JSON.stringify(value) ?? String(value);
}
function isPrimitive(value: unknown): boolean {
  if (typeof value === "string") {
    return !value.includes("\n");
  }
  return value === null || typeof value !== "object";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Two or more objects with the same flat fields become a table, one row
 *  each, so a list of todos reads across instead of four lines per item. */
function tableOf(items: unknown[]): { columns: string[]; rows: string[][] } | undefined {
  if (items.length < 2 || !isRecord(items[0])) {
    return undefined;
  }
  const columns = Object.keys(items[0]);
  if (columns.length === 0) {
    return undefined;
  }
  const shape = [...columns].sort().join("\u0000");
  const rows: string[][] = [];
  for (const item of items) {
    if (!isRecord(item) || Object.keys(item).sort().join("\u0000") !== shape) {
      return undefined;
    }
    const cells = columns.map((column) => item[column]);
    if (cells.some((cell) => !isFlat(cell))) {
      return undefined;
    }
    rows.push(cells.map(scalarText));
  }
  return { columns, rows };
}
