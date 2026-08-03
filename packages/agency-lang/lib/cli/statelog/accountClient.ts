// The statelog account-management API, sealed here. This is the only file that
// knows the `/api/*` routes, the `Result` envelope, statelog's wire field names,
// and — critically — the split between the public project slug (`project_id`) and
// the internal database id (`id`). Callers speak only the public slug; the
// internal id never leaves this file. Every failure — network, HTTP, JSON,
// schema, or a `success:false` body — surfaces as an AccountRequestError.

export type ProjectSummary = {
  projectId: string;
  name: string;
  description: string | null;
};

export type CreateProjectInput = {
  name: string;
  projectId: string;
  description?: string;
};

/** A project as statelog sends it, with the internal id kept private. */
type RawProject = {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
};

/** Any account request that did not produce a usable result. */
export class AccountRequestError extends Error {}
/** A 403 whose server error is the known account-scope error. The command layer
 *  decorates it with the resolved API-key env var name; this file never knows
 *  that name. */
export class AccountScopeError extends AccountRequestError {}

const ACCOUNT_SCOPE_ERROR = "This endpoint requires an account-scoped API key";

export type AccountClient = {
  whoami(): Promise<{ userId: string }>;
  listProjects(): Promise<ProjectSummary[]>;
  createProject(input: CreateProjectInput): Promise<ProjectSummary>;
};

type AccountRoute = "whoami" | "projects" | "api_keys";

function accountRouteUrl(origin: string, route: AccountRoute): string {
  return new URL(`/api/${route}`, origin).toString();
}

export function createAccountClient(origin: string, apiKey: string): AccountClient {
  async function request(
    method: "GET" | "POST",
    route: AccountRoute,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    const init: RequestInit = { method, headers };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body ?? {});
    }

    let response: Response;
    try {
      response = await fetch(accountRouteUrl(origin, route), init);
    } catch (error) {
      throw new AccountRequestError(`could not reach ${origin} (${message(error)})`);
    }

    let json: unknown;
    let parsed = true;
    try {
      json = await response.json();
    } catch {
      parsed = false;
    }

    // Non-2xx first: auth middleware returns a bare `{ error }`, not an envelope.
    if (!response.ok) {
      const serverError = parsed ? asObject(json)?.error : undefined;
      if (response.status === 403 && serverError === ACCOUNT_SCOPE_ERROR) {
        throw new AccountScopeError(ACCOUNT_SCOPE_ERROR);
      }
      if (typeof serverError === "string") {
        throw new AccountRequestError(serverError);
      }
      if (response.status === 401) {
        throw new AccountRequestError("not authenticated (HTTP 401)");
      }
      throw new AccountRequestError(`statelog request failed (HTTP ${response.status})`);
    }

    if (!parsed) {
      throw new AccountRequestError(
        `statelog returned a non-JSON response (HTTP ${response.status})`,
      );
    }
    const envelope = asObject(json);
    if (!envelope || typeof envelope.success !== "boolean") {
      throw new AccountRequestError("unexpected account response shape");
    }
    if (!envelope.success) {
      throw new AccountRequestError(
        typeof envelope.error === "string" ? envelope.error : "account request failed",
      );
    }
    return envelope.value;
  }

  async function listProjectsRaw(): Promise<RawProject[]> {
    const value = await request("GET", "projects");
    return asArray(value, "projects").map(validateRawProject);
  }

  return {
    async whoami() {
      return validateWhoami(await request("GET", "whoami"));
    },
    async listProjects() {
      return (await listProjectsRaw()).map(toProjectSummary);
    },
    async createProject(input) {
      const value = await request("POST", "projects", {
        name: input.name,
        project_id: input.projectId,
        description: input.description ?? null,
      });
      return toProjectSummary(validateRawProject(value));
    },
  };
}

function toProjectSummary(raw: RawProject): ProjectSummary {
  return { projectId: raw.project_id, name: raw.name, description: raw.description };
}

function validateWhoami(value: unknown): { userId: string } {
  const obj = asObject(value);
  if (!obj || typeof obj.userId !== "string") {
    throw new AccountRequestError("whoami response missing userId");
  }
  return { userId: obj.userId };
}

function validateRawProject(value: unknown): RawProject {
  const obj = asObject(value);
  if (!obj) {
    throw new AccountRequestError("each project entry must be an object");
  }
  const id = requireString(obj.id, "project id");
  const project_id = requireString(obj.project_id, "project project_id");
  const name = requireString(obj.name, "project name");
  if (obj.description !== null && typeof obj.description !== "string") {
    throw new AccountRequestError("project description must be a string or null");
  }
  return { id, project_id, name, description: obj.description };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new AccountRequestError(`${label} must be an array`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new AccountRequestError(`${label} must be a string`);
  }
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
