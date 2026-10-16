import {
  messagesOf as wireMessagesOf,
  normalizeMessage,
  type WireMessage,
} from "../statelog/wireAccessors.js";
import type { Round } from "./timeline/rounds.js";
export type { WireMessage, ToolCallRequest } from "../statelog/wireAccessors.js";
export type HistoryRewrite = {
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  /** Position of the first message that differs from the previous round. */
  firstChangedAt: number;
};
export type RoundDelta = { roundId: string; added: WireMessage[]; rewrite?: HistoryRewrite };

export function messagesOf(round: Round): WireMessage[] {
  return round.node.event === undefined
    ? []
    : wireMessagesOf(round.node.event).map(normalizeMessage);
}
/** Messages compare as the text the model sees. A tool result saved as a
 *  value (an array of records, say) and the same result rebuilt as its
 *  JSON text are one message: smoltalk's `contentToString` on
 *  `BaseMessage` turns any non-string content into `JSON.stringify` of it
 *  before a provider sees it, and this restates that rule because the
 *  method is protected. Keep the two in step. */
export function messageKey(message: WireMessage): string {
  return JSON.stringify([
    message.role,
    contentKey(message.content),
    message.name ?? null,
    message.toolCalls ?? [],
    message.toolCallId ?? null,
  ]);
}
function contentKey(content: unknown): string | null {
  if (content === null || content === undefined) return null;
  return typeof content === "string" ? content : JSON.stringify(content);
}
export function roundDeltas(rounds: Round[]): RoundDelta[] {
  const lastOnThread: Record<string, Round> = Object.create(null);
  return rounds.map((round) => {
    const key = JSON.stringify([round.thread.kind, round.thread.id]);
    const previous = lastOnThread[key];
    lastOnThread[key] = round;
    return deltaFrom(previous, round);
  });
}
function deltaFrom(previous: Round | undefined, round: Round): RoundDelta {
  const now = messagesOf(round);
  if (previous === undefined) {
    return { roundId: round.id, added: now };
  }
  const before = messagesOf(previous);
  const firstChangedAt = before.findIndex(
    (message, position) =>
      position >= now.length || messageKey(message) !== messageKey(now[position]),
  );
  if (firstChangedAt === -1) {
    return { roundId: round.id, added: now.slice(before.length) };
  }
  // A rewrite: the messages before the first change are the same history
  // as last time, so only what follows it is new.
  return {
    roundId: round.id,
    added: now.slice(firstChangedAt),
    rewrite: {
      messagesBefore: before.length,
      messagesAfter: now.length,
      tokensBefore: previous.contextTokens,
      tokensAfter: round.contextTokens,
      firstChangedAt,
    },
  };
}
