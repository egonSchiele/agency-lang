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

/** A human-readable list of the traces a statelog holds, for the "which one?"
 *  error when a caller names an id that is not there or omits `--trace`. */
export function describeAvailableTraces(scan: StatelogScan): string {
  const lines = scan.traces.map((trace) => {
    const label = trace.agentName ?? "(unnamed)";
    const preview = trace.firstUserMessage === null ? "" : `  ${previewLine(trace.firstUserMessage)}`;
    return `  ${trace.traceId}  [${label}]  $${trace.costUsd.toFixed(4)}${preview}`;
  });
  return `Available traces:\n${lines.join("\n")}`;
}
