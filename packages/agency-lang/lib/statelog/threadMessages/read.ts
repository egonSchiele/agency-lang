/*
 * Rebuilding a `promptCompletion`'s whole message list from the change
 * events the writer logs (see write.ts). A rebuilt event looks like a full
 * copy, so readers keep reading `data.messages`. See "Messages: full copies
 * and changes" in docs/dev/hosting/statelog.md.
 */
import type { EventEnvelope } from "../wireTypes.js";

/** What a reader has rebuilt so far, by trace, writer, and thread. */
export type RebuildState = Record<string, { call: number; messages: unknown[] }>;

/** The fields every tracked `promptCompletion` carries, full copy or change. */
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
 * looks complete.
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
  const kept: number = data.keptMessages;
  const newMessages: unknown[] = Array.isArray(data.newMessages) ? data.newMessages : [];
  const { newMessages: _new, ...rest } = data;
  const base = state[key];
  const canRebuild =
    base !== undefined && base.call === threadCall - 1 && base.messages.length >= kept;
  if (!canRebuild) {
    delete state[key];
    return { ...event, data: { ...rest, messages: newMessages, missingMessages: kept } };
  }
  const messages = base.messages.slice(0, kept).concat(newMessages);
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
  const data = event.data;
  if (
    data.type !== "promptCompletion" ||
    typeof data.logWriter !== "string" ||
    typeof data.threadCall !== "number" ||
    typeof data.threadIdentity !== "string"
  ) {
    return null;
  }
  return {
    key: JSON.stringify([event.trace_id, data.logWriter, data.threadIdentity]),
    threadCall: data.threadCall,
  };
}
