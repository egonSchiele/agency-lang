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
import { readJsonBody } from "./jsonBody.js";

export type SourceFile = { name: string; contents: string };

/** One deployed file's metadata, from the API-key-readable listing. `hasSource`
 *  false marks the legacy rows that break the `/source` route; an empty
 *  `bundleEntrypoints` marks a row untracked by bundle replacement. */
export type ProjectFile = {
  id: string;
  fileName: string;
  nodeNames: string[];
  hasSource: boolean;
  bundleEntrypoints: string[];
  updatedAt: string;
};

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

const projectFileSchema: z.ZodType<ProjectFile> = z.object({
  id: z.string().min(1),
  fileName: z.string(),
  nodeNames: z.array(z.string()),
  hasSource: z.boolean(),
  bundleEntrypoints: z.array(z.string()),
  updatedAt: z.string(),
});

export type ProjectClient = {
  pullSource(): Promise<SourceFile[]>;
  listFiles(): Promise<ProjectFile[]>;
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
  async function request(input: ProjectRequest): Promise<unknown> {
    const url = projectRouteUrl(origin, projectSlug, input.segments, input.query);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (error) {
      throw new ProjectRequestError(`could not reach ${origin} (${message(error)})`);
    }

    const parsed = await readJsonBody(response, { method: "GET", url });

    // Non-2xx first: auth middleware returns a bare `{ error }`, not an envelope.
    if (!response.ok) {
      const serverError = parsed.ok ? asObject(parsed.value)?.error : undefined;
      if (response.status === 404) {
        // A missing project always carries statelog's known JSON error. Any
        // OTHER 404 on a route the caller flagged as host-optional means the
        // host predates that route; without such a flag, keep the historical
        // project-not-found message.
        if (serverError !== "Project not found" && input.unsupportedRouteMessage !== undefined) {
          throw new ProjectRequestError(input.unsupportedRouteMessage);
        }
        throw new ProjectRequestError(
          `project '${projectSlug}' not found — check the slug, or that it's deployed`,
        );
      }
      if (typeof serverError === "string") {
        throw new ProjectRequestError(serverError);
      }
      if (response.status === 401) {
        throw new ProjectRequestError("not authenticated (HTTP 401)");
      }
      throw new ProjectRequestError(`statelog request failed (HTTP ${response.status})`);
    }

    if (!parsed.ok) {
      throw new ProjectRequestError(parsed.error);
    }
    const envelope = validateEnvelope(parsed.value);
    if (!envelope.success) {
      throw new ProjectRequestError(
        typeof envelope.error === "string" ? envelope.error : "project request failed",
      );
    }
    return envelope.value;
  }

  return {
    async pullSource() {
      return parseWire(sourceBundleSchema, await request({ segments: ["source"] })).files;
    },
    async listFiles() {
      return parseWire(
        z.array(projectFileSchema),
        await request({
          segments: ["agency_files"],
          unsupportedRouteMessage:
            "this statelog host does not support the file listing API (upgrade the host)",
        }),
      );
    },
    async listTraces() {
      return parseWire(z.array(traceSummarySchema), await request({ segments: ["traces"] }));
    },
    async traceLogs(traceId) {
      // Validate the argument BEFORE the request (an empty id would pass the
      // viewer's truthiness check nowhere).
      const requested = parseWire(
        z.string().min(1, "trace id must not be empty"),
        traceId,
      );
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
        unsupportedRouteMessage: "this statelog host does not support the spend API (upgrade the host)",
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

function validateEnvelope(value: unknown): { success: boolean; value?: unknown; error?: unknown } {
  const obj = asObject(value);
  if (!obj || typeof obj.success !== "boolean") {
    throw new ProjectRequestError("unexpected project response shape");
  }
  return obj as { success: boolean; value?: unknown; error?: unknown };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
