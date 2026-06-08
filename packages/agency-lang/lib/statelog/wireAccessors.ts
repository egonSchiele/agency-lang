import type { EventEnvelope } from "./wireTypes.js";

/** Thin accessor layer over the wire format. Every place that reads
 *  `ev.data.foo` directly is a leak of the wire format into consumer
 *  code; if the runtime renames `usage.inputTokens` → `usage.promptTokens`
 *  tomorrow (provider libraries do this constantly), we don't want to
 *  chase the rename through every helper. Confine wire-format
 *  knowledge to this one module.
 *
 *  Rule for `lib/eval/`: no helper reads `ev.data.foo` directly — add
 *  an accessor here first, then use it. Enforce in code review. */

/** Group events by their `data.type`. One pass; produces a plain
 *  object (per AGENTS.md: prefer objects over Maps). */
export function groupByType(
  events: EventEnvelope[],
): Record<string, EventEnvelope[]> {
  const out: Record<string, EventEnvelope[]> = {};
  for (const ev of events) {
    const k = ev.data.type;
    (out[k] ??= []).push(ev);
  }
  return out;
}

/** Convenience: filter to one event type. Prefer `groupByType` when
 *  you need multiple types in one pass. */
export function byType(events: EventEnvelope[], type: string): EventEnvelope[] {
  return events.filter((e) => e.data.type === type);
}

/** Epoch milliseconds for an event's timestamp. */
export function timestampMs(ev: EventEnvelope): number {
  return new Date(ev.data.timestamp).getTime();
}

/** Thread id stamped on a promptCompletion / toolCall / toolCallStart
 *  by Task 0. Null for legacy traces (pre-prereq). */
export function threadIdOf(ev: EventEnvelope): string | null {
  const v = ev.data.threadId;
  return typeof v === "string" ? v : null;
}

/** Tool name on a toolCall / toolCallStart. */
export function toolNameOf(ev: EventEnvelope): string {
  return String(ev.data.toolName ?? "");
}

/** Input-token count from a promptCompletion's `data.usage`. Returns
 *  0 if absent. The key name is locked here — if the runtime starts
 *  using a different shape (`prompt_tokens`, `input_tokens`, …),
 *  update this one site rather than chasing every consumer. */
export function tokensIn(ev: EventEnvelope): number {
  return Number(ev.data.usage?.inputTokens ?? 0);
}

export function tokensOut(ev: EventEnvelope): number {
  return Number(ev.data.usage?.outputTokens ?? 0);
}

/** USD cost on a promptCompletion. Reads `cost.totalCost` (TokenCost
 *  shape from lib/statelogClient.ts). */
export function cost(ev: EventEnvelope): number {
  return Number(ev.data.cost?.totalCost ?? 0);
}

/** Model name on a promptCompletion. Strips wrapping quotes — call
 *  sites in `lib/runtime/prompt.ts` pass `JSON.stringify(modelName)`,
 *  which surrounds the string with quotes. */
export function modelOf(ev: EventEnvelope): string {
  const raw = String(ev.data.model ?? "");
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** Tools array advertised to the LLM on a promptCompletion. */
export function toolsOf(ev: EventEnvelope): string[] {
  const t = ev.data.tools;
  if (!Array.isArray(t)) return [];
  return t.map((x: any) => String(x?.name ?? x));
}

/** Last user-role message content from a promptCompletion's
 *  `data.messages` array. Returns null if no user message exists.
 *  The "user message" is appended to the message thread after any
 *  system prompt(s), so the LAST user-role entry in the first-turn
 *  messages is the prompt the user just typed. */
export function userMessageOf(
  promptCompletion: EventEnvelope,
): string | null {
  const msgs = promptCompletion.data.messages;
  if (!Array.isArray(msgs)) return null;
  const userMsgs = msgs.filter((m: any) => m?.role === "user");
  const last = userMsgs[userMsgs.length - 1];
  if (last === undefined) return null;
  if (typeof last.content === "string") return last.content;
  // smoltalk messages can also carry an array-of-parts content shape;
  // best-effort: concatenate any string parts.
  if (Array.isArray(last.content)) {
    const text = last.content
      .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
      .join("");
    return text.length > 0 ? text : null;
  }
  return null;
}

/** Assistant's reply text on a promptCompletion. Returns null when
 *  the completion is empty or absent. */
export function completionOf(
  promptCompletion: EventEnvelope,
): string | null {
  const c = promptCompletion.data.completion;
  // smoltalk `PromptResult` exposes the reply at `.output` (a string)
  // and the model echoes the same as `.choices[0].message.content`.
  // Be tolerant of both shapes.
  if (typeof c === "string" && c.length > 0) return c;
  if (c && typeof c === "object") {
    if (typeof c.output === "string" && c.output.length > 0) return c.output;
    const msg = c.choices?.[0]?.message?.content;
    if (typeof msg === "string" && msg.length > 0) return msg;
  }
  return null;
}
