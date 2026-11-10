// Compaction for `agency agent`: replace the older part of a session's
// conversation with a summary, between turns. The agent's own module
// (lib/agents/agency-agent/lib/compaction.agency) decides when and writes
// the summary; this file reads the thread and rewrites it.
// See docs/dev/agents/agent-compaction.md.
import * as smoltalk from "smoltalk";
import { agency } from "../runtime/agency.js";
import { expiryOf } from "../runtime/state/messageMetadata.js";
import type { MessageThread } from "../runtime/state/messageThread.js";
import { reasoningChars } from "../runtime/reasoningSize.js";
import { _contentToString } from "./threads.js";

// A rough size for text the provider has not counted yet.
const CHARS_PER_TOKEN = 4;

// A tool result is cut to this many characters in the text the summarizer
// reads. The summary needs what a tool found, and rarely the whole output.
const MAX_TOOL_RESULT_CHARS = 2000;

// The summary is a user message, the first one after the head. It is not a
// system message: a model wrote it from a transcript that holds web pages
// and file contents, so it has the standing of the conversation it
// replaces. It also means the conversation starts with a user message even
// when the kept part starts with an assistant message, which some
// providers require.
export const SUMMARY_PREFIX =
  "[Summary of the earlier conversation. The messages it covers were removed to save space.]\n\n";

/** How to rewrite a thread: `head`, then a summary of `summarized`, then
 *  `kept`. */
export type CompactionPlan = {
  /** The system messages the thread starts with. */
  head: smoltalk.Message[];
  /** The summary a previous compaction left, or null. */
  previousSummary: string | null;
  /** The older messages the summary replaces. */
  summarized: smoltalk.Message[];
  /** The recent messages that stay as they are. */
  kept: smoltalk.Message[];
};

function toolCallsText(message: smoltalk.Message): string {
  if (message.role !== "assistant") {
    return "";
  }
  const calls = message.toolCalls ?? [];
  return calls.map((call) => `${call.name}(${JSON.stringify(call.arguments)})`).join("\n");
}

function contentText(message: smoltalk.Message): string {
  return _contentToString(message.toJSON().content);
}

function isSummary(message: smoltalk.Message): boolean {
  return message.role === "user" && contentText(message).startsWith(SUMMARY_PREFIX);
}

function messageText(message: smoltalk.Message): string {
  const content = contentText(message);
  return [content, toolCallsText(message)].filter((part) => part !== "").join("\n");
}

/** Counts each message's text, tool calls, and reasoning record, which goes
 *  back to the model. The summarizer's transcript leaves the reasoning out. */
export function estimateTokens(messages: smoltalk.Message[]): number {
  const chars = messages.reduce(
    (total, message) => total + messageText(message).length + reasoningChars(message),
    0,
  );
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function usageTokens(usage: smoltalk.TokenUsage): number {
  const input = usage.inputTokens + (usage.cachedInputTokens ?? 0);
  return input + (usage.cacheCreationInputTokens ?? 0) + usage.outputTokens;
}

/** The size of the next request on this thread, in tokens: what the
 *  provider counted for the last reply, plus an estimate for the messages
 *  after it. An estimate of everything when no reply carries a count. */
export function contextTokens(messages: smoltalk.Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant" && message.usage !== undefined) {
      return usageTokens(message.usage) + estimateTokens(messages.slice(index + 1));
    }
  }
  return estimateTokens(messages);
}

/** The index of the first message to keep, so the kept messages are about
 *  `keepTokens` long. The kept part starts at a user message when one is
 *  close enough, and otherwise at an assistant message. It never starts at
 *  a tool result, which would be cut off from the call it answers. Returns
 *  0 when everything fits, or when no message can start the kept part. */
function firstKeptIndex(conversation: smoltalk.Message[], keepTokens: number): number {
  let fits = conversation.length;
  let tokens = 0;
  while (fits > 0) {
    const withNext = tokens + estimateTokens([conversation[fits - 1]]);
    if (withNext > keepTokens) {
      break;
    }
    tokens = withNext;
    fits--;
  }
  if (fits === 0) {
    return 0;
  }
  for (const role of ["user", "assistant"]) {
    const index = conversation.findIndex((message, at) => at >= fits && message.role === role);
    if (index !== -1) {
      return index;
    }
  }
  return 0;
}

/** Plan a compaction that keeps about `keepTokens` of recent messages.
 *  Null when there is nothing older to summarize. */
export function planCompaction(
  messages: smoltalk.Message[],
  keepTokens: number,
): CompactionPlan | null {
  const firstOther = messages.findIndex((message) => message.role !== "system");
  const headEnd = firstOther === -1 ? messages.length : firstOther;
  const afterHead = messages.slice(headEnd);
  const oldSummary = afterHead.length > 0 && isSummary(afterHead[0]) ? afterHead[0] : null;
  const conversation = oldSummary === null ? afterHead : afterHead.slice(1);

  const cut = firstKeptIndex(conversation, keepTokens);
  const older = conversation.slice(0, cut);
  // A message that expires is removed by its owner later. It stays in the
  // thread, and its text stays out of the summary.
  const summarized = older.filter((message) => expiryOf(message) === null);
  if (summarized.length === 0) {
    return null;
  }
  const expiring = older.filter((message) => expiryOf(message) !== null);
  return {
    head: messages.slice(0, headEnd),
    previousSummary:
      oldSummary === null ? null : contentText(oldSummary).slice(SUMMARY_PREFIX.length),
    summarized,
    kept: [...expiring, ...conversation.slice(cut)],
  };
}

function transcriptLine(message: smoltalk.Message): string {
  const text = messageText(message);
  const tooLong = message.role === "tool" && text.length > MAX_TOOL_RESULT_CHARS;
  const shown = tooLong ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[cut]` : text;
  return `[${message.role}] ${shown}`;
}

/** The messages as text for the summarizer. */
export function transcriptText(messages: smoltalk.Message[]): string {
  return messages.map(transcriptLine).join("\n\n");
}

/** A kept reply without its token count. The count is what the provider
 *  saw before the compaction, so `contextTokens` would report the old size
 *  from it. A copy is made, because threads share message objects. */
function withoutUsage(message: smoltalk.Message): smoltalk.Message {
  if (message.role !== "assistant" || message.usage === undefined) {
    return message;
  }
  return smoltalk.AssistantMessage.fromJSON({ ...message.toJSON(), usage: undefined });
}

/** The messages a plan leaves in the thread. */
export function compactedMessages(plan: CompactionPlan, summary: string): smoltalk.Message[] {
  const summaryMessage = smoltalk.userMessage(`${SUMMARY_PREFIX}${summary}`);
  return [...plan.head, summaryMessage, ...plan.kept.map(withoutUsage)];
}

/** The thread `thread(session: name)` opens, or null before it exists. */
function sessionThread(session: string): MessageThread | null {
  const store = agency.thread.storeMaybe();
  const id = store?.sessions[session];
  if (store === undefined || store === null || id === undefined) {
    return null;
  }
  return store.threads[id] ?? null;
}

/** The size of the session's next request, in tokens. 0 before the
 *  session's thread exists. */
export function _contextTokens(session: string): number {
  const thread = sessionThread(session);
  return thread === null ? 0 : contextTokens(thread.getMessages());
}

/** What the summarizer reads for a compaction of `session`. */
export type CompactionInput = {
  transcript: string;
  /** "" when no earlier compaction left a summary. */
  previousSummary: string;
  messageCount: number;
};

/** The text to summarize, or null when there is nothing older than
 *  `keepTokens` of recent messages. */
export function _compactionInput(session: string, keepTokens: number): CompactionInput | null {
  const thread = sessionThread(session);
  const plan = thread === null ? null : planCompaction(thread.getMessages(), keepTokens);
  if (plan === null) {
    return null;
  }
  return {
    transcript: transcriptText(plan.summarized),
    previousSummary: plan.previousSummary ?? "",
    messageCount: plan.summarized.length,
  };
}

/** Replace the messages `_compactionInput` described with `summary`.
 *  Returns how many messages the summary replaced, 0 when the thread no
 *  longer has anything to compact. Call it with the same `keepTokens`, and
 *  with no turn run on the session in between. */
export function _applyCompaction(session: string, keepTokens: number, summary: string): number {
  const thread = sessionThread(session);
  const plan = thread === null ? null : planCompaction(thread.getMessages(), keepTokens);
  if (thread === null || plan === null) {
    return 0;
  }
  thread.setMessages(compactedMessages(plan, summary));
  return plan.summarized.length;
}
