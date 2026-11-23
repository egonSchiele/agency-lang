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
  /** At most `EVENTS_PER_REQUEST` events in a body of at most
   *  `MAX_REQUEST_BYTES` (split with `requestChunks`). An empty list creates
   *  the trace. */
  postEvents(traceId: string, events: readonly SequencedEvent[]): Promise<void>;
  /** Upsert by deterministic id; the server recomputes the id before writing. */
  postAnnotations(rows: readonly Annotation[]): Promise<void>;
};

export const EVENTS_PER_REQUEST = 500;

/** Statelog's JSON body limit (`express.json({ limit: "5mb" })`), measured
 *  on the exact body `postEvents` sends. */
export const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

type RequestLimits = { maxEvents: number; maxBytes: number };

const DEFAULT_LIMITS: RequestLimits = {
  maxEvents: EVENTS_PER_REQUEST,
  maxBytes: MAX_REQUEST_BYTES,
};

type WireEvent = { sequence: number; event: EventEnvelope };

function toWireEvent(entry: SequencedEvent): WireEvent {
  return { sequence: entry.sequence, event: entry.envelope };
}

function bulkBody(
  traceId: string,
  events: readonly SequencedEvent[],
): { traceId: string; events: WireEvent[] } {
  return { traceId, events: events.map(toWireEvent) };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Rounded up, so a size just over a limit never prints as equal to it. */
function mebibytes(bytes: number): string {
  return `${(Math.ceil((bytes / (1024 * 1024)) * 100) / 100).toFixed(2)} MiB`;
}

/** Splits events into the requests `postEvents` accepts, sizing each by its
 *  exact body. Throws, before anything is sent, if one event alone makes a
 *  request over the byte limit: statelog could never accept it, and a
 *  partial upload could never be finished. */
export function requestChunks(
  traceId: string,
  events: readonly SequencedEvent[],
  limits: RequestLimits = DEFAULT_LIMITS,
): SequencedEvent[][] {
  const emptyBytes = jsonBytes(bulkBody(traceId, []));
  const chunks: SequencedEvent[][] = [];
  let current: SequencedEvent[] = [];
  let currentBytes = emptyBytes;
  for (const event of events) {
    const bytes = jsonBytes(toWireEvent(event));
    if (emptyBytes + bytes > limits.maxBytes) {
      throw new EvalUploadError(
        `event ${event.sequence} is ${mebibytes(emptyBytes + bytes)}, over the ` +
          `${mebibytes(limits.maxBytes)} request limit; this run cannot be uploaded`,
      );
    }
    // +1 for the comma between events in the array.
    const full = current.length === limits.maxEvents || currentBytes + 1 + bytes > limits.maxBytes;
    if (current.length > 0 && full) {
      chunks.push(current);
      current = [];
      currentBytes = emptyBytes;
    }
    currentBytes += (current.length > 0 ? 1 : 0) + bytes;
    current.push(event);
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
      const body = bulkBody(traceId, events);
      const bytes = jsonBytes(body);
      if (bytes > MAX_REQUEST_BYTES) {
        throw new EvalUploadError(
          `postEvents: a ${mebibytes(bytes)} request; the limit is ${mebibytes(MAX_REQUEST_BYTES)}`,
        );
      }
      await request("POST", ["logs", "bulk"], body);
    },
    async postAnnotations(rows) {
      await request("POST", ["annotations"], { annotations: rows });
    },
  };
}
