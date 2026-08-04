// The statelog project-read API (`/api/projects/:slug/*`), sealed here. This is
// the only file that knows those routes, the `Result` envelope, statelog's wire
// field names, and the three failure layers (project 404, wrong-project 403, and
// the HTTP-success `Trace not found`). Callers speak the public slug and get
// validated typed values; every failure surfaces as a ProjectRequestError.

import { z } from "zod";

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
};

/** Build a `/api/projects/:slug/…` URL, encoding the slug and every segment
 *  independently — never concatenate a partly-encoded pathname. */
function projectRouteUrl(origin: string, slug: string, ...segments: string[]): string {
  const path = ["api", "projects", slug, ...segments].map(encodeURIComponent).join("/");
  return new URL(`/${path}`, origin).toString();
}

export function createProjectClient(
  origin: string,
  projectSlug: string,
  apiKey: string,
): ProjectClient {
  async function request(...segments: string[]): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(projectRouteUrl(origin, projectSlug, ...segments), {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (error) {
      throw new ProjectRequestError(`could not reach ${origin} (${message(error)})`);
    }

    const parsed = await parseResponseJson(response);

    // Non-2xx first: auth middleware returns a bare `{ error }`, not an envelope.
    if (!response.ok) {
      const serverError = parsed.ok ? asObject(parsed.value)?.error : undefined;
      if (response.status === 404) {
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
      throw new ProjectRequestError(
        `statelog returned a non-JSON response (HTTP ${response.status})`,
      );
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
      return parseWire(sourceBundleSchema, await request("source")).files;
    },
    async listTraces() {
      return parseWire(z.array(traceSummarySchema), await request("traces"));
    },
    async traceLogs(traceId) {
      // Validate the argument BEFORE the request (an empty id would pass the
      // viewer's truthiness check nowhere).
      const requested = parseWire(
        z.string().min(1, "trace id must not be empty"),
        traceId,
      );
      const logs = parseWire(z.array(traceLogSchema), await request("traces", requested, "logs"));
      for (const log of logs) {
        if (log.traceId !== requested) {
          throw new ProjectRequestError(
            `log trace_id '${log.traceId}' does not match the requested trace '${requested}'`,
          );
        }
      }
      return logs;
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

async function parseResponseJson(
  response: Response,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false };
  }
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
