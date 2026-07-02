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
      return d.value !== undefined
        ? `${head} → ${truncate(stringifyValue(d.value), 40)}`
        : head;
    }
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

// Find the first direct child leaf event of the given type under a span.
function childEvent(node: TreeNode, type: string): EventEnvelope | undefined {
  for (const c of node.children) {
    if (c.event?.data.type === type) return c.event;
  }
  return undefined;
}

function childEvents(node: TreeNode, type: string): EventEnvelope[] {
  const out: EventEnvelope[] = [];
  for (const c of node.children) {
    if (c.event?.data.type === type) out.push(c.event);
  }
  return out;
}

function spanDetail(node: TreeNode): string | undefined {
  switch (node.label) {
    case "nodeExecution": {
      const e = childEvent(node, "enterNode");
      return e?.data.nodeId ? `"${e.data.nodeId}"` : undefined;
    }
    case "agentRun": {
      const e = childEvent(node, "agentStart");
      return e?.data.entryNode ? `"${e.data.entryNode}"` : undefined;
    }
    case "toolExecution": {
      const e = childEvent(node, "toolCall") ?? childEvent(node, "toolCallStart");
      return e?.data.toolName ? String(e.data.toolName) : undefined;
    }
    case "forkAll":
    case "race": {
      const e = childEvent(node, "forkStart");
      const n = e?.data.branchCount;
      return typeof n === "number" ? `${n} ${n === 1 ? "branch" : "branches"}` : undefined;
    }
    case "subprocessRun": {
      const e = childEvent(node, "subprocessStarted");
      if (!e) return undefined;
      const node_ = e.data.node ? `"${e.data.node}"` : undefined;
      const mode = e.data.mode === "resume" ? "resume" : undefined;
      const parts = [node_, mode].filter((p): p is string => !!p);
      return parts.length > 0 ? parts.join(" · ") : undefined;
    }
    case "embedding": {
      const e = childEvent(node, "embedCompletion");
      if (!e) return undefined;
      const phase = e.data.phase ? String(e.data.phase) : null;
      const dims = typeof e.data.dimensions === "number" ? `${e.data.dimensions}d` : null;
      const parts = [phase, dims].filter((p): p is string => !!p);
      return parts.length > 0 ? parts.join(" · ") : undefined;
    }
    case "llmCall":
      return llmCallDetail(node);
    default:
      return undefined;
  }
}

// `<model> · "<prompt preview>" → <outcome>` for an llmCall span. The
// prompt comes from the first round's user message (the original
// request); the outcome from the last round's completion (the final
// answer, or the tool call(s) it made). Each free-text piece is
// truncated so the row stays scannable.
function llmCallDetail(node: TreeNode): string | undefined {
  const pcs = childEvents(node, "promptCompletion");
  if (pcs.length === 0) return undefined;
  const first = pcs[0];
  const last = pcs[pcs.length - 1];

  const model = stripQuotes(typeof first.data.model === "string" ? first.data.model : undefined);
  const prompt = lastUserMessage(first);
  const outcome = completionOutcome(last);

  let s = model && model !== "?" ? model : "";
  if (prompt) s += `${s ? " " : ""}· "${truncate(prompt, 32)}"`;
  if (outcome) s += ` → ${truncate(outcome, 32)}`;
  return s.length > 0 ? s : undefined;
}

// The last user-role message's text in a promptCompletion's messages —
// the prompt that was just sent.
function lastUserMessage(pc: EventEnvelope): string | undefined {
  const msgs = pc.data.messages;
  if (!Array.isArray(msgs)) return undefined;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .join("");
      return text || undefined;
    }
  }
  return undefined;
}

// What an llmCall produced: the assistant text if present, else the
// name(s) of the tool call(s) it made.
function completionOutcome(pc: EventEnvelope): string | undefined {
  const c = pc.data.completion;
  if (typeof c === "string" && c.length > 0) return c;
  if (c && typeof c === "object") {
    if (typeof c.output === "string" && c.output.length > 0) return c.output;
    if (Array.isArray(c.toolCalls) && c.toolCalls.length > 0) {
      const names = c.toolCalls.map((t: any) => t?.name).filter(Boolean);
      if (names.length > 0) return `tool: ${names.join(", ")}`;
    }
  }
  return undefined;
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
  if (id === undefined || id === null) return "";
  return String(id).slice(0, 6);
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
  const head = spanHead(node);
  const metrics = formatMetricsStyled(node, thresholds);
  return metrics ? `${head} (${metrics})` : head;
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
