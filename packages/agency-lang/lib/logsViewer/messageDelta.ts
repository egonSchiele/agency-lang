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
};
export type RoundDelta = { roundId: string; added: WireMessage[]; rewrite?: HistoryRewrite };

export function messagesOf(round: Round): WireMessage[] {
  return round.node.event === undefined
    ? []
    : wireMessagesOf(round.node.event).map(normalizeMessage);
}
export function messageKey(message: WireMessage): string {
  return JSON.stringify([
    message.role,
    message.content ?? null,
    message.name ?? null,
    message.toolCalls ?? [],
    message.toolCallId ?? null,
  ]);
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
  if (
    before.length <= now.length &&
    before.every((message, position) => messageKey(message) === messageKey(now[position]))
  ) {
    return { roundId: round.id, added: now.slice(before.length) };
  }
  return {
    roundId: round.id,
    added: now,
    rewrite: {
      messagesBefore: before.length,
      messagesAfter: now.length,
      tokensBefore: previous.contextTokens,
      tokensAfter: round.contextTokens,
    },
  };
}
