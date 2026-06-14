// Plain-text, grep-able one-line summaries for statelog events, spans, and
// traces. Lives in `lib/statelog/` (alongside the wire types/accessors) so both
// the model (`lib/statelogParser.ts`) and the viewer can share it without the
// viewer's TUI internals leaking in. The viewer's `summary.ts` keeps only the
// *styled* (color-tagged) variants and imports the shared formatters here.
import type { EventEnvelope } from "./wireTypes.js";

export type SummaryMetrics = {
  durationMs?: number;
  tokens?: number;
  cost?: number;
};

export function summarizeEvent(evt: EventEnvelope): string {
  const d = evt.data;
  switch (d.type) {
    case "promptCompletion":
      return `promptCompletion ${stripQuotes(d.model)} (${fmtDuration(d.timeTaken)})`;
    case "toolCallStart":
      return `toolCallStart "${d.toolName}"`;
    case "toolCall":
      return `toolCall "${d.toolName}" (${fmtDuration(d.timeTaken)})`;
    case "error":
      return `error: ${d.errorType ?? "Error"} "${truncate(d.message ?? "", 60)}"`;
    case "interruptThrown": {
      const intrSuffix = formatInterruptSuffix(d.interruptData);
      return `interruptThrown "${(d.interruptId ?? "").slice(0, 8)}"${intrSuffix}`;
    }
    case "interruptResolved": {
      const intrSuffix = formatInterruptSummary(d.interrupt);
      return `interruptResolved ${d.outcome ?? "?"} by ${d.resolvedBy ?? "?"}${intrSuffix}`;
    }
    case "handlerDecision": {
      const intrSuffix = formatInterruptSummary(d.interrupt);
      return `handlerDecision #${d.handlerIndex ?? "?"}: ${d.decision ?? "?"}${intrSuffix}`;
    }
    case "checkpointCreated":
      return `checkpointCreated #${shortId(d.checkpointId)} (${d.reason ?? "?"})`;
    case "checkpointRestored":
      return `checkpointRestored #${shortId(d.checkpointId)} (attempt ${d.restoreCount ?? "?"})`;
    case "forkStart":
      return `forkStart ${d.mode} (${d.branchCount} branches)`;
    case "forkBranchEnd":
      return `forkBranchEnd #${d.branchIndex} (${d.outcome}, ${fmtDuration(d.timeTaken)})`;
    case "forkEnd":
      return `forkEnd ${d.mode} (${fmtDuration(d.timeTaken)})`;
    case "threadCreated": {
      // Prefer label > session > nothing as the most informative single-line
      // tag: label is what the agent author wrote in `thread(label: "...")`;
      // session is the routing key for `thread(session: "...")`. Either lets
      // the reader see which subagent this thread corresponds to at a glance.
      const tag = d.label
        ? ` "${d.label}"`
        : d.session
          ? ` session="${d.session}"`
          : "";
      const hiddenSuffix = d.hidden ? " hidden" : "";
      return `threadCreated ${d.threadType ?? "?"} #${shortId(d.threadId)}${tag}${hiddenSuffix}`;
    }
    case "evalInputRecorded":
      return `evalInputRecorded ${truncate(stringifyValue(d.value), 60)}`;
    case "evalOutputRecorded":
      return `evalOutputRecorded ${truncate(stringifyValue(d.value), 60)}`;
    case "agentStart":
      return `agentStart "${d.entryNode ?? "?"}"`;
    case "agentEnd":
      return `agentEnd (${fmtDuration(d.timeTaken)})`;
    case "enterNode":
      return `enterNode "${d.nodeId ?? "?"}"`;
    case "runMetadata":
      return `runMetadata ${d.tags ? `tags=${JSON.stringify(d.tags)}` : ""}`;
    default:
      return d.type;
  }
}

// Span label inferred from the introducing event type (agentStart → agentRun,
// promptCompletion → llmCall, …). Moved from the viewer's tree.ts — this is a
// general structural fact about a trace, not a view concern.
export function spanLabelOf(evt: EventEnvelope): string {
  switch (evt.data.type) {
    case "agentStart":
    case "agentEnd":
      return "agentRun";
    case "enterNode":
      return "nodeExecution";
    case "promptCompletion":
      return "llmCall";
    case "embedCompletion":
      // Embedding spans share the chat-completion shape but get their own label
      // so the viewer can color/filter them separately and cost roll-ups don't
      // conflate the two.
      return "embedding";
    case "toolCall":
      return "toolExecution";
    case "forkStart":
    case "forkEnd":
      return evt.data.mode === "race" ? "race" : "forkAll";
    case "handlerDecision":
      return "handlerChain";
    default:
      // The memory umbrella events (memoryRemember/Recall/Forget/Compaction)
      // intentionally hit this branch — their event type already matches the
      // SpanType, so the default returns the right label.
      return evt.data.type;
  }
}

export function summarizeSpanText(label: string, m: SummaryMetrics): string {
  const metrics = formatMetricsText(m);
  return metrics ? `${label} (${metrics})` : label;
}

export function summarizeTraceText(
  traceId: string,
  firstTs: number | undefined,
  m: SummaryMetrics,
): string {
  const shortTraceId = traceId.slice(0, 6);
  const metrics = formatMetricsText(m);
  const head = firstTs !== undefined ? fmtTime(firstTs) : "trace";
  const middle = metrics ? `  (${metrics})` : "";
  return `${head}${middle}  [${shortTraceId}]`;
}

export function formatMetricsText(m: SummaryMetrics): string {
  const parts: string[] = [];
  if (m.durationMs !== undefined) parts.push(fmtDuration(m.durationMs));
  if (m.tokens !== undefined) parts.push(`${m.tokens} tok`);
  if (m.cost !== undefined) parts.push(fmtCost(m.cost));
  return parts.join(", ");
}

// Local time, friendly format: "May 16, 11:15pm". Chosen for at-a-glance
// readability over machine parsing — the full ISO timestamp lives in the raw
// envelope if anyone needs it.
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const month = MONTHS[d.getMonth()];
  const day = d.getDate();
  const hours24 = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const period = hours24 >= 12 ? "pm" : "am";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${month} ${day}, ${hours12}:${minutes}${period}`;
}

export function fmtDuration(ms?: number): string {
  if (ms === undefined) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function fmtCost(c?: number): string {
  if (c === undefined) return "?";
  return `$${c.toFixed(3)}`;
}

function shortId(id?: string): string {
  return (String(id) ?? "").slice(0, 6);
}

function stripQuotes(s?: string): string {
  if (!s) return "?";
  return s.replace(/^"+|"+$/g, "");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function stringifyValue(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v ?? null) ?? "undefined";
}

/** Format the optional `{kind, message, data}` interrupt summary attached to
 *  `handlerDecision` / `interruptResolved` events. Returns "" when absent. */
function formatInterruptSummary(intr: any): string {
  if (!intr || typeof intr !== "object") return "";
  const kind = intr.kind ? String(intr.kind) : null;
  const msg = intr.message ? truncate(String(intr.message), 50) : null;
  if (kind && msg) return ` — ${kind}: "${msg}"`;
  if (kind) return ` — ${kind}`;
  if (msg) return ` — "${msg}"`;
  return "";
}

/** Format the older `interruptData` field on `interruptThrown` events.
 *  Best-effort one-line preview. */
function formatInterruptSuffix(data: any): string {
  if (data === undefined || data === null) return "";
  try {
    const s = typeof data === "string" ? data : JSON.stringify(data);
    return ` ${truncate(s, 50)}`;
  } catch {
    return "";
  }
}
