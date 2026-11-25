/*
 * A writer of change events: one id, and what it last logged per thread.
 * A `StatelogClient` holds one. See "Messages: full copies and changes" in
 * docs/dev/hosting/statelog.md.
 */
import { nanoid } from "nanoid";
import type { LoggedThread } from "./write.js";

/** One writer of change events: its id, and what it last logged per thread. */
export type LogWriterState = { logWriter: string; threads: Record<string, LoggedThread> };

export function newLogWriter(): LogWriterState {
  return { logWriter: nanoid(12), threads: {} };
}
