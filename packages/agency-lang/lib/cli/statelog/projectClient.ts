// The statelog project-read API (`/api/projects/:slug/*`), sealed here. This is
// the only file that knows those routes, the `Result` envelope, statelog's wire
// field names, and the three failure layers (project 404, wrong-project 403, and
// the HTTP-success `Trace not found`). Callers speak the public slug and get
// validated typed values; every failure surfaces as a ProjectRequestError.

export type AgentFile = {
  name: string;
  nodeNames: string[];
  createdAt: string;
  updatedAt: string;
};

export type AgentMetadata = {
  entryPoint: string | null;
  lastUploadAt: string | null;
  files: AgentFile[];
};

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

export type ProjectClient = {
  inspectAgent(): Promise<AgentMetadata>;
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
    async inspectAgent() {
      return validateAgentMetadata(await request("agent"));
    },
    async pullSource() {
      return validateSourceFiles(await request("source"));
    },
    async listTraces() {
      return asArray(await request("traces"), "traces").map(validateTraceSummary);
    },
    async traceLogs(traceId) {
      // Validate the argument BEFORE the request (an empty id would pass the
      // viewer's truthiness check nowhere).
      const requested = requireNonEmptyString(traceId, "trace id");
      const value = await request("traces", requested, "logs");
      return asArray(value, "logs").map((row) => validateTraceLog(row, requested));
    },
  };
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

function validateAgentMetadata(value: unknown): AgentMetadata {
  const obj = asObject(value);
  if (!obj) {
    throw new ProjectRequestError("agent metadata must be an object");
  }
  return {
    entryPoint: nullableString(obj.entryPoint, "entryPoint"),
    lastUploadAt: nullableString(obj.lastUploadAt, "lastUploadAt"),
    files: asArray(obj.files, "agent files").map(validateAgentFile),
  };
}

function validateAgentFile(value: unknown): AgentFile {
  const obj = asObject(value);
  if (!obj) {
    throw new ProjectRequestError("each agent file must be an object");
  }
  return {
    name: requireString(obj.name, "file name"),
    nodeNames: requireStringArray(obj.nodeNames, "file nodeNames"),
    createdAt: requireString(obj.createdAt, "file createdAt"),
    updatedAt: requireString(obj.updatedAt, "file updatedAt"),
  };
}

function validateSourceFiles(value: unknown): SourceFile[] {
  const obj = asObject(value);
  if (!obj) {
    throw new ProjectRequestError("source response must be an object");
  }
  return asArray(obj.files, "source files").map((file) => {
    const fileObj = asObject(file);
    if (!fileObj) {
      throw new ProjectRequestError("each source file must be an object");
    }
    return {
      name: requireString(fileObj.name, "source file name"),
      contents: requireString(fileObj.contents, "source file contents"),
    };
  });
}

function validateTraceSummary(value: unknown): TraceSummary {
  const obj = asObject(value);
  if (!obj) {
    throw new ProjectRequestError("each trace must be an object");
  }
  return {
    id: requireNonEmptyString(obj.id, "trace id"),
    createdAt: requireString(obj.created_at, "trace created_at"),
  };
}

function validateTraceLog(value: unknown, requestedTraceId: string): TraceLog {
  const obj = asObject(value);
  if (!obj) {
    throw new ProjectRequestError("each log must be an object");
  }
  const traceId = requireNonEmptyString(obj.trace_id, "log trace_id");
  if (traceId !== requestedTraceId) {
    throw new ProjectRequestError(
      `log trace_id '${traceId}' does not match the requested trace '${requestedTraceId}'`,
    );
  }
  const data = asObject(obj.data);
  if (!data || typeof data.type !== "string") {
    throw new ProjectRequestError("log data must be an object with a string type");
  }
  return {
    traceId,
    spanId: nullableString(obj.span_id, "log span_id"),
    parentSpanId: nullableString(obj.parent_span_id, "log parent_span_id"),
    data: data as { type: string } & Record<string, unknown>,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProjectRequestError(`${label} must be an array`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ProjectRequestError(`${label} must be a string`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (text.length === 0) {
    throw new ProjectRequestError(`${label} must not be empty`);
  }
  return text;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : requireString(value, label);
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new ProjectRequestError(`${label} must be an array of strings`);
  }
  return value as string[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
