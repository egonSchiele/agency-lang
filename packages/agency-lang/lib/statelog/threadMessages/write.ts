/*
 * The writer's rule for a `promptCompletion`'s messages: log the whole list
 * on a thread's first call, and afterwards only what changed since this
 * writer's previous call on the thread. See "Messages: full copies and
 * changes" in docs/dev/hosting/statelog.md.
 */
import { canonicalize } from "../../utils/canonicalize.js";
import type { ChangeFields, FullCopyFields } from "../wireTypes.js";

/** A thread's full message list is logged again on its first call and
 *  then every this many calls, so a lost remote upload leaves a gap that
 *  ends at the next full copy. */
export const FULL_COPY_EVERY_CALLS = 50;

/** What one writer last logged for one thread. */
export type LoggedThread = { call: number; messageKeys: string[] };

/**
 * The message fields of one `promptCompletion`, and the record the caller
 * stores for the thread's next call.
 *
 * Messages are compared with their keys sorted, because a message restored
 * from a checkpoint can come back with its keys in another order. The
 * comparison is otherwise exact: a reader copies the kept messages from the
 * earlier event, so a looser rule would hand back an earlier version of a
 * message.
 */
export function messageFieldsFor(args: {
  previous: LoggedThread | undefined;
  logWriter: string;
  messages: unknown[];
}): { fields: FullCopyFields | ChangeFields; logged: LoggedThread } {
  const { previous, logWriter, messages } = args;
  const messageKeys = messages.map(canonicalize);
  const call = (previous?.call ?? 0) + 1;
  const logged = { call, messageKeys };
  const kept =
    previous === undefined || isFullCopyCall(call)
      ? 0
      : commonStartLength(previous.messageKeys, messageKeys);
  if (kept === 0) {
    return { fields: { messages, logWriter, threadCall: call }, logged };
  }
  return {
    fields: { keptMessages: kept, newMessages: messages.slice(kept), logWriter, threadCall: call },
    logged,
  };
}

function isFullCopyCall(call: number): boolean {
  return (call - 1) % FULL_COPY_EVERY_CALLS === 0;
}

function commonStartLength(before: string[], now: string[]): number {
  const limit = Math.min(before.length, now.length);
  let length = 0;
  while (length < limit && before[length] === now[length]) {
    length += 1;
  }
  return length;
}
