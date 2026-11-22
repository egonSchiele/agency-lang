import type { MessageJSON } from "smoltalk";
import { currentRun } from "../runtime/asyncContext.js";
import type { Checkpoint } from "../runtime/state/checkpointStore.js";
import { isPlainObject } from "../utils/isPlainObject.js";
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

/** `existing` with `entry` added, as a new array. A run starts with no
 *  list. An empty entry adds nothing.
 *
 *  A session saved before the list existed is never resumed: a saved run
 *  whose core code changed cannot continue (`canResume`). So a run with no
 *  list is always a new one, and its list starts empty. */
export function withEntry(
  existing: TranscriptMessage[] | null,
  entry: TranscriptMessage,
): TranscriptMessage[] {
  const before = existing ?? [];
  return entry.content === "" ? before : [...before, entry];
}

function isEntry(value: unknown): value is TranscriptMessage {
  return (
    isPlainObject(value) &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.content === "string"
  );
}

// A session file is JSON on disk that a person or another front-end can
// edit, and search reads 50 of them at once, so a bad entry is dropped.
function asTranscript(value: unknown): TranscriptMessage[] | null {
  return Array.isArray(value) ? value.filter(isEntry) : null;
}

/** The list saved in a checkpoint, or null when it has none. */
export function transcriptIn(checkpoint: Checkpoint): TranscriptMessage[] | null {
  return asTranscript(checkpoint.globals.store?.[TRANSCRIPT_MODULE]?.[MESSAGES_KEY]);
}

/** Add one entry to the current run's transcript. */
export function _addToTranscript(role: "user" | "assistant", content: string): void {
  const run = currentRun();
  const existing = asTranscript(run.globals.get(TRANSCRIPT_MODULE, MESSAGES_KEY));
  run.globals.set(TRANSCRIPT_MODULE, MESSAGES_KEY, withEntry(existing, { role, content }));
}
