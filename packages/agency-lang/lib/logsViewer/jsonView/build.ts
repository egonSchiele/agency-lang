import { JsonNode, LONG_STRING_THRESHOLD } from "./types.js";

// Walk the JSON value once and produce a tree of JsonNodes. Each node
// gets a deterministic path string derived from how we reached it
// (`$.usage.inputTokens`, `$[0]`, ...). The path is used by the
// renderer as the key into the "open" set, so it must stay stable
// across rebuilds.
export function buildJsonTree(value: unknown, path = "$"): JsonNode {
  if (value === null) {
    return { kind: "primitive", path, valueType: "null", raw: "null" };
  }
  if (typeof value === "string") {
    if (isLongString(value)) {
      return { kind: "longString", path, raw: value };
    }
    return {
      kind: "primitive",
      path,
      valueType: "string",
      raw: JSON.stringify(value),
    };
  }
  if (typeof value === "number") {
    return {
      kind: "primitive",
      path,
      valueType: "number",
      raw: formatNumber(value),
    };
  }
  if (typeof value === "boolean") {
    return {
      kind: "primitive",
      path,
      valueType: "boolean",
      raw: value ? "true" : "false",
    };
  }
  if (Array.isArray(value)) {
    return {
      kind: "array",
      path,
      items: value.map((item, i) => buildJsonTree(item, `${path}[${i}]`)),
    };
  }
  // Object — preserve insertion order via Object.entries.
  return {
    kind: "object",
    path,
    entries: Object.entries(value as Record<string, unknown>).map(
      ([key, child]) => ({
        key,
        child: buildJsonTree(child, `${path}.${key}`),
      }),
    ),
  };
}

export function isLongString(s: string): boolean {
  if (s.includes("\n")) return true;
  return s.length > LONG_STRING_THRESHOLD;
}

// Print numbers as JSON would. Avoid Number.toString()'s exponential
// notation for very small/large floats — match what `JSON.stringify`
// produces for parity with the on-wire format.
function formatNumber(n: number): string {
  if (Number.isNaN(n) || !Number.isFinite(n)) return "null";
  return JSON.stringify(n);
}
