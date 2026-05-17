import { EventEnvelope, TreeNode } from "./types.js";

export function summarize(evt: EventEnvelope): string {
  const d = evt.data;
  switch (d.type) {
    case "promptCompletion":
      return `promptCompletion ${stripQuotes(d.model)} (${fmtDuration(d.timeTaken)})`;
    case "toolCall":
      return `toolCall "${d.toolName}" (${fmtDuration(d.timeTaken)})`;
    case "error":
      return `error: ${d.errorType ?? "Error"} "${truncate(d.message ?? "", 60)}"`;
    case "interruptThrown":
      return `interruptThrown "${(d.interruptId ?? "").slice(0, 8)}"`;
    case "interruptResolved":
      return `interruptResolved ${d.outcome ?? "?"} by ${d.resolvedBy ?? "?"}`;
    case "handlerDecision":
      return `handlerDecision #${d.handlerIndex ?? "?"}: ${d.decision ?? "?"}`;
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
    case "threadCreated":
      return `threadCreated ${d.threadType ?? "?"} #${shortId(d.threadId)}`;
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
  return (id ?? "").slice(0, 6);
}

function stripQuotes(s?: string): string {
  if (!s) return "?";
  return s.replace(/^"+|"+$/g, "");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
