// The statelog account-management API, sealed here. This is the only file that
// knows the `/api/*` routes, the `Result` envelope, statelog's wire field names,
// and — critically — the split between the public project slug (`project_id`) and
// the internal database id (`id`). Callers speak only the public slug; the
// internal id never leaves this file. Every failure — network, HTTP, JSON,
// schema, or a `success:false` body — surfaces as an AccountRequestError.

import { z } from "zod";
import { statelogRequest } from "./statelogRequest.js";
import type { StatelogFailure } from "./statelogRequest.js";
import {
  accountSpendRowSchema,
  toSpendQuery,
  type AccountSpendRow,
  type SpendWindow,
} from "./spendTypes.js";

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

type KeySummaryBase = {
  id: string;
  name: string | null;
  createdAt: string;
};

/** A key summary in public terms: a project key's `projectId` is the slug (the
 *  client has already translated it from the internal id). */
export type KeySummary =
  | (KeySummaryBase & { scope: "account"; projectId: null })
  | (KeySummaryBase & { scope: "project"; projectId: string });

export type CreatedKey = KeySummary & { plainKey: string };

export type CreateProjectKeyInput = {
  name: string;
  projectId: string;
};

/** A project as statelog sends it, with the internal id kept private. */
type RawProject = {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
};

/** A key as statelog sends it: a project key's `projectId` is the internal
 *  database id, never exposed past this file. */
type RawKeySummary =
  | (KeySummaryBase & { scope: "account"; projectId: null })
  | (KeySummaryBase & { scope: "project"; projectId: string });

/** Any account request that did not produce a usable result. */
export class AccountRequestError extends Error {}
/** A 403 whose server error is the known account-scope error. The command layer
 *  decorates it with the resolved API-key env var name; this file never knows
 *  that name. */
export class AccountScopeError extends AccountRequestError {}

const ACCOUNT_SCOPE_ERROR = "This endpoint requires an account-scoped API key";

// Wire schemas for statelog's account shapes. A project key's `projectId` here
// is the internal database id (a string); the internal→slug translation happens
// after parsing.
const whoamiSchema = z.object({ userId: z.string() });

const rawProjectSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});

const keyBaseSchema = { id: z.string(), name: z.string().nullable(), createdAt: z.string() };
const rawKeySummarySchema = z.discriminatedUnion("scope", [
  z.object({ ...keyBaseSchema, scope: z.literal("account"), projectId: z.null() }),
  z.object({ ...keyBaseSchema, scope: z.literal("project"), projectId: z.string() }),
]);

export type AccountClient = {
  whoami(): Promise<{ userId: string }>;
  listProjects(): Promise<ProjectSummary[]>;
  createProject(input: CreateProjectInput): Promise<ProjectSummary>;
  listKeys(): Promise<KeySummary[]>;
  createProjectKey(input: CreateProjectKeyInput): Promise<CreatedKey>;
  getAccountSpend(window: SpendWindow): Promise<AccountSpendRow[]>;
};

type AccountRoute = "whoami" | "projects" | "api_keys" | "spend";

/** One account request: a POST body, an optional query, and — for a route a host
 *  may not have yet — the message to raise on a 404 that means the route is
 *  unsupported. */
type AccountRequestOptions = {
  body?: unknown;
  query?: Record<string, string>;
  unsupportedRouteMessage?: string;
};

function accountRouteUrl(
  origin: string,
  route: AccountRoute,
  query: Record<string, string> | undefined,
): string {
  const url = new URL(`/api/${route}`, origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export function createAccountClient(origin: string, apiKey: string): AccountClient {
  function toAccountError(
    failure: StatelogFailure,
    unsupportedRouteMessage: string | undefined,
  ): AccountRequestError {
    switch (failure.kind) {
      case "unreachable":
        return new AccountRequestError(`could not reach ${origin} (${failure.cause})`);
      case "http":
        if (failure.status === 403 && failure.serverError === ACCOUNT_SCOPE_ERROR) {
          return new AccountScopeError(ACCOUNT_SCOPE_ERROR);
        }
        // A 404 on a route the caller flagged host-optional means the host
        // predates it — before the generic server-error branch, so a `{error}`
        // 404 body does not mask it (account routes have no project-not-found
        // case).
        if (failure.status === 404 && unsupportedRouteMessage !== undefined) {
          return new AccountRequestError(unsupportedRouteMessage);
        }
        if (failure.serverError !== undefined) {
          return new AccountRequestError(failure.serverError);
        }
        if (failure.status === 401) {
          return new AccountRequestError("not authenticated (HTTP 401)");
        }
        return new AccountRequestError(`statelog request failed (HTTP ${failure.status})`);
      case "non-json":
        return new AccountRequestError(failure.diagnostic);
      case "bad-envelope":
        return new AccountRequestError("unexpected account response shape");
      case "envelope-error":
        return new AccountRequestError(failure.serverError ?? "account request failed");
    }
  }

  async function request(
    method: "GET" | "POST",
    route: AccountRoute,
    options: AccountRequestOptions = {},
  ): Promise<unknown> {
    const result = await statelogRequest({
      method,
      url: accountRouteUrl(origin, route, options.query),
      apiKey,
      // POST has always serialized `{}` for an absent body; GET sends none.
      body: method === "POST" ? (options.body ?? {}) : undefined,
    });
    if (!result.ok) {
      throw toAccountError(result.failure, options.unsupportedRouteMessage);
    }
    return result.value;
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
        body: {
          name: input.name,
          project_id: input.projectId,
          description: input.description ?? null,
        },
      });
      return toProjectSummary(validateRawProject(value));
    },
    async listKeys() {
      const projects = await listProjectsRaw();
      const value = await request("GET", "api_keys");
      const slugById = slugByInternalId(projects);
      return asArray(value, "api_keys").map((entry) =>
        toKeySummary(validateRawKeySummary(entry), slugById),
      );
    },
    async createProjectKey(input) {
      const projects = await listProjectsRaw();
      const match = projects.find((project) => project.project_id === input.projectId);
      if (!match) {
        throw new AccountRequestError(`unknown project '${input.projectId}'`);
      }
      const value = await request("POST", "api_keys", {
        body: {
          name: input.name,
          scope: "project",
          projectId: match.id,
        },
      });
      return validateCreatedKey(value, slugByInternalId(projects));
    },
    async getAccountSpend(window) {
      const value = await request("GET", "spend", {
        query: toSpendQuery(window),
        unsupportedRouteMessage:
          "this statelog host does not support the spend API (upgrade the host)",
      });
      return parseValue(z.array(accountSpendRowSchema), value);
    },
  };
}

function toProjectSummary(raw: RawProject): ProjectSummary {
  return { projectId: raw.project_id, name: raw.name, description: raw.description };
}

function validateWhoami(value: unknown): { userId: string } {
  return parseValue(whoamiSchema, value);
}

function validateRawProject(value: unknown): RawProject {
  return parseValue(rawProjectSchema, value);
}

/** internal id → public slug, so a listed key's project can be shown by slug.
 *  Null-prototype: the keys are server-provided ids, so an id like `__proto__`
 *  or `constructor` must be a plain data property, not a prototype write. */
function slugByInternalId(projects: RawProject[]): Record<string, string> {
  const map: Record<string, string> = Object.create(null);
  for (const project of projects) {
    map[project.id] = project.project_id;
  }
  return map;
}

function validateRawKeySummary(value: unknown): RawKeySummary {
  return parseValue(rawKeySummarySchema, value);
}

/** Validate a wire value against a schema, surfacing any failure as an
 *  AccountRequestError with the offending field path so the message stays
 *  actionable. */
function parseValue<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new AccountRequestError(
      `unexpected account response value: ${where}${issue?.message ?? "invalid"}`,
    );
  }
  return result.data;
}

/** Replace a project key's internal id with its public slug (or a placeholder
 *  when the project no longer exists — never the raw id). */
function toKeySummary(raw: RawKeySummary, slugById: Record<string, string>): KeySummary {
  if (raw.scope === "account") {
    return {
      id: raw.id,
      name: raw.name,
      createdAt: raw.createdAt,
      scope: "account",
      projectId: null,
    };
  }
  return {
    id: raw.id,
    name: raw.name,
    createdAt: raw.createdAt,
    scope: "project",
    projectId: slugById[raw.projectId] ?? "(unknown project)",
  };
}

function validateCreatedKey(value: unknown, slugById: Record<string, string>): CreatedKey {
  const summary = toKeySummary(validateRawKeySummary(value), slugById);
  const obj = asObject(value);
  if (!obj || typeof obj.plainKey !== "string") {
    throw new AccountRequestError("created key missing plainKey");
  }
  return { ...summary, plainKey: obj.plainKey };
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
