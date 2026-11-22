import type { MessageJSON } from "smoltalk";
import { currentRun } from "../runtime/asyncContext.js";
import type { Checkpoint } from "../runtime/state/checkpointStore.js";
import { threadById } from "./agentCompaction.js";
import { _contentToString } from "./threads.js";

/**
 * A saved session's transcript: what the user typed and the agent's final
 * replies, in order. The session core adds an entry for each, and a
 * reopened session shows this list instead of the conversation thread,
 * which also holds notes, context blocks and the runtime's own messages.
 * See docs/dev/agents/agent-sessions.md.
 */
export type TranscriptMessage = { role: "user" | "assistant"; content: string };

type SavedMessage = { role?: string; content?: unknown };

// The list is kept in a globals module of its own, the way the fetch cache
// is (lib/runtime/fetchCache.ts), so every checkpoint saves it and every
// restore brings it back. The core adds to it at the top level of the run,
// so it is in the root globals and never in a branch's copy.
const TRANSCRIPT_MODULE = "__agentTranscript";
const MESSAGES_KEY = "messages";

/** The user and assistant messages that have text, as saved JSON holds
 *  them. Tool calls and results are left out. */
export function transcriptOfMessages(messages: SavedMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const text = _contentToString(message.content as MessageJSON["content"]);
    if (text !== "") {
      out.push({ role: message.role, content: text });
    }
  }
  return out;
}

/** `existing` with `entry` added. A session saved before the list existed
 *  has none, so its list starts from the thread's messages. An empty entry
 *  adds nothing. */
export function withEntry(
  existing: TranscriptMessage[] | null,
  threadMessages: SavedMessage[],
  entry: TranscriptMessage,
): TranscriptMessage[] {
  const before = existing ?? transcriptOfMessages(threadMessages);
  return entry.content === "" ? before : [...before, entry];
}

function asTranscript(value: unknown): TranscriptMessage[] | null {
  return Array.isArray(value) ? (value as TranscriptMessage[]) : null;
}

/** The list saved in a checkpoint, or null when it has none. */
export function transcriptIn(checkpoint: Checkpoint): TranscriptMessage[] | null {
  return asTranscript(checkpoint.globals.store?.[TRANSCRIPT_MODULE]?.[MESSAGES_KEY]);
}

/** Add one entry to the current run's transcript. `threadId` is the
 *  conversation's thread, read only when the run has no list yet. */
export function _addToTranscript(
  role: "user" | "assistant",
  content: string,
  threadId: string,
): void {
  const run = currentRun();
  const existing = asTranscript(run.globals.get(TRANSCRIPT_MODULE, MESSAGES_KEY));
  const thread = existing === null ? threadById(threadId) : null;
  // A live thread holds smoltalk messages. The loop reads saved JSON.
  const threadMessages = thread === null ? [] : thread.getMessages().map((m) => m.toJSON());
  run.globals.set(
    TRANSCRIPT_MODULE,
    MESSAGES_KEY,
    withEntry(existing, threadMessages, { role, content }),
  );
}
