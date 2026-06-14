import * as fs from "fs";
import type { EventEnvelope } from "./statelog/wireTypes.js";
import { extractEvalRecord, type ExtractOptions } from "./eval/extract.js";
import { normalize, type Normalized } from "./eval/normalize.js";
import type {
  ErrorEntry,
  EvalRecord,
  EvalValue,
  IncompleteInvocation,
  InterruptEntry,
  Metrics,
  NormalizedEvent,
  ThreadEntry,
} from "./eval/types.js";

export type StatelogParserOptions = ExtractOptions;

const SUPPORTED_VERSION = 1;

export type ParseError = {
  line: number;
  kind: "invalid_json" | "missing_fields" | "unsupported_version";
  detail: string;
};

// One kept event plus its 1-based source line. The line number is the stable
// identity for event nodes (`evt:<lineNo>`) and is what `lines()` yields.
type ParsedEvent = { event: EventEnvelope; lineNo: number };
type ParseResult = { events: ParsedEvent[]; errors: ParseError[] };

// Tolerant line-by-line JSONL parse. Malformed lines, unsupported
// `format_version`, and rows missing `trace_id`/`data.type` are collected as
// `ParseError`s rather than thrown, so the logs viewer can render a partial
// tree plus an error count. The eval path re-imposes strictness (see
// `evalRecord`). Folds in the validation that used to live in
// `lib/logsViewer/parse.ts`.
function parseStatelogText(text: string): ParseResult {
  const events: ParsedEvent[] = [];
  const errors: ParseError[] = [];
  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    if (raw.trim() === "") continue;
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      errors.push({ line: i + 1, kind: "invalid_json", detail: (e as Error).message });
      continue;
    }
    const rawVersion = obj.format_version;
    // Missing format_version is treated as a legacy v1 file. Present-but-non-
    // numeric is rejected so the EventEnvelope.format_version invariant holds.
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
      errors.push({ line: i + 1, kind: "missing_fields", detail: "missing trace_id or data.type" });
      continue;
    }
    events.push({
      event: {
        format_version: version,
        trace_id: obj.trace_id,
        project_id: obj.project_id ?? "",
        span_id: obj.span_id ?? null,
        parent_span_id: obj.parent_span_id ?? null,
        data: obj.data,
      },
      lineNo: i + 1,
    });
  }
  return { events, errors };
}

export class StatelogParser {
  private readonly parsed: ParseResult;
  private normalizedCache?: Normalized;
  private evalRecordCache?: EvalRecord;

  // The ONLY constructor. Both factories funnel through it, so there is a
  // single place where text / filePath / parsed are established together.
  private constructor(
    text: string,
    private readonly filePath: string | null,
    private readonly options: StatelogParserOptions = {},
  ) {
    this.parsed = parseStatelogText(text);
  }

  static fromFile(filePath: string, options: StatelogParserOptions = {}): StatelogParser {
    return new StatelogParser(fs.readFileSync(filePath, "utf-8"), filePath, options);
  }

  static fromString(jsonl: string, options: StatelogParserOptions = {}): StatelogParser {
    return new StatelogParser(jsonl, null, options);
  }

  // Iterable (not Array) to honor the streaming-ready contract — a future
  // indexed backend can yield without materializing the whole file.
  *events(): Iterable<EventEnvelope> {
    for (const p of this.parsed.events) yield p.event;
  }

  parseErrors(): ParseError[] {
    return this.parsed.errors;
  }

  normalized(): Normalized {
    if (!this.normalizedCache) {
      const events = this.parsed.events.map((p) => p.event);
      assertSingleTrace(events);
      this.normalizedCache = normalize(events);
    }
    return this.normalizedCache;
  }

  evalRecord(): EvalRecord {
    // Preserve the pre-refactor strict behavior: eval refuses to operate on a
    // file with any malformed lines (the old readAllEventsSync threw outright).
    if (this.parseErrors().length > 0) {
      const first = this.parseErrors()[0];
      throw new Error(`Malformed statelog on line ${first.line}: ${first.detail}`);
    }
    if (!this.evalRecordCache) {
      const events = this.parsed.events.map((p) => p.event);
      assertSingleTrace(events);
      this.evalRecordCache = extractEvalRecord(events, this.filePath ?? "<string>", this.options);
    }
    return this.evalRecordCache;
  }

  evalInputs(): EvalValue[] {
    return this.evalRecord().evalInputs;
  }

  evalOutputs(): EvalValue[] {
    return this.evalRecord().evalOutputs;
  }

  finalEvalOutput(): EvalValue | null {
    return this.evalOutputs().at(-1) ?? null;
  }

  threads(): ThreadEntry[] {
    return this.evalRecord().threads;
  }

  normalizedEvents(): NormalizedEvent[] {
    return this.evalRecord().events;
  }

  interrupts(): InterruptEntry[] {
    return this.evalRecord().interrupts;
  }

  errors(): ErrorEntry[] {
    return this.evalRecord().errors;
  }

  incompleteInvocations(): IncompleteInvocation[] {
    return this.evalRecord().incomplete;
  }

  metrics(): Metrics {
    return this.evalRecord().metrics;
  }

  warnings(): string[] {
    return this.evalRecord().warnings;
  }
}

function assertSingleTrace(events: EventEnvelope[]): void {
  const traceIds: Record<string, true> = {};
  for (const event of events) {
    traceIds[event.trace_id] = true;
  }
  const ids = Object.keys(traceIds);
  if (ids.length > 1) {
    throw new Error(
      `extract: multiple trace_ids in input (${ids.join(", ")}). Exactly one trace per file is supported.`,
    );
  }
}
