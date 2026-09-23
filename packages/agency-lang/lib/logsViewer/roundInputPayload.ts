import {
  contentText,
  messagesOf,
  normalizeMessage,
  type WireMessage,
} from "../statelog/wireAccessors.js";
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

/** Read the entire recorded input, including history and tool replies. */
export function roundInputPayload(round: Round, systemsExpanded: boolean): PayloadLine[] {
  const event = round.node.event!;
  if (!Array.isArray(event.data.messages))
    return [{ kind: "meta", text: "Input messages were not recorded." }];
  const messages = messagesOf(event).map(normalizeMessage);
  if (messages.length === 0) return [{ kind: "meta", text: "No input messages." }];
  return messages.flatMap((message) => [
    ...messagePayload(message, systemsExpanded),
    { kind: "blank" as const },
  ]);
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
      ...(systemsExpanded ? valuePayload(message.content) : []),
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
    ...(message.content === null ? [] : valuePayload(message.content)),
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
