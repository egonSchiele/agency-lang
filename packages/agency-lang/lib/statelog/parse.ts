import { EventEnvelope } from "./wireTypes.js";

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

/** One validated event together with the exact line it came from. */
export type ParsedEventLine = {
  event: EventEnvelope;
  raw: string;
  /** One-based line number in the source text. */
  line: number;
};

export type ParseWithLinesResult = {
  lines: ParsedEventLine[];
  errors: ParseError[];
};

export function parseStatelogJsonl(text: string): ParseResult {
  const parsed = parseStatelogJsonlWithLines(text);
  return { events: parsed.lines.map((entry) => entry.event), errors: parsed.errors };
}

/** The one owner of statelog line decoding: JSON, version check, envelope
 *  validation. `parseStatelogJsonl` is this with the raw lines dropped;
 *  callers that need the original bytes (per-trace digests, extracting a trace
 *  verbatim) read `raw`. */
export function parseStatelogJsonlWithLines(text: string): ParseWithLinesResult {
  const parsedLines: ParsedEventLine[] = [];
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
    parsedLines.push({
      event: {
        format_version: version,
        trace_id: obj.trace_id,
        project_id: obj.project_id ?? "",
        span_id: obj.span_id ?? null,
        parent_span_id: obj.parent_span_id ?? null,
        data: obj.data,
      },
      raw,
      line: i + 1,
    });
  }
  return { lines: parsedLines, errors };
}
