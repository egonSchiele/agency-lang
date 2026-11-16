// The conversation a program's first thread starts with, from `agency run
// --messages` (docs/dev/runtime/spawn.md). This file only edits a list of
// messages. Reading the seed is the platform's job (`takeSeedMessages`).

import type * as smoltalk from "smoltalk";
import { MessageThread } from "./state/messageThread.js";
import type { ThreadStore } from "./state/threadStore.js";
import { keepToolCalls, unansweredToolCalls } from "./threadRepair.js";

/** The messages to seed a thread with: `raw` with every tool call in its
 *  last assistant message that has no result removed. A provider refuses
 *  a conversation that ends on a call with no result, which is how a
 *  conversation looks at the moment a model starts a process by calling a
 *  tool. A message left with no text and no calls is removed. Throws when
 *  `raw` is not a list. */
export function seedFrom(raw: unknown): smoltalk.Message[] {
  if (!Array.isArray(raw)) {
    throw new Error("the seed messages must be a JSON list of messages");
  }
  const thread = MessageThread.fromJSON(raw);
  const dangling = unansweredToolCalls(thread).map((call) => call.id);
  if (dangling.length === 0) {
    return thread.getMessages();
  }
  const lastAssistant = thread.getMessages().findLastIndex((m) => m.role === "assistant");
  keepToolCalls(thread, lastAssistant, (call) => !dangling.includes(call.id));
  return thread.getMessages();
}

/** Put `raw`'s messages, after `seedFrom`, on the store's first thread. */
export function seedFirstThread(threads: ThreadStore, raw: unknown): void {
  const first = threads.getOrCreateActive();
  for (const message of seedFrom(raw)) {
    first.push(message);
  }
}
