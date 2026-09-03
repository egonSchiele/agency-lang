// Pretty-print the `messages` array on a promptCompletion event into
// one short line per message. Used by the logs viewer to show a
// readable conversation summary in place of the raw JSON dump.
//
// We intentionally keep this dependency-free and tolerant of partial
// payloads — older statelog files may use slightly different shapes
// for tool calls, content, etc.

import { color } from "@/utils/termcolors.js";
import { wrapLine } from "./wrapLine.js";

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
// flat list, in order, so the viewer can render one row per entry. With
// `width`, body text is wrapped to fit before it is colored, so every row
// carries its own complete escape sequences.
export function formatConversation(messages: ConvoMessage[], width?: number): string[] {
  const out: string[] = [];
  for (const msg of messages) {
    out.push(...formatMessage(msg, width));
  }
  return out;
}

function formatMessage(msg: ConvoMessage, width?: number): string[] {
  const role = msg.role ?? "unknown";
  const label = roleLabel(role, msg);
  const prefix = color.green(label);
  const lines: string[] = [];
  const text = contentText(msg.content);
  if (text !== undefined && text.length > 0) {
    const bodyLines: string[] = [];
    for (const line of escapeControls(text).split("\n")) {
      if (width === undefined) {
        bodyLines.push(line);
        continue;
      }
      // The first row of the body shares its width with the role tag;
      // every row after it is indented by two.
      const firstWidth = Math.max(1, width - (bodyLines.length === 0 ? label.length + 1 : 2));
      const [first, ...more] = wrapLine(line, firstWidth);
      bodyLines.push(first);
      if (more.length > 0) {
        const rest = line.slice(first.length).replace(/^ +/, "");
        bodyLines.push(...wrapLine(rest, Math.max(1, width - 2)));
      }
    }
    const [first, ...rest] = bodyLines;
    lines.push(`${prefix} ${styleBody(role, first)}`);
    for (const line of rest) lines.push(`  ${styleBody(role, line)}`);
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

// A system body is dim so the eye skips it; a user body is bright so the
// eye can find it. The role tag itself keeps its green.
function styleBody(role: string, text: string): string {
  if (role === "system") return color.dim(text);
  if (role === "user") return color.brightCyan(text);
  return text;
}

function roleLabel(role: string, msg: ConvoMessage): string {
  if (role === "tool") return `[tool: ${msg.name ?? "tool"}]`;
  return `[${role}]`;
}

// Content can be a string, null, or (for some providers) a structured
// array of content parts. Text is shown as written, newlines included;
// anything else is shown as JSON.
function contentText(content: unknown): string | undefined {
  if (content === null || content === undefined) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => contentPartText(p))
      .filter((s): s is string => s !== undefined);
    // A plain data array (e.g. a tool result like [0,1,1,2,3]) has no
    // text parts; show the whole value rather than nothing.
    if (parts.length === 0) return JSON.stringify(content);
    return parts.join(" ");
  }
  return JSON.stringify(content);
}

// Message text reaches the terminal as-is, so every control character
// except the newline is shown escaped (`\r`, `\t`, `\u001b`): a recorded
// escape sequence must not clear the screen or move the cursor.
function escapeControls(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, (ch) => JSON.stringify(ch).slice(1, -1));
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
