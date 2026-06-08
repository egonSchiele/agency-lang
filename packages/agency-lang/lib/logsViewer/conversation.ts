// Pretty-print the `messages` array on a promptCompletion event into
// one short line per message. Used by the logs viewer to show a
// readable conversation summary in place of the raw JSON dump.
//
// We intentionally keep this dependency-free and tolerant of partial
// payloads — older statelog files may use slightly different shapes
// for tool calls, content, etc.

import { color } from "@/utils/termcolors.js";

export type ConvoMessage = {
  role?: string;
  content?: unknown;
  name?: string;
  toolCalls?: ToolCall[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  toolCallId?: string;
};

type ToolCall = {
  id?: string;
  name?: string;
  arguments?: unknown;
  function?: { name?: string; arguments?: unknown };
};

// Returns one display string per message. A single message can become
// multiple lines (tool calls + text content) — they're returned as a
// flat list, in order, so the viewer can render one row per entry.
export function formatConversation(messages: ConvoMessage[]): string[] {
  const out: string[] = [];
  for (const msg of messages) {
    out.push(...formatMessage(msg));
  }
  return out;
}

function formatMessage(msg: ConvoMessage): string[] {
  const role = msg.role ?? "unknown";
  const prefix = formatRole(role, msg);
  const lines: string[] = [];
  const text = stringifyContent(msg.content);
  if (text !== undefined && text.length > 0) {
    lines.push(`${prefix} ${text}`);
  }
  const toolCalls = msg.toolCalls ?? msg.tool_calls ?? [];
  for (const tc of toolCalls) {
    lines.push(`${prefix} tool call: ${formatToolCall(tc)}`);
  }
  // Empty assistant turn with no text and no tool calls — still emit
  // a row so it's visible in the conversation.
  if (lines.length === 0) {
    lines.push(`${prefix}`);
  }
  return lines;
}

function formatRole(role: string, msg: ConvoMessage): string {
  if (role === "tool") {
    const name = msg.name ?? "tool";
    return color.green(`[tool: ${name}]`);
  }
  return color.green(`[${role}]`);
}

// Content can be a string, null, or (for some providers) a structured
// array of content parts. Normalize to a single short string.
function stringifyContent(content: unknown): string | undefined {
  if (content === null || content === undefined) return undefined;
  if (typeof content === "string") return JSON.stringify(content);
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => contentPartText(p))
      .filter((s): s is string => s !== undefined);
    if (parts.length === 0) return undefined;
    return JSON.stringify(parts.join(" "));
  }
  return JSON.stringify(content);
}

function contentPartText(part: unknown): string | undefined {
  if (typeof part === "string") return part;
  if (part && typeof part === "object") {
    const p = part as { text?: unknown; type?: unknown };
    if (typeof p.text === "string") return p.text;
  }
  return undefined;
}

function formatToolCall(tc: ToolCall): string {
  const name = tc.name ?? tc.function?.name ?? "?";
  const args = tc.arguments ?? tc.function?.arguments;
  const argText = formatArguments(args);
  return `${name}(${argText})`;
}

function formatArguments(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") {
    // Some providers ship arguments as a JSON-encoded string. Try to
    // re-parse for a tidier display; fall back to the raw string.
    try {
      return JSON.stringify(JSON.parse(args));
    } catch {
      return args;
    }
  }
  return JSON.stringify(args);
}
