import {
  contentText,
  messagesOf,
  normalizeMessage,
  type WireMessage,
} from "../statelog/wireAccessors.js";
import type { HistoryRewrite, RoundDelta } from "./messageDelta.js";
import { valuePayload, type PayloadLine } from "./payload.js";
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
};

/** Whether the call carries messages a previous call on its thread sent. */
export function hasHistory(round: Round | undefined, delta: RoundDelta | undefined): boolean {
  return (
    round !== undefined &&
    delta !== undefined &&
    delta.added.length < messagesOf(round.node.event!).length
  );
}

/** Read the recorded input. With the call's delta, the messages the
 *  previous call on the thread already had are history: by default only
 *  the last of them appears, faded, as its heading and first line with a
 *  dots line counting the rest, so the reader keeps the thread without
 *  the bulk; expanded, the whole history is faded with a divider marking
 *  where the new messages start. */
export function roundInputPayload(
  round: Round,
  { systemsExpanded, historyExpanded }: InputOptions,
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
    ...messagePayload(message, systemsExpanded),
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
  if (!historyExpanded) {
    const stub = messagePayload(messages[newFrom - 1], false);
    // A folded prompt in the stub cannot be opened, so drop the key hint.
    const heading = { ...stub[0], text: stub[0].text.replace(/ · s to show$/, "") };
    const shown = [heading, ...firstBodyLine(stub.slice(1))];
    const lines = [...shown, dots(newFrom - 1, delta?.rewrite), { kind: "blank" as const }];
    return { lines: [...lines.map((line) => ({ ...line, faded: true })), ...fresh], newAt: 0 };
  }
  return {
    lines: [...history, divider(newFrom, fresh.length > 0, delta?.rewrite), ...fresh],
    newAt: history.length,
  };
}

/** The first line of a message's body, as one plain line. */
function firstBodyLine(lines: PayloadLine[]): PayloadLine[] {
  const first = lines.find((line) => line.kind !== "blank");
  if (first === undefined) {
    return [];
  }
  if (first.kind === "table") {
    return [{ kind: "text", text: first.columns.join("  "), indent: 0, role: "plain" }];
  }
  if (first.kind === "pair") {
    return [{ kind: "text", text: `${first.key}: ${first.text}`, indent: 0, role: "plain" }];
  }
  if (first.kind === "heading") {
    return [first];
  }
  return [{ kind: "text", text: first.text.split("\n")[0], indent: 0, role: "plain" }];
}

function dots(moreEarlier: number, rewrite: HistoryRewrite | undefined): PayloadLine {
  const notes = [
    ...(rewrite === undefined
      ? []
      : [`history changed from message ${rewrite.firstChangedAt + 1}`]),
    ...(moreEarlier === 0
      ? []
      : [`+${moreEarlier} earlier ${moreEarlier === 1 ? "message" : "messages"}`]),
  ];
  return { kind: "meta", text: notes.length === 0 ? "…" : `… (${notes.join(", ")})` };
}

function divider(
  earlier: number,
  anyNew: boolean,
  rewrite: HistoryRewrite | undefined,
): PayloadLine {
  const parts = [
    ...(rewrite === undefined
      ? []
      : [`HISTORY CHANGED from message ${rewrite.firstChangedAt + 1}`]),
    `${earlier} earlier ${earlier === 1 ? "message" : "messages"} above`,
    anyNew ? "NEW" : "NOTHING NEW",
  ];
  return { kind: "heading", tone: "chrome", text: `── ${parts.join(" · ")} ──` };
}

/** A message's content as the reader wrote it: the text of each text
 *  part, with any other part (an image, say) shown as its fields. */
function contentPayload(content: unknown): PayloadLine[] {
  if (!Array.isArray(content)) {
    return valuePayload(content);
  }
  return content.flatMap((part) => {
    const text = typeof part === "string" ? part : partRecord(part).text;
    return valuePayload(typeof text === "string" ? text : part);
  });
}
function partRecord(part: unknown): Record<string, unknown> {
  return part !== null && typeof part === "object" ? (part as Record<string, unknown>) : {};
}
function isSystem(message: WireMessage): boolean {
  return message.role === "system" || message.role === "developer";
}
function messagePayload(message: WireMessage, systemsExpanded: boolean): PayloadLine[] {
  const tone = Object.hasOwn(ROLE_TONES, message.role) ? ROLE_TONES[message.role] : "chrome";
  if (isSystem(message)) {
    const count = contentText(message.content).split("\n").length;
    const name = message.role === "system" ? "System prompt" : "Developer prompt";
    return [
      {
        kind: "heading",
        tone,
        text: `${name} · ${count} ${count === 1 ? "line" : "lines"} · s to ${systemsExpanded ? "hide" : "show"}`,
      },
      ...(systemsExpanded ? contentPayload(message.content) : []),
    ];
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
