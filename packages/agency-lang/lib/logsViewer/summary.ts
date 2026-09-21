import { fmtUsd } from "./format.js";
import { EventEnvelope, TreeNode } from "./types.js";
import { fmtDuration, spanDetail, stripQuotes, truncate } from "./spanText.js";

export function summarize(evt: EventEnvelope): string {
  const d = evt.data;
  switch (d.type) {
    case "promptCompletion":
      return `promptCompletion ${stripQuotes(d.model)} (${fmtDuration(d.timeTaken)})`;
    case "promptStart": {
      // Only unpaired starts reach the tree, so this line IS the
      // "call in flight / never completed" indicator. The parenthetical
      // is the runaway fingerprint: schema + cap + prompt size.
      const shape = [
        d.hasResponseFormat ? "schema" : null,
        d.maxTokens != null ? `maxTokens ${d.maxTokens}` : null,
        `${d.messageCount} msgs`,
      ]
        .filter(Boolean)
        .join(", ");
      return `⏳ promptStart ${stripQuotes(d.model)} — never completed (${shape})`;
    }
    case "promptCancelled":
      return `promptCancelled`;
    case "threadEndHooksStart":
      return `thread-end hooks (summarize: ${d.eagerSummarize ? "on" : "off"})`;
    case "threadEndHooksEnd":
      return `thread-end hooks done (${fmtDuration(d.timeTaken)})`;
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
    case "subprocessStarted":
      return `subprocessStarted ${d.mode} "${d.node}" depth=${d.depth}`;
    case "subprocessEnd":
      return `subprocessEnd (${d.outcome}, ${fmtDuration(d.timeTaken)})`;
    case "forkStart":
      return `forkStart ${d.mode} (${d.branchCount} branches)`;
    case "forkBranchEnd": {
      const head = `forkBranchEnd #${d.branchIndex} (${d.outcome}, ${fmtDuration(d.timeTaken)})`;
      // Show the branch's return value (success only) so you can see what
      // each branch produced without opening raw data.
      return d.value !== undefined ? `${head} → ${truncate(stringifyValue(d.value), 40)}` : head;
    }
    case "forkEnd":
      return `forkEnd ${d.mode} (${fmtDuration(d.timeTaken)})`;
    case "threadCreated": {
      // Prefer label > session > nothing as the most informative
      // single-line tag: label is what the agent author wrote in
      // `thread(label: "...")`; session is the routing key for
      // `thread(session: "...")`. Either lets the reader see which
      // subagent this thread corresponds to at a glance.
      const tag = d.label ? ` "${d.label}"` : d.session ? ` session="${d.session}"` : "";
      const hiddenSuffix = d.hidden ? " hidden" : "";
      return `threadCreated ${d.threadType ?? "?"} #${shortId(d.threadId)}${tag}${hiddenSuffix}`;
    }
    case "evalValueRecorded":
      return `evalValueRecorded ${truncate(stringifyValue(d.value), 60)}`;
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
  const head = spanHead(node);
  const metrics = formatMetrics(node);
  return metrics ? `${head} (${metrics})` : head;
}

// `<label> <identifying detail>` for a span — e.g. `nodeExecution "agent"`,
// `toolExecution getArea`, `llmCall gpt-4o-mini · "..." → "..."`. The
// detail is pulled from the span's characteristic child event so a
// collapsed row tells you *which* node/tool/call it is, not just timing.
// Returns just the label when no detail applies.
function spanHead(node: TreeNode): string {
  const detail = spanDetail(node);
  return detail ? `${node.label} ${detail}` : node.label;
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
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

function fmtCost(c?: number): string {
  return c === undefined ? "?" : fmtUsd(c);
}

function shortId(id?: string): string {
  if (id === undefined || id === null) return "";
  return String(id).slice(0, 6);
}

function stringifyValue(v: unknown): string {
  return typeof v === "string" ? v : (JSON.stringify(v ?? null) ?? "undefined");
}

/** Format the optional `{effect, message, data}` interrupt summary
 *  attached to `handlerDecision` / `interruptResolved` events. The
 *  runtime started attaching this so log readers can see *what* was
 *  being approved/rejected without correlating against a separate
 *  `interruptThrown` event. Returns "" when no `effect` summary is
 *  present. Note: pre-rename traces carried this field as `kind`; by
 *  design (see the kind->effect rename) such older traces render
 *  without the effect label rather than being read back-compatibly. */
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
