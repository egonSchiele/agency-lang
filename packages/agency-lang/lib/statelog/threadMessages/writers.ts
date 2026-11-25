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

/** How many runs' writers a base context keeps, so a resume in the same
 *  process continues its run's writer instead of logging every thread whole. */
export const MAX_KEPT_LOG_WRITERS = 20;

/** The writers a base context keeps, by run id. `order` lists the run ids
 *  from least to most recently used. A kept writer only saves bytes: a
 *  run whose writer was dropped logs each thread whole on its next call. */
export type KeptLogWriters = { order: string[]; byRunId: Record<string, LogWriterState> };

export function newKeptLogWriters(): KeptLogWriters {
  return { order: [], byRunId: {} };
}

/** The writer for a run id: the kept one, or a new one. Marks the run id as
 *  most recently used and drops the least recently used past the limit.
 *  Changes `kept`. */
export function writerForRun(kept: KeptLogWriters, runId: string): LogWriterState {
  const writer = Object.hasOwn(kept.byRunId, runId) ? kept.byRunId[runId] : newLogWriter();
  kept.byRunId[runId] = writer;
  kept.order = [...kept.order.filter((id) => id !== runId), runId];
  while (kept.order.length > MAX_KEPT_LOG_WRITERS) {
    const [dropped, ...rest] = kept.order;
    delete kept.byRunId[dropped];
    kept.order = rest;
  }
  return writer;
}
