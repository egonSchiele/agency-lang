import type { Fields, OccurrenceOrigin } from "../types.js";

/** What a loader produces. No dataset paths, no JSONL, no ids: a loader describes
 *  candidates and knows nothing about durability. */
export type LoadedOccurrence = {
  fields: Fields;
  source: string;
  origin: OccurrenceOrigin;
};

export type IngestSkipReason =
  | "empty"
  | "too-large"
  | "not-utf8"
  | "symlink"
  | "run-failed"
  | "record-unreadable"
  | "legacy-record"
  | "missing-trace-id"
  | "invalid-task"
  | "no-output"
  | "truncated-output";

/** `item` names the thing that was rejected — a relative file path, an array
 *  index, or an eval input id — so a skip line is actionable without guessing. */
export type IngestSkip = {
  item: string;
  reason: IngestSkipReason;
};

export type LoadedBatch = {
  occurrences: readonly LoadedOccurrence[];
  skips: readonly IngestSkip[];
};

/** Which traces a statelog source promotes. */
export type StatelogSelectionRequest = {
  traceIds: readonly string[];
};

/** Interactive-free selection carried on an ingest request. `statelog` sources
 *  name the traces to promote; every other source needs none. */
export type IngestSelection =
  | { kind: "none" }
  | { kind: "statelog"; request: StatelogSelectionRequest };

/** A screen cannot show more than this, and a value this large is far more
 *  likely to be a mistake than real output. */
export const DEFAULT_MAX_INGEST_BYTES = 1_048_576;

/** A source that produced nothing. Distinguished from an ordinary failure so
 *  the CLI can explain what was searched rather than printing a bare error. */
export class EmptyIngestError extends Error {}

/** The source path cannot be turned into candidates: a glob matching nothing,
 *  a file that is not the format it claims, an unreadable directory. */
export class IngestSourceError extends Error {}
