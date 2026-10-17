import {
  contentText,
  messagesOf,
  normalizeMessage,
  type WireMessage,
} from "../statelog/wireAccessors.js";
import type { HistoryRewrite, RoundDelta } from "./messageDelta.js";
import {
  cutResultPayload,
  RESULT_PREVIEW_CHARS,
  valuePayload,
  type PayloadLine,
} from "./payload.js";
import type { Round } from "./timeline/rounds.js";

const ROLE_TONES: Record<string, Extract<PayloadLine, { kind: "heading" }>["tone"]> = {
  user: "user",
  assistant: "assistant",
  tool: "tool",
  system: "chrome",
  developer: "chrome",
};

export function hasSystemMessages(round: Round | undefined): boolean {
  return (
    round !== undefined &&
    messagesOf(round.node.event!).some((value) => isSystem(normalizeMessage(value)))
  );
}

export type InputPayload = {
  lines: PayloadLine[];
  /** Where this call's new messages begin in `lines`: the divider, when
   *  the call has history. The overview opens the preview there. */
  newAt: number;
};

export type InputOptions = {
  systemsExpanded: boolean;
  /** Show the whole history, faded, instead of the stub of its last message. */
  historyExpanded: boolean;
  /** Print every tool result whole instead of its first RESULT_PREVIEW_CHARS. */
  fullResults: boolean;
};

/** Whether any tool result among the call's messages is longer than the
 *  preview keeps. */
export function hasCutToolResult(round: Round | undefined): boolean {
  return (
    round !== undefined &&
    messagesOf(round.node.event!).some((value) => {
      const message = normalizeMessage(value);
      return message.role === "tool" && resultText(message.content).length > RESULT_PREVIEW_CHARS;
    })
  );
}

/** Whether the call carries messages a previous call on its thread sent. */
export function hasHistory(round: Round | undefined, delta: RoundDelta | undefined): boolean {
  return (
    round !== undefined &&
    delta !== undefined &&
    delta.added.length < messagesOf(round.node.event!).length
  );
}

/** The recorded input. With the call's delta, the messages the previous
 *  call already had are history: folded, only the last of them shows, as
 *  its heading and first line plus a count of the rest; expanded, all of
 *  it shows, faded, with a divider where the new messages start. */
export function roundInputPayload(
  round: Round,
  options: InputOptions,
  delta?: RoundDelta,
): InputPayload {
  const event = round.node.event!;
  if (!Array.isArray(event.data.messages)) {
    return { lines: [{ kind: "meta", text: "Input messages were not recorded." }], newAt: 0 };
  }
  const messages = messagesOf(event).map(normalizeMessage);
  if (messages.length === 0) {
    return { lines: [{ kind: "meta", text: "No input messages." }], newAt: 0 };
  }
  const newFrom = delta === undefined ? 0 : messages.length - delta.added.length;
  const lines = (message: WireMessage): PayloadLine[] => [
    ...messagePayload(message, options),
    { kind: "blank" },
  ];
  const history = messages
    .slice(0, newFrom)
    .flatMap(lines)
    .map((line) => ({ ...line, faded: true }));
  const fresh = messages.slice(newFrom).flatMap(lines);
  if (newFrom === 0) {
    return { lines: fresh, newAt: 0 };
  }
  if (!options.historyExpanded) {
    const stubOptions = { ...options, systemsExpanded: false, fullResults: false };
    const [heading, ...body] = messagePayload(messages[newFrom - 1], stubOptions);
    const shown = [heading, ...firstBodyLine(body)];
    const lines = [...shown, dots(newFrom - 1, delta?.rewrite), { kind: "blank" as const }];
    return { lines: [...lines.map((line) => ({ ...line, faded: true })), ...fresh], newAt: 0 };
  }
  return {
    lines: [...history, divider(newFrom, fresh.length > 0, delta?.rewrite), ...fresh],
    newAt: history.length,
  };
}

/** The first line of a message's body, kept to one painted row: a tool
 *  result often starts with one very long line. */
function firstBodyLine(lines: PayloadLine[]): PayloadLine[] {
  const first = lines.find((line) => line.kind !== "blank");
  if (first === undefined) {
    return [];
  }
  if (first.kind === "heading") {
    return [first];
  }
  let text: string;
  if (first.kind === "table") {
    text = first.columns.join("  ");
  } else if (first.kind === "pair") {
    text = `${first.key}: ${first.text}`;
  } else {
    text = first.text.split("\n")[0];
  }
  return [{ kind: "text", text, indent: 0, role: "plain", oneRow: true }];
}

function dots(moreEarlier: number, rewrite: HistoryRewrite | undefined): PayloadLine {
  const notes: string[] = [];
  if (rewrite !== undefined) {
    notes.push(`history changed from message ${rewrite.firstChangedAt + 1}`);
  }
  if (moreEarlier > 0) {
    notes.push(`+${moreEarlier} earlier ${plural(moreEarlier, "message")}`);
  }
  if (notes.length === 0) {
    return { kind: "meta", text: "…" };
  }
  return { kind: "meta", text: `… (${notes.join(", ")})` };
}

function divider(
  earlier: number,
  anyNew: boolean,
  rewrite: HistoryRewrite | undefined,
): PayloadLine {
  const parts: string[] = [];
  if (rewrite !== undefined) {
    parts.push(`HISTORY CHANGED from message ${rewrite.firstChangedAt + 1}`);
  }
  parts.push(`${earlier} earlier ${plural(earlier, "message")} above`);
  parts.push(anyNew ? "NEW" : "NOTHING NEW");
  return { kind: "heading", tone: "chrome", text: `── ${parts.join(" · ")} ──` };
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

/** A message's content as the reader wrote it. Content sent as parts
 *  (`[{ type: "text", text }, { type: "image_url", … }]`) shows each text
 *  part as its text and any other part as its fields. A list that is not
 *  made of parts, such as a tool result of records, keeps every field. */
function contentPayload(content: unknown): PayloadLine[] {
  if (!Array.isArray(content) || !content.every(isContentPart)) {
    return valuePayload(content);
  }
  return content.flatMap((part) => {
    if (typeof part === "string") {
      return valuePayload(part);
    }
    const record = part as Record<string, unknown>;
    return valuePayload(
      record.type === "text" && typeof record.text === "string" ? record.text : part,
    );
  });
}
/** A string, or an object with a `type` field, the shape of a content part. */
function isContentPart(part: unknown): boolean {
  if (typeof part === "string") {
    return true;
  }
  return (
    part !== null &&
    typeof part === "object" &&
    typeof (part as { type?: unknown }).type === "string"
  );
}
function isSystem(message: WireMessage): boolean {
  return message.role === "system" || message.role === "developer";
}
/** A tool result as the text the model read, the length the cut measures. */
function resultText(content: unknown): string {
  return typeof content === "string" ? content : (JSON.stringify(content) ?? "");
}
/** A tool result message: `TOOL RESULT`, its tool and call ID, and the
 *  result, cut like the output preview cuts it unless `fullResults`. */
function toolResultMessagePayload(message: WireMessage, fullResults: boolean): PayloadLine[] {
  const heading: PayloadLine = {
    kind: "heading",
    tone: "tool",
    text: ["TOOL RESULT", message.name, message.toolCallId].filter(Boolean).join(" · "),
  };
  if (message.content === null) {
    return [heading];
  }
  const text = resultText(message.content);
  if (fullResults || text.length <= RESULT_PREVIEW_CHARS) {
    return [heading, ...contentPayload(message.content)];
  }
  return [heading, ...cutResultPayload(text)];
}
function messagePayload(
  message: WireMessage,
  { systemsExpanded, fullResults }: InputOptions,
): PayloadLine[] {
  const tone = Object.hasOwn(ROLE_TONES, message.role) ? ROLE_TONES[message.role] : "chrome";
  if (message.role === "tool") {
    return toolResultMessagePayload(message, fullResults);
  }
  if (isSystem(message)) {
    const lines = contentText(message.content).split("\n");
    const heading = { kind: "heading" as const, tone, text: message.role.toUpperCase() };
    if (systemsExpanded) {
      return [heading, ...contentPayload(message.content), { kind: "meta", text: "s to hide" }];
    }
    const more = lines.length - 1;
    const shown: PayloadLine[] = [
      heading,
      { kind: "text", text: lines[0], indent: 0, role: "plain" },
    ];
    if (more > 0) {
      shown.push({ kind: "meta", text: `… (+${more} more ${plural(more, "line")} · s to show)` });
    }
    return shown;
  }
  return [
    {
      kind: "heading",
      tone,
      text: [message.role.toUpperCase(), message.name, message.toolCallId]
        .filter(Boolean)
        .join(" · "),
    },
    ...(message.content === null ? [] : contentPayload(message.content)),
    ...(message.toolCalls ?? []).flatMap((call) => [
      {
        kind: "heading" as const,
        tone: "tool" as const,
        text: `TOOL CALL · ${call.name ?? "tool"} · ${call.id ?? "no call ID"}`,
      },
      ...valuePayload(call.arguments),
    ]),
  ];
}
