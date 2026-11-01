import * as fs from "fs";

import { makeLineReader } from "@/statelog/lineReader.js";
import {
  parseStatelogLine,
  parseStatelogLines,
  type ParsedEventLine,
  type ParseError,
  type ParseWithLinesResult,
} from "@/statelog/parse.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";
import { canonicalize } from "@/utils/canonicalize.js";
import { sha256Text } from "@/utils/hash.js";

/** One trace: every event sharing a `trace_id`, in file order, with the raw
 *  lines it came from and a digest of its content. */
export type Trace = {
  traceId: string;
  events: EventEnvelope[];
  lines: string[];
  digest: string;
};

export type ReadTracesResult = { traces: Trace[]; errors: ParseError[] };

/** sha256 over the canonicalized events in order, so two serializations of the
 *  same events (different key order, different whitespace) share a digest. */
export function traceDigest(events: readonly EventEnvelope[]): string {
  return sha256Text(events.map((event) => canonicalize(event)).join("\n"));
}

/**
 * Read a statelog file into traces, grouped by `trace_id` in first-seen order.
 *
 * This is the many-trace, byte-preserving reader; `StatelogParser`
 * (lib/eval/statelogParser.ts) is the one-trace, one-file view for graders.
 * Both parse lines with `parseStatelogLine`, and a trace's eval record is
 * still `extractEvalRecord` (see `evalRecord.ts`). What is new here is only
 * grouping by id, keeping raw lines for merging, and the digest.
 *
 * The file is read one chunk of lines at a time, so its text is never one
 * string. A last line with no newline is kept when it is a complete event; one
 * that is not valid JSON is a write that was cut off, and is ignored. A line
 * byte-identical to one already seen for its trace is dropped: that is the
 * harmless result of `cat`-ing two copies of one trace. Nothing more is
 * checked here — two different streams sharing an id cannot be told apart once
 * concatenated; `mergeStatelog` refuses that while they are still separate.
 */
export function readTraces(statelogPath: string): ReadTracesResult {
  // The line reader reads a missing file as empty; a missing statelog is an
  // error here.
  fs.statSync(statelogPath);
  const reader = makeLineReader(statelogPath, 0);
  const grouper = makeTraceGrouper();
  const errors: ParseError[] = [];
  let lineCount = 0;
  reader.readToEnd((lines) => {
    addParsedLines(parseStatelogLines(lines, lineCount + 1), grouper, errors);
    lineCount += lines.length;
  });
  addLastLine(reader.tail(), lineCount + 1, grouper, errors);
  return { traces: grouper.traces(), errors };
}

/** For writers: a statelog with any unparseable line is refused whole, since a
 *  trace stored without its bad lines would look complete and be judged as
 *  such. Readers stay tolerant (`readTraces`). */
export function readTracesOrThrow(statelogPath: string): Trace[] {
  const { traces, errors } = readTraces(statelogPath);
  if (errors.length > 0) {
    const shown = errors
      .slice(0, 3)
      .map((error) => `line ${error.line}: ${error.kind} (${error.detail})`)
      .join("; ");
    const more = errors.length > 3 ? ` and ${errors.length - 3} more` : "";
    throw new Error(
      `Refusing to add ${statelogPath}: ${errors.length} line(s) could not be parsed as ` +
        `statelog events (${shown}${more}). Nothing was written.`,
    );
  }
  return traces;
}

export function tracesFromText(text: string): ReadTracesResult {
  const lines = text.split("\n");
  // The text after the last newline: empty when the text ends with one.
  const last = lines.pop();
  const grouper = makeTraceGrouper();
  const errors: ParseError[] = [];
  addParsedLines(parseStatelogLines(lines, 1), grouper, errors);
  addLastLine(last === "" ? undefined : last, lines.length + 1, grouper, errors);
  return { traces: grouper.traces(), errors };
}

type TraceGrouper = {
  add(entry: ParsedEventLine): void;
  traces(): Trace[];
};

type TraceGroup = { events: EventEnvelope[]; lines: string[]; seen: Record<string, true> };

function makeTraceGrouper(): TraceGrouper {
  const byId: Record<string, TraceGroup> = Object.create(null);
  const order: string[] = [];
  return {
    add(entry: ParsedEventLine): void {
      const traceId = entry.event.trace_id;
      let group = byId[traceId];
      if (group === undefined) {
        group = { events: [], lines: [], seen: Object.create(null) };
        byId[traceId] = group;
        order.push(traceId);
      }
      if (group.seen[entry.raw]) {
        return;
      }
      group.seen[entry.raw] = true;
      group.events.push(entry.event);
      group.lines.push(entry.raw);
    },
    traces(): Trace[] {
      return order.map((traceId) => {
        const group = byId[traceId];
        return {
          traceId,
          events: group.events,
          lines: group.lines,
          digest: traceDigest(group.events),
        };
      });
    },
  };
}

function addParsedLines(
  parsed: ParseWithLinesResult,
  grouper: TraceGrouper,
  errors: ParseError[],
): void {
  for (const entry of parsed.lines) {
    grouper.add(entry);
  }
  for (const error of parsed.errors) {
    errors.push(error);
  }
}

/** The last line of a finished file, when it has no newline. A complete
 *  event is kept. A line that is not valid JSON was cut off mid-write and is
 *  ignored, as a reader of a live file would wait for the rest of it. */
function addLastLine(
  last: string | undefined,
  lineNumber: number,
  grouper: TraceGrouper,
  errors: ParseError[],
): void {
  if (last === undefined) {
    return;
  }
  const parsed = parseStatelogLine(last, lineNumber);
  if (parsed.kind === "event") {
    grouper.add(parsed.entry);
  } else if (parsed.kind === "error" && parsed.error.kind !== "invalid_json") {
    errors.push(parsed.error);
  }
}

export type TraceMatch =
  { kind: "one"; trace: Trace } | { kind: "none" } | { kind: "ambiguous"; ids: string[] };

/** Resolve a full id or a unique prefix (the viewer shows shortened ids). */
export function matchTrace(traces: readonly Trace[], idOrPrefix: string): TraceMatch {
  const match = matchTraceId(
    traces.map((trace) => trace.traceId),
    idOrPrefix,
  );
  if (match.kind === "one") {
    return { kind: "one", trace: traces.find((trace) => trace.traceId === match.id)! };
  }
  return match;
}

export type TraceIdMatch =
  { kind: "one"; id: string } | { kind: "none" } | { kind: "ambiguous"; ids: string[] };

/** The one rule for what a trace id argument means, over ids alone, so the
 *  viewer and the CLI agree on which trace `7f3a` is. */
export function matchTraceId(ids: readonly string[], idOrPrefix: string): TraceIdMatch {
  if (ids.includes(idOrPrefix)) return { kind: "one", id: idOrPrefix };
  const matches = ids.filter((id) => id.startsWith(idOrPrefix));
  if (matches.length === 1) return { kind: "one", id: matches[0] };
  if (matches.length === 0) return { kind: "none" };
  return { kind: "ambiguous", ids: matches };
}
