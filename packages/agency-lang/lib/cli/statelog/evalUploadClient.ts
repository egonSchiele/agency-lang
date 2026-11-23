// The statelog eval-upload API, sealed here: one trace's upload state, bulk
// event ingest with source order, and annotation upsert. This is the only
// file that knows the routes, body shapes, and response envelopes. The
// server owns the classification of a trace's state; the client only parses
// it into `RemoteTraceState`, and `eval upload` decides what is safe to do.

import { z } from "zod";

import type { Annotation } from "@/runDirectory/annotations.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";

import { statelogRequest, type StatelogFailure } from "./statelogRequest.js";

/**
 * What the server holds for a trace, as proven by the server:
 * - `missing`: no such trace.
 * - `empty`: the trace exists with no log rows.
 * - `live`: only rows without a bulk `sequence` (streamed while running).
 * - `bulk-prefix`: every row is sequenced and they are exactly
 *   `0..nextSequence-1`, so an upload may resume at `nextSequence`.
 * - `invalid`: mixed live and bulk rows, or duplicate or gapped sequences;
 *   nothing can be added without risking a duplicated or torn trace.
 */
export type RemoteTraceState =
  | { kind: "missing" }
  | { kind: "empty" }
  | { kind: "live"; eventCount: number }
  | { kind: "bulk-prefix"; eventCount: number; nextSequence: number }
  | { kind: "invalid"; eventCount: number; reason: string };

/** One event with its position in the trace's file, 0-based. */
export type SequencedEvent = { sequence: number; envelope: EventEnvelope };

export type EvalUploadClient = {
  traceUploadState(traceId: string): Promise<RemoteTraceState>;
  /** At most `EVENTS_PER_REQUEST` events and `MAX_REQUEST_BYTES` of events
   *  (split with `requestChunks`). An empty list creates the trace. */
  postEvents(traceId: string, events: readonly SequencedEvent[]): Promise<void>;
  /** Upsert by deterministic id; the server recomputes the id before writing. */
  postAnnotations(rows: readonly Annotation[]): Promise<void>;
};

export const EVENTS_PER_REQUEST = 500;

/** Counts the events as sent, not the small request wrapper; kept under
 *  statelog's 5 MiB JSON body limit. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

type RequestLimits = { maxEvents: number; maxBytes: number };

const DEFAULT_LIMITS: RequestLimits = {
  maxEvents: EVENTS_PER_REQUEST,
  maxBytes: MAX_REQUEST_BYTES,
};

function toWireEvent(entry: SequencedEvent): { sequence: number; event: EventEnvelope } {
  return { sequence: entry.sequence, event: entry.envelope };
}

function wireBytes(entry: SequencedEvent): number {
  return Buffer.byteLength(JSON.stringify(toWireEvent(entry)));
}

function mebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Splits events into the requests `postEvents` accepts. Throws, before
 *  anything is sent, if one event alone is over the byte limit: statelog
 *  could never accept it, and a partial upload could never be finished. */
export function requestChunks(
  events: readonly SequencedEvent[],
  limits: RequestLimits = DEFAULT_LIMITS,
): SequencedEvent[][] {
  const chunks: SequencedEvent[][] = [];
  let current: SequencedEvent[] = [];
  let currentBytes = 0;
  for (const event of events) {
    const bytes = wireBytes(event);
    if (bytes > limits.maxBytes) {
      throw new EvalUploadError(
        `event ${event.sequence} is ${mebibytes(bytes)}, over the ` +
          `${mebibytes(limits.maxBytes)} request limit; this run cannot be uploaded`,
      );
    }
    const full = current.length === limits.maxEvents || currentBytes + bytes > limits.maxBytes;
    if (current.length > 0 && full) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(event);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export class EvalUploadError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const remoteTraceStateSchema: z.ZodType<RemoteTraceState> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing") }),
  z.object({ kind: z.literal("empty") }),
  z.object({ kind: z.literal("live"), eventCount: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal("bulk-prefix"),
    eventCount: z.number().int().nonnegative(),
    nextSequence: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("invalid"),
    eventCount: z.number().int().nonnegative(),
    reason: z.string(),
  }),
]);

/** A bulk prefix is exactly `0..nextSequence-1`, so the two counts must
 *  agree; a server that says otherwise cannot be resumed safely. */
function consistentState(state: RemoteTraceState): RemoteTraceState {
  if (state.kind === "bulk-prefix" && state.eventCount !== state.nextSequence) {
    throw new EvalUploadError(
      `unexpected upload-state response: bulk-prefix has ${state.eventCount} events ` +
        `but nextSequence ${state.nextSequence}`,
    );
  }
  return state;
}

export function createEvalUploadClient(
  origin: string,
  projectSlug: string,
  apiKey: string,
): EvalUploadClient {
  function routeUrl(segments: string[]): string {
    const path = ["api", "projects", projectSlug, ...segments].map(encodeURIComponent).join("/");
    return new URL(`/${path}`, origin).toString();
  }

  function toUploadError(failure: StatelogFailure): EvalUploadError {
    switch (failure.kind) {
      case "unreachable":
        return new EvalUploadError(`could not reach ${origin} (${failure.cause})`);
      case "http":
        if (failure.status === 404) {
          if (failure.serverError === "Project not found") {
            return new EvalUploadError(
              `project '${projectSlug}' not found — check the slug, or that it's deployed`,
              404,
            );
          }
          return new EvalUploadError(
            "this statelog host does not support eval upload (upgrade the host)",
            404,
          );
        }
        return new EvalUploadError(
          failure.serverError ?? `statelog request failed (HTTP ${failure.status})`,
          failure.status,
        );
      case "non-json":
        return new EvalUploadError(failure.diagnostic, failure.status);
      case "bad-envelope":
        return new EvalUploadError("unexpected eval upload response shape", failure.status);
      case "envelope-error":
        return new EvalUploadError(
          failure.serverError ?? "eval upload request failed",
          failure.status,
        );
    }
  }

  async function request(
    method: "GET" | "POST",
    segments: string[],
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const result = await statelogRequest({ method, url: routeUrl(segments), apiKey, body });
    if (!result.ok) {
      throw toUploadError(result.failure);
    }
    return result.value;
  }

  return {
    async traceUploadState(traceId) {
      const value = await request("GET", ["traces", traceId, "upload-state"]);
      const parsed = remoteTraceStateSchema.safeParse(value);
      if (!parsed.success) {
        throw new EvalUploadError(
          `unexpected upload-state response: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        );
      }
      return consistentState(parsed.data);
    },
    async postEvents(traceId, events) {
      if (events.length > EVENTS_PER_REQUEST) {
        throw new EvalUploadError(
          `postEvents: ${events.length} events in one request; the limit is ${EVENTS_PER_REQUEST}`,
        );
      }
      const bytes = events.reduce((total, entry) => total + wireBytes(entry), 0);
      if (bytes > MAX_REQUEST_BYTES) {
        throw new EvalUploadError(
          `postEvents: ${mebibytes(bytes)} of events in one request; ` +
            `the limit is ${mebibytes(MAX_REQUEST_BYTES)}`,
        );
      }
      await request("POST", ["logs", "bulk"], { traceId, events: events.map(toWireEvent) });
    },
    async postAnnotations(rows) {
      await request("POST", ["annotations"], { annotations: rows });
    },
  };
}
