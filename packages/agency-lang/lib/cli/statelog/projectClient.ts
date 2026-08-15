// The statelog project-read API (`/api/projects/:slug/*`), sealed here. This is
// the only file that knows those routes, the `Result` envelope, statelog's wire
// field names, and the three failure layers (project 404, wrong-project 403, and
// the HTTP-success `Trace not found`). Callers speak the public slug and get
// validated typed values; every failure surfaces as a ProjectRequestError.

import { z } from "zod";
import {
  projectSpendSchema,
  toSpendQuery,
  type ProjectSpend,
  type SpendWindow,
} from "./spendTypes.js";
import { statelogRequest } from "./statelogRequest.js";
import type { StatelogFailure } from "./statelogRequest.js";

export type SourceFile = { name: string; contents: string };

export type TraceSummary = { id: string; createdAt: string };

/** A statelog log row, narrowed to what the viewer bridge needs. `data` stays
 *  opaque past its `type` — the viewer parses it. */
export type TraceLog = {
  traceId: string;
  spanId: string | null;
  parentSpanId: string | null;
  data: { type: string } & Record<string, unknown>;
};

/** Any project request that did not produce a usable result. */
export class ProjectRequestError extends Error {}

// Wire schemas: statelog's snake_case shapes, mapped to the camelCase types
// above. `.passthrough()` on `data` keeps it opaque past `type` (the viewer
// parses the rest); `.min(1)` ids reject empty strings that would slip past a
// downstream truthiness check.
const sourceBundleSchema = z.object({
  files: z.array(z.object({ name: z.string(), contents: z.string() })),
});

const traceSummarySchema = z
  .object({ id: z.string().min(1), created_at: z.string() })
  .transform((trace) => ({ id: trace.id, createdAt: trace.created_at }));

const traceLogSchema = z
  .object({
    trace_id: z.string().min(1),
    span_id: z.string().nullable(),
    parent_span_id: z.string().nullable(),
    data: z.object({ type: z.string() }).passthrough(),
  })
  .transform((row) => ({
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    data: row.data as { type: string } & Record<string, unknown>,
  }));

export type ProjectClient = {
  pullSource(): Promise<SourceFile[]>;
  listTraces(): Promise<TraceSummary[]>;
  traceLogs(traceId: string): Promise<TraceLog[]>;
  getSpend(window: SpendWindow): Promise<ProjectSpend>;
};

/** A single project request: the path segments after `/api/projects/:slug`, an
 *  optional query, and — for a route a host may not have yet — the message to
 *  raise when an unknown 404 means the route is unsupported. */
type ProjectRequest = {
  segments: string[];
  query?: Record<string, string>;
  unsupportedRouteMessage?: string;
};

/** Build a `/api/projects/:slug/…` URL, encoding the slug and every segment
 *  independently — never concatenate a partly-encoded pathname — then append any
 *  query params. */
function projectRouteUrl(
  origin: string,
  slug: string,
  segments: string[],
  query: Record<string, string> | undefined,
): string {
  const path = ["api", "projects", slug, ...segments].map(encodeURIComponent).join("/");
  const url = new URL(`/${path}`, origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export function createProjectClient(
  origin: string,
  projectSlug: string,
  apiKey: string,
): ProjectClient {
  function toProjectError(
    failure: StatelogFailure,
    unsupportedRouteMessage: string | undefined,
  ): ProjectRequestError {
    switch (failure.kind) {
      case "unreachable":
        return new ProjectRequestError(`could not reach ${origin} (${failure.cause})`);
      case "http":
        if (failure.status === 404) {
          // A missing project always carries statelog's known JSON error. Any
          // OTHER 404 on a route the caller flagged as host-optional means the
          // host predates that route; without such a flag, keep the historical
          // project-not-found message.
          if (
            failure.serverError !== "Project not found" &&
            unsupportedRouteMessage !== undefined
          ) {
            return new ProjectRequestError(unsupportedRouteMessage);
          }
          return new ProjectRequestError(
            `project '${projectSlug}' not found — check the slug, or that it's deployed`,
          );
        }
        if (failure.serverError !== undefined) {
          return new ProjectRequestError(failure.serverError);
        }
        if (failure.status === 401) {
          return new ProjectRequestError("not authenticated (HTTP 401)");
        }
        return new ProjectRequestError(`statelog request failed (HTTP ${failure.status})`);
      case "non-json":
        return new ProjectRequestError(failure.diagnostic);
      case "bad-envelope":
        return new ProjectRequestError("unexpected project response shape");
      case "envelope-error":
        return new ProjectRequestError(failure.serverError ?? "project request failed");
    }
  }

  async function request(input: ProjectRequest): Promise<unknown> {
    const result = await statelogRequest({
      method: "GET",
      url: projectRouteUrl(origin, projectSlug, input.segments, input.query),
      apiKey,
    });
    if (!result.ok) {
      throw toProjectError(result.failure, input.unsupportedRouteMessage);
    }
    return result.value;
  }

  return {
    async pullSource() {
      return parseWire(sourceBundleSchema, await request({ segments: ["source"] })).files;
    },
    async listTraces() {
      return parseWire(z.array(traceSummarySchema), await request({ segments: ["traces"] }));
    },
    async traceLogs(traceId) {
      // Validate the argument BEFORE the request (an empty id would pass the
      // viewer's truthiness check nowhere).
      const requested = parseWire(z.string().min(1, "trace id must not be empty"), traceId);
      const logs = parseWire(
        z.array(traceLogSchema),
        await request({ segments: ["traces", requested, "logs"] }),
      );
      for (const log of logs) {
        if (log.traceId !== requested) {
          throw new ProjectRequestError(
            `log trace_id '${log.traceId}' does not match the requested trace '${requested}'`,
          );
        }
      }
      return logs;
    },
    async getSpend(window) {
      const value = await request({
        segments: ["spend"],
        query: toSpendQuery(window),
        unsupportedRouteMessage:
          "this statelog host does not support the spend API (upgrade the host)",
      });
      return parseWire(projectSpendSchema, value);
    },
  };
}

/** Validate a wire value against a schema, surfacing any failure as a
 *  ProjectRequestError (callers only care that it's the sealed error type). */
function parseWire<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ProjectRequestError(
      `unexpected project response value: ${result.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return result.data;
}
