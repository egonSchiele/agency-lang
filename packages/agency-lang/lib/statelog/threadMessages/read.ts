/*
 * Rebuilding a `promptCompletion`'s whole message list from the change
 * events the writer logs (see write.ts). A rebuilt event looks like a full
 * copy, so readers keep reading `data.messages`. See "Messages: full copies
 * and changes" in docs/dev/hosting/statelog.md.
 */
import { z } from "zod";
import { ChangeFieldsSchema, WriterFieldsSchema, type EventEnvelope } from "../wireTypes.js";

/** What a reader has rebuilt so far, by trace, writer, and thread. */
export type RebuildState = Record<string, { call: number; messages: unknown[] }>;

/** A `promptCompletion` a reader can follow from call to call: one on a
 *  thread with an identity, logged with the writer fields. */
const TrackedSchema = WriterFieldsSchema.extend({
  type: z.literal("promptCompletion"),
  threadIdentity: z.string(),
});

type Tracked = { key: string; threadCall: number };

/**
 * The event with `data.messages` holding the whole list. Changes `state`.
 * Returns any event that is not a tracked promptCompletion unchanged.
 *
 * When a change event's previous call is missing, or holds fewer messages
 * than it kept, the event gets only its new messages and
 * `missingMessages`, the number of messages at the start that are not in
 * the log. The thread's record is dropped, so every later change on it is
 * marked too, until the next full copy. A gap never yields a list that
 * looks complete. A change whose fields are malformed is returned as it is
 * and drops the record the same way.
 */
export function rebuildMessages(state: RebuildState, event: EventEnvelope): EventEnvelope {
  const tracked = trackedOf(event);
  if (tracked === null) {
    return event;
  }
  const { key, threadCall } = tracked;
  const data = event.data;
  if (typeof data.missingMessages === "number") {
    delete state[key];
    return event;
  }
  if (Array.isArray(data.messages)) {
    state[key] = { call: threadCall, messages: data.messages };
    return event;
  }
  const change = ChangeFieldsSchema.safeParse(data);
  if (!change.success) {
    delete state[key];
    return event;
  }
  const { keptMessages, newMessages } = change.data;
  const { newMessages: _new, ...rest } = data;
  const base = state[key];
  const canRebuild =
    base !== undefined && base.call === threadCall - 1 && base.messages.length >= keptMessages;
  if (!canRebuild) {
    delete state[key];
    return { ...event, data: { ...rest, messages: newMessages, missingMessages: keptMessages } };
  }
  const messages = base.messages.slice(0, keptMessages).concat(newMessages);
  state[key] = { call: threadCall, messages };
  return { ...event, data: { ...rest, messages } };
}

/**
 * Rebuilds every event of a batch whose events may be in any order, such
 * as a trace fetched from the server. Returns a new array with each event
 * at its original position. Events on different threads or writers are
 * independent, so one stable sort by `threadCall` puts every thread's
 * events in the order they were written.
 */
export function rebuildAllMessages(events: readonly EventEnvelope[]): EventEnvelope[] {
  const result = [...events];
  const trackedIndexes = events
    .flatMap((event, index) => {
      const tracked = trackedOf(event);
      return tracked === null ? [] : [{ index, threadCall: tracked.threadCall }];
    })
    .sort((a, b) => a.threadCall - b.threadCall)
    .map((entry) => entry.index);
  const state: RebuildState = {};
  for (const index of trackedIndexes) {
    result[index] = rebuildMessages(state, events[index]);
  }
  return result;
}

function trackedOf(event: EventEnvelope): Tracked | null {
  const parsed = TrackedSchema.safeParse(event.data);
  if (!parsed.success) {
    return null;
  }
  const { logWriter, threadIdentity, threadCall } = parsed.data;
  return { key: JSON.stringify([event.trace_id, logWriter, threadIdentity]), threadCall };
}
