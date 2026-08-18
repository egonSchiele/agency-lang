import * as fs from "fs";

import {
  parseStatelogJsonlWithLines,
  type ParsedEventLine,
  type ParseError,
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
 * A trailing line without its newline is a torn write and is ignored. A line
 * byte-identical to one already seen for its trace is dropped: that is the
 * harmless result of `cat`-ing two copies of one trace. Nothing more is
 * checked here — two different streams sharing an id cannot be told apart once
 * concatenated; `mergeStatelog` refuses that while they are still separate.
 */
export function readTraces(statelogPath: string): ReadTracesResult {
  return tracesFromText(fs.readFileSync(statelogPath, "utf8"));
}

export function tracesFromText(text: string): ReadTracesResult {
  const parsed = parseStatelogJsonlWithLines(dropTornTail(text));
  return { traces: groupByTrace(parsed.lines), errors: parsed.errors };
}

function dropTornTail(text: string): string {
  if (text.length === 0 || text.endsWith("\n")) return text;
  const lastNewline = text.lastIndexOf("\n");
  return lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
}

function groupByTrace(lines: readonly ParsedEventLine[]): Trace[] {
  const byId: Record<
    string,
    { events: EventEnvelope[]; lines: string[]; seen: Record<string, true> }
  > = Object.create(null);
  const order: string[] = [];
  for (const entry of lines) {
    const traceId = entry.event.trace_id;
    let group = byId[traceId];
    if (group === undefined) {
      group = { events: [], lines: [], seen: Object.create(null) };
      byId[traceId] = group;
      order.push(traceId);
    }
    if (group.seen[entry.raw]) continue;
    group.seen[entry.raw] = true;
    group.events.push(entry.event);
    group.lines.push(entry.raw);
  }
  return order.map((traceId) => {
    const group = byId[traceId];
    return { traceId, events: group.events, lines: group.lines, digest: traceDigest(group.events) };
  });
}

export type TraceMatch =
  { kind: "one"; trace: Trace } | { kind: "none" } | { kind: "ambiguous"; ids: string[] };

/** Resolve a full id or a unique prefix (the viewer shows shortened ids). */
export function matchTrace(traces: readonly Trace[], idOrPrefix: string): TraceMatch {
  const exact = traces.find((trace) => trace.traceId === idOrPrefix);
  if (exact !== undefined) return { kind: "one", trace: exact };
  const matches = traces.filter((trace) => trace.traceId.startsWith(idOrPrefix));
  if (matches.length === 1) return { kind: "one", trace: matches[0] };
  if (matches.length === 0) return { kind: "none" };
  return { kind: "ambiguous", ids: matches.map((trace) => trace.traceId) };
}
