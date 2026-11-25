/*
 * Test helpers: `promptCompletion` events as the writer logs them, so tests
 * of readers check the round trip through the real writer's rule.
 */
import type { EventEnvelope } from "../wireTypes.js";
import { messageFieldsFor, type LoggedThread } from "./write.js";

export const user = (content: string) => ({ role: "user", content });
export const reply = (content: string) => ({ role: "assistant", content });

export type WriteOptions = { trace?: string; writer?: string; thread?: string };

/** The events one writer logs for these message lists, one call each. */
export function writtenEvents(lists: unknown[][], opts: WriteOptions = {}): EventEnvelope[] {
  let previous: LoggedThread | undefined;
  return lists.map((messages) => {
    const { fields, logged } = messageFieldsFor({
      previous,
      logWriter: opts.writer ?? "w",
      messages,
    });
    previous = logged;
    return {
      format_version: 1,
      trace_id: opts.trace ?? "t",
      project_id: "",
      span_id: null,
      parent_span_id: null,
      data: {
        type: "promptCompletion",
        timestamp: "2026-11-25T00:00:00.000Z",
        threadIdentity: opts.thread ?? "th",
        ...fields,
      },
    };
  });
}

/** The three calls of a thread that asks "one", "two", "three". */
export const THREE_CALLS = [
  [user("one")],
  [user("one"), reply("r1"), user("two")],
  [user("one"), reply("r1"), user("two"), reply("r2"), user("three")],
];

/** `THREE_CALLS` as statelog lines. */
export function threeCallLines(opts: WriteOptions = {}): string[] {
  return writtenEvents(THREE_CALLS, opts).map((event) => JSON.stringify(event));
}
