import { EventEnvelope, TreeNode } from "./types.js";
import {
  DEFAULT_THRESHOLDS,
  ViewerThresholds,
  durationMagnitude,
  costMagnitude,
  Magnitude,
} from "./thresholds.js";

export function summarize(evt: EventEnvelope): string {
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
      // Prefer label > session > nothing as the most informative
      // single-line tag: label is what the agent author wrote in
      // `thread(label: "...")`; session is the routing key for
      // `thread(session: "...")`. Either lets the reader see which
      // subagent this thread corresponds to at a glance.
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

export function summarizeSpan(node: TreeNode): string {
  const metrics = formatMetrics(node);
  return metrics ? `${node.label} (${metrics})` : node.label;
}

export function summarizeTrace(node: TreeNode): string {
  const shortTraceId = node.traceId.slice(0, 6);
  const metrics = formatMetrics(node);
  const head = node.firstTs !== undefined ? fmtTime(node.firstTs) : "trace";
  const middle = metrics ? `  (${metrics})` : "";
  return `${head}${middle}  [${shortTraceId}]`;
}

// Local time, friendly format: "May 16, 11:15pm". Chosen for
// at-a-glance readability over machine parsing — the full ISO
// timestamp lives in the raw envelope if anyone needs it.
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const month = MONTHS[d.getMonth()];
  const day = d.getDate();
  const hours24 = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const period = hours24 >= 12 ? "pm" : "am";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${month} ${day}, ${hours12}:${minutes}${period}`;
}

function formatMetrics(node: TreeNode): string {
  const parts: string[] = [];
  if (node.duration !== undefined) parts.push(fmtDuration(node.duration));
  if (node.tokens !== undefined) parts.push(`${node.tokens} tok`);
  if (node.cost !== undefined) parts.push(fmtCost(node.cost));
  return parts.join(", ");
}

function fmtDuration(ms?: number): string {
  if (ms === undefined) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtCost(c?: number): string {
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

/** Format the optional `{effect, message, data}` interrupt summary
 *  attached to `handlerDecision` / `interruptResolved` events. The
 *  runtime started attaching this so log readers can see *what* was
 *  being approved/rejected without correlating against a separate
 *  `interruptThrown` event. Returns "" when no summary is present
 *  (preserves prior format for older traces). */
function formatInterruptSummary(intr: any): string {
  if (!intr || typeof intr !== "object") return "";
  const effect = intr.effect ? String(intr.effect) : null;
  const msg = intr.message ? truncate(String(intr.message), 50) : null;
  if (effect && msg) return ` — ${effect}: "${msg}"`;
  if (effect) return ` — ${effect}`;
  if (msg) return ` — "${msg}"`;
  return "";
}

/** Format the older `interruptData` field on `interruptThrown` events
 *  (which already shipped before this round of changes). Best-effort
 *  one-line preview. */
function formatInterruptSuffix(data: any): string {
  if (data === undefined || data === null) return "";
  try {
    const s = typeof data === "string" ? data : JSON.stringify(data);
    return ` ${truncate(s, 50)}`;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Styled-summary variants: produce the same text as the plain functions
// above but wrap durations/costs in `{...-fg}...{/...-fg}` tags so the
// TUI renderer can color them by magnitude. Token counts stay
// uncolored (they're noisy and not actionable). The plain functions
// are still used at tree-build time so `node.summary` stays grep-able
// for search; the renderer asks for the styled version when drawing.

export function summarizeSpanStyled(
  node: TreeNode,
  thresholds: ViewerThresholds = DEFAULT_THRESHOLDS,
): string {
  const metrics = formatMetricsStyled(node, thresholds);
  return metrics ? `${node.label} (${metrics})` : node.label;
}

export function summarizeTraceStyled(
  node: TreeNode,
  thresholds: ViewerThresholds = DEFAULT_THRESHOLDS,
): string {
  const shortTraceId = node.traceId.slice(0, 6);
  const metrics = formatMetricsStyled(node, thresholds);
  const head = node.firstTs !== undefined ? fmtTime(node.firstTs) : "trace";
  const middle = metrics ? `  (${metrics})` : "";
  return `${head}${middle}  [${shortTraceId}]`;
}

function formatMetricsStyled(node: TreeNode, t: ViewerThresholds): string {
  const parts: string[] = [];
  if (node.duration !== undefined) {
    parts.push(wrapTag(fmtDuration(node.duration), durationColor(node.duration, t)));
  }
  if (node.tokens !== undefined) parts.push(`${node.tokens} tok`);
  if (node.cost !== undefined) {
    parts.push(wrapTag(fmtCost(node.cost), costColor(node.cost, t)));
  }
  return parts.join(", ");
}

function durationColor(ms: number, t: ViewerThresholds): string | undefined {
  return colorForMagnitude(durationMagnitude(ms, t));
}

function costColor(usd: number, t: ViewerThresholds): string | undefined {
  return colorForMagnitude(costMagnitude(usd, t));
}

function colorForMagnitude(m: Magnitude): string | undefined {
  switch (m) {
    case "slow":
    case "expensive":
      return "bright-red";
    case "fast":
      return "gray";
    default:
      return undefined;
  }
}

function wrapTag(text: string, color: string | undefined): string {
  if (!color) return text;
  return `{${color}-fg}${text}{/${color}-fg}`;
}
