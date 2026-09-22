export type StructuredLine = {
  indent: number;
  role: "key" | "text" | "scalar" | "index";
  text: string;
};
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
    return value.flatMap((item, position) => [
      { indent, role: "index" as const, text: `[${position}]` },
      ...valueLines(item, indent + 2),
    ]);
  }
  if (value !== null && typeof value === "object" && Object.keys(value).length > 0) {
    return Object.entries(value).flatMap(([key, item]) => [
      { indent, role: "key" as const, text: key },
      ...valueLines(item, indent + 2),
    ]);
  }
  return [{ indent, role: "scalar", text: JSON.stringify(value) ?? String(value) }];
}
