// Shared span naming, text, and magnitude-color helpers — lifted verbatim
// from summary.ts so the tree view and the timeline views name a span and
// format a duration ONE way. A span reading differently in two views of
// the same session is the drift this file exists to prevent.
import { EventEnvelope, TreeNode } from "./types.js";
import {
  ViewerThresholds,
  durationMagnitude,
  costMagnitude,
  Magnitude,
} from "./thresholds.js";

// Find the first direct child leaf event of the given type under a span.
export function childEvent(node: TreeNode, type: string): EventEnvelope | undefined {
  for (const c of node.children) {
    if (c.event?.data.type === type) return c.event;
  }
  return undefined;
}

export function childEvents(node: TreeNode, type: string): EventEnvelope[] {
  const out: EventEnvelope[] = [];
  for (const c of node.children) {
    if (c.event?.data.type === type) out.push(c.event);
  }
  return out;
}

export function spanDetail(node: TreeNode): string | undefined {
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
export function llmCallDetail(node: TreeNode): string | undefined {
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
export function lastUserMessage(pc: EventEnvelope): string | undefined {
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
export function completionOutcome(pc: EventEnvelope): string | undefined {
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

/** `1.2s` / `450ms` as the tree has always shown; `{ minutes: true }`
 *  adds the `15m59s` form for the timeline's long spans, where `959.0s`
 *  stops being readable. One formatter, two call styles — never two
 *  formatters. */
export function fmtDuration(ms?: number, opts: { minutes?: boolean } = {}): string {
  if (ms === undefined) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (opts.minutes && ms >= 60_000) {
    const sec = Math.round(ms / 1000);
    return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export function stripQuotes(s?: string): string {
  if (!s) return "?";
  return s.replace(/^"+|"+$/g, "");
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export function durationColor(ms: number, t: ViewerThresholds): string | undefined {
  return colorForMagnitude(durationMagnitude(ms, t));
}

export function costColor(usd: number, t: ViewerThresholds): string | undefined {
  return colorForMagnitude(costMagnitude(usd, t));
}

export function colorForMagnitude(m: Magnitude): string | undefined {
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
