import { EventEnvelope } from "./types.js";

const SUPPORTED_VERSION = 1;

export type ParseError = {
  line: number;
  kind: "invalid_json" | "missing_fields" | "unsupported_version";
  detail: string;
};

export type ParseResult = {
  events: EventEnvelope[];
  errors: ParseError[];
};

export function parseStatelogJsonl(text: string): ParseResult {
  const events: EventEnvelope[] = [];
  const errors: ParseError[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      errors.push({
        line: i + 1,
        kind: "invalid_json",
        detail: (e as Error).message,
      });
      continue;
    }
    const rawVersion = obj.format_version;
    // Missing format_version is treated as a legacy v1 file.
    // Anything present-but-non-numeric is rejected so the
    // EventEnvelope.format_version: number invariant holds.
    if (rawVersion !== undefined && typeof rawVersion !== "number") {
      errors.push({
        line: i + 1,
        kind: "unsupported_version",
        detail: `format_version must be a number, got ${typeof rawVersion}`,
      });
      continue;
    }
    const version: number = rawVersion ?? 1;
    if (version > SUPPORTED_VERSION) {
      errors.push({
        line: i + 1,
        kind: "unsupported_version",
        detail: `format_version ${version} > ${SUPPORTED_VERSION}`,
      });
      continue;
    }
    if (!obj.trace_id || !obj.data || typeof obj.data.type !== "string") {
      errors.push({
        line: i + 1,
        kind: "missing_fields",
        detail: "missing trace_id or data.type",
      });
      continue;
    }
    events.push({
      format_version: version,
      trace_id: obj.trace_id,
      project_id: obj.project_id ?? "",
      span_id: obj.span_id ?? null,
      parent_span_id: obj.parent_span_id ?? null,
      data: obj.data,
    });
  }
  return { events, errors };
}
