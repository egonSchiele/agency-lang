import { parseStatelogJsonl } from "@/statelog/parse.js";
import { cost, userMessageOf } from "@/statelog/wireAccessors.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";

import { IngestSourceError } from "./types.js";

/** A one-line description of one trace inside a statelog, enough to pick it
 *  from a list without opening it. */
export type TraceSummary = {
  traceId: string;
  agentName: string | null;
  firstUserMessage: string | null;
  costUsd: number;
};

/** A statelog parsed and grouped by trace, in first-seen order. */
export type StatelogScan = {
  eventsByTrace: Readonly<Record<string, readonly EventEnvelope[]>>;
  traces: readonly TraceSummary[];
};

/** How much of a value to show in a one-line preview (trace listing, task edit).
 *  One constant so every preview truncates to the same width. */
export const PREVIEW_CHARS = 60;

/** Collapse whitespace to one line and truncate to `PREVIEW_CHARS` with an
 *  ellipsis. Shared by everything that previews a value. */
export function previewLine(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > PREVIEW_CHARS ? `${oneLine.slice(0, PREVIEW_CHARS)}…` : oneLine;
}

/**
 * Parse a statelog once and group its events by trace.
 *
 * A statelog holding label data must parse cleanly: any unparseable line fails
 * the whole scan, because a dataset built from a partially read trace is a
 * dataset that silently means something other than the run it came from.
 */
export function scanStatelog(text: string): StatelogScan {
  const { events, errors } = parseStatelogJsonl(text);
  if (errors.length > 0) {
    const first = errors[0];
    throw new IngestSourceError(
      `This statelog has ${errors.length} unparseable line${errors.length === 1 ? "" : "s"} ` +
        `(first at line ${first.line}: ${first.detail}). A dataset must not be built from a ` +
        `partially parsed trace; fix or regenerate the log.`,
    );
  }
  if (events.length === 0) {
    throw new IngestSourceError("No statelog events found.");
  }

  const eventsByTrace: Record<string, EventEnvelope[]> = Object.create(null);
  const order: string[] = [];
  for (const event of events) {
    const existing = eventsByTrace[event.trace_id];
    if (existing === undefined) {
      eventsByTrace[event.trace_id] = [event];
      order.push(event.trace_id);
    } else {
      existing.push(event);
    }
  }

  const traces = order.map((traceId) => summarizeTrace(traceId, eventsByTrace[traceId]));
  return { eventsByTrace, traces };
}

function summarizeTrace(traceId: string, events: readonly EventEnvelope[]): TraceSummary {
  let agentName: string | null = null;
  let firstUserMessage: string | null = null;
  let costUsd = 0;
  for (const event of events) {
    if (event.data.type === "agentName" && typeof event.data.name === "string") {
      agentName = event.data.name;
    } else if (event.data.type === "promptCompletion") {
      costUsd += cost(event);
      if (firstUserMessage === null) {
        firstUserMessage = userMessageOf(event);
      }
    }
  }
  return { traceId, agentName, firstUserMessage, costUsd };
}

/** The result of resolving a user-supplied `--trace` value against a scan. */
export type TraceIdMatch =
  | { kind: "matched"; traceId: string }
  | { kind: "none" }
  | { kind: "ambiguous"; matches: readonly string[] };

/**
 * Resolve a user-supplied trace id, which may be a prefix, to a full trace id.
 *
 * The log viewer and event footers show only the first several characters of a
 * trace id, so that shortened form is what a user copies. A full id always wins
 * (an exact match is never treated as an ambiguous prefix); otherwise a prefix
 * that singles out one trace matches, and a prefix shared by several is
 * reported as ambiguous so the caller can lengthen it.
 */
export function matchTraceId(scan: StatelogScan, requested: string): TraceIdMatch {
  if (requested in scan.eventsByTrace) {
    return { kind: "matched", traceId: requested };
  }
  const matches = scan.traces
    .map((trace) => trace.traceId)
    .filter((id) => id.startsWith(requested));
  if (matches.length === 1) {
    return { kind: "matched", traceId: matches[0] };
  }
  return matches.length === 0 ? { kind: "none" } : { kind: "ambiguous", matches };
}

type TraceRow = { id: string; agent: string; cost: string; task: string };

function traceRow(trace: TraceSummary): TraceRow {
  return {
    id: trace.traceId,
    agent: trace.agentName ?? "(unnamed)",
    cost: `$${trace.costUsd.toFixed(4)}`,
    task: trace.firstUserMessage === null ? "" : previewLine(trace.firstUserMessage),
  };
}

/** A human-readable table of the traces a statelog holds, for the "which one?"
 *  error when a caller names an id that is not there or omits `--trace`. Column
 *  headers name each value, and the id column is wide enough that a user can
 *  copy a full id or any unique prefix of it. */
export function describeAvailableTraces(scan: StatelogScan): string {
  const header: TraceRow = {
    id: "TRACE ID",
    agent: "AGENT",
    cost: "COST",
    task: "TASK (first user message)",
  };
  const rows = [header, ...scan.traces.map(traceRow)];
  const idW = Math.max(...rows.map((row) => row.id.length));
  const agentW = Math.max(...rows.map((row) => row.agent.length));
  const costW = Math.max(...rows.map((row) => row.cost.length));
  const format = (row: TraceRow): string =>
    `  ${row.id.padEnd(idW)}  ${row.agent.padEnd(agentW)}  ${row.cost.padEnd(costW)}  ${row.task}`.trimEnd();
  return (
    "Available traces (pass a full id or any unique prefix to --trace):\n" +
    rows.map(format).join("\n")
  );
}
