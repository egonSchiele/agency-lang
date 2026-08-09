// The statelog schedules API (`/api/projects/:slug/schedules*`), sealed here.
// This is the only file that knows those routes, the wire DTO, the `Result`
// envelope, and the transport failure shapes. Callers hand in declarative
// create/patch values and get validated schedules back; every failure surfaces
// as a ScheduleRequestError carrying the server message and, when the failure
// came from an HTTP response, its status. statelog can report a failure inside
// an HTTP 200 (`{ success: false, error }`), so callers must never judge
// success by status — this client already does not.

import { z } from "zod";
import { readJsonBody } from "./jsonBody.js";

export type ScheduleTarget = {
  kind: "node" | "function";
  name: string;
};

export type CreateScheduleInput = {
  fileName: string;
  target: ScheduleTarget;
  args: Record<string, unknown>;
  cronExpr: string;
  timezone: string;
  name?: string | null;
};

export type PatchScheduleInput = {
  enabled?: boolean;
  cronExpr?: string;
  timezone?: string;
};

export type RemoteSchedule = {
  id: string;
  name: string | null;
  fileName: string;
  targetKind: "node" | "function";
  targetName: string;
  args: Record<string, unknown>;
  cronExpr: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
};

export class ScheduleRequestError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export type SchedulesClient = {
  create(input: CreateScheduleInput): Promise<RemoteSchedule>;
  list(): Promise<RemoteSchedule[]>;
  patch(id: string, patch: PatchScheduleInput): Promise<RemoteSchedule>;
  delete(id: string): Promise<{ deleted: true }>;
};

// statelog's ScheduledJobDTO is already camelCase; `args` stays opaque past
// being an object.
const remoteScheduleSchema: z.ZodType<RemoteSchedule> = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  fileName: z.string(),
  targetKind: z.enum(["node", "function"]),
  targetName: z.string(),
  args: z.record(z.string(), z.unknown()),
  cronExpr: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const deletedSchema = z.object({ deleted: z.literal(true) });

type ScheduleRequest = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  segments: string[];
  body?: Record<string, unknown>;
};

export function createSchedulesClient(
  origin: string,
  projectSlug: string,
  apiKey: string,
): SchedulesClient {
  function routeUrl(segments: string[]): string {
    const path = ["api", "projects", projectSlug, "schedules", ...segments]
      .map(encodeURIComponent)
      .join("/");
    return new URL(`/${path}`, origin).toString();
  }

  async function request(input: ScheduleRequest): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    const init: RequestInit = { method: input.method, headers };
    if (input.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(input.body);
    }

    const url = routeUrl(input.segments);
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new ScheduleRequestError(`could not reach ${origin} (${message(error)})`);
    }

    const parsed = await readJsonBody(response, { method: input.method, url });

    // Non-2xx first: auth middleware returns a bare `{ error }`, not an envelope.
    if (!response.ok) {
      const serverError = parsed.ok ? asObject(parsed.value)?.error : undefined;
      if (typeof serverError === "string") {
        throw new ScheduleRequestError(serverError, response.status);
      }
      throw new ScheduleRequestError(
        `statelog request failed (HTTP ${response.status})`,
        response.status,
      );
    }

    if (!parsed.ok) {
      throw new ScheduleRequestError(parsed.error, response.status);
    }
    const envelope = asObject(parsed.value);
    if (!envelope || typeof envelope.success !== "boolean") {
      throw new ScheduleRequestError("unexpected schedules response shape", response.status);
    }
    if (!envelope.success) {
      throw new ScheduleRequestError(
        typeof envelope.error === "string" ? envelope.error : "schedules request failed",
        response.status,
      );
    }
    return envelope.value;
  }

  return {
    async create(input) {
      const body: Record<string, unknown> = {
        fileName: input.fileName,
        targetKind: input.target.kind,
        targetName: input.target.name,
        args: input.args,
        cronExpr: input.cronExpr,
        timezone: input.timezone,
      };
      if (input.name !== undefined) {
        body.name = input.name;
      }
      return parseWire(
        remoteScheduleSchema,
        await request({ method: "POST", segments: [], body }),
      );
    },
    async list() {
      return parseWire(
        z.array(remoteScheduleSchema),
        await request({ method: "GET", segments: [] }),
      );
    },
    async patch(id, patch) {
      return parseWire(
        remoteScheduleSchema,
        await request({ method: "PATCH", segments: [id], body: { ...patch } }),
      );
    },
    async delete(id) {
      return parseWire(
        deletedSchema,
        await request({ method: "DELETE", segments: [id] }),
      );
    },
  };
}

function parseWire<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ScheduleRequestError(
      `unexpected schedules response value: ${result.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return result.data;
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
