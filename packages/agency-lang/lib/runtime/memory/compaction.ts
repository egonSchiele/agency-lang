import type * as smoltalk from "smoltalk";
import compactionTemplate from "../../templates/prompts/memory/compaction.js";
import mergeSummaryTemplate from "../../templates/prompts/memory/mergeSummary.js";

export type CompactionConfig = {
  trigger: "token" | "messages";
  threshold: number;
};

function estimateTokens(messages: smoltalk.Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    const content =
      typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    chars += content.length;
  }
  // rough estimate: 1 token ≈ 4 characters
  return Math.ceil(chars / 4);
}

export function shouldCompact(
  messages: smoltalk.Message[],
  config: CompactionConfig
): boolean {
  if (config.trigger === "messages") {
    return messages.length > config.threshold;
  }
  return estimateTokens(messages) > config.threshold;
}

/**
 * Find a safe split point that respects message boundaries.
 *
 * Per resolved decision #5: walk forward from the midpoint until the
 * boundary message is a `user` message — so we never split between an
 * `assistant` with `tool_calls` and its corresponding `tool` replies.
 *
 * Returns the index of the message that should be the FIRST kept message
 * (i.e., everything before this index is compacted).
 *
 * Returns -1 if no clean boundary exists (caller should skip compacting).
 */
export function findCompactionSplitPoint(messages: smoltalk.Message[]): number {
  const midpoint = Math.floor(messages.length / 2);
  for (let i = midpoint; i < messages.length; i++) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

export function buildCompactionPrompt(messages: smoltalk.Message[]): string {
  const conversationText = messages
    .map(
      (m) =>
        `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
    )
    .join("\n");
  return compactionTemplate({ conversationText });
}

export function buildMergeSummaryPrompt(
  existingSummary: string,
  newSummary: string,
): string {
  return mergeSummaryTemplate({ existingSummary, newSummary });
}
