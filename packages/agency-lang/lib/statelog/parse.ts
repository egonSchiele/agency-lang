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

/** What one line of a statelog holds: an event, a reason it is not one, or
 *  nothing at all. */
export type ParsedStatelogLine =
  | { kind: "event"; entry: ParsedEventLine }
  | { kind: "error"; error: ParseError }
  | { kind: "blank" };

/** The one owner of statelog line decoding: JSON, version check, envelope
 *  validation. Callers that need the original bytes (per-trace digests,
 *  extracting a trace verbatim) read `entry.raw`. */
export function parseStatelogLine(raw: string, lineNumber: number): ParsedStatelogLine {
  if (raw.trim() === "") {
    return { kind: "blank" };
  }
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch (e) {
    return {
      kind: "error",
      error: { line: lineNumber, kind: "invalid_json", detail: (e as Error).message },
    };
  }
  const checked = checkStatelogRecord(record);
  if ("error" in checked) {
    return { kind: "error", error: { line: lineNumber, ...checked.error } };
  }
  return { kind: "event", entry: { event: checked.event, raw, line: lineNumber } };
}

/** Lines of a statelog in file order, the first of them numbered
 *  `firstLineNumber`. Blank lines are skipped but still counted. */
export function parseStatelogLines(
  lines: readonly string[],
  firstLineNumber: number,
): ParseWithLinesResult {
  const parsedLines: ParsedEventLine[] = [];
  const errors: ParseError[] = [];
  lines.forEach((raw, index) => {
    const parsed = parseStatelogLine(raw, firstLineNumber + index);
    if (parsed.kind === "event") {
      parsedLines.push(parsed.entry);
    } else if (parsed.kind === "error") {
      errors.push(parsed.error);
    }
  });
  return { lines: parsedLines, errors };
}

/** Statelog records that are already decoded, such as the logs a statelog
 *  server returns, checked the way a line from a file is. Record `i` is
 *  reported as line `i + 1`. */
export function parseStatelogRecords(records: readonly unknown[]): ParseResult {
  const events: EventEnvelope[] = [];
  const errors: ParseError[] = [];
  records.forEach((record, index) => {
    const checked = checkStatelogRecord(record);
    if ("error" in checked) {
      errors.push({ line: index + 1, ...checked.error });
    } else {
      events.push(checked.event);
    }
  });
  return { events, errors };
}

/** Statelog text, for tests and callers that already hold it. A file is read
 *  line by line through `makeLineReader` instead. */
export function parseStatelogJsonl(text: string): ParseResult {
  const parsed = parseStatelogJsonlWithLines(text);
  return { events: parsed.lines.map((entry) => entry.event), errors: parsed.errors };
}

export function parseStatelogJsonlWithLines(text: string): ParseWithLinesResult {
  return parseStatelogLines(text.split("\n"), 1);
}

type CheckedRecord = { event: EventEnvelope } | { error: Omit<ParseError, "line"> };

function checkStatelogRecord(record: unknown): CheckedRecord {
  const obj = (record ?? {}) as Record<string, any>;
  const rawVersion = obj.format_version;
  // Missing format_version is treated as a legacy v1 file.
  // Anything present-but-non-numeric is rejected so the
  // EventEnvelope.format_version: number invariant holds.
  if (rawVersion !== undefined && typeof rawVersion !== "number") {
    return {
      error: {
        kind: "unsupported_version",
        detail: `format_version must be a number, got ${typeof rawVersion}`,
      },
    };
  }
  const version: number = rawVersion ?? 1;
  if (version > SUPPORTED_VERSION) {
    return {
      error: {
        kind: "unsupported_version",
        detail: `format_version ${version} > ${SUPPORTED_VERSION}`,
      },
    };
  }
  if (!obj.trace_id || !obj.data || typeof obj.data.type !== "string") {
    return { error: { kind: "missing_fields", detail: "missing trace_id or data.type" } };
  }
  return {
    event: {
      format_version: version,
      trace_id: obj.trace_id,
      project_id: obj.project_id ?? "",
      span_id: obj.span_id ?? null,
      parent_span_id: obj.parent_span_id ?? null,
      data: obj.data,
    },
  };
}
