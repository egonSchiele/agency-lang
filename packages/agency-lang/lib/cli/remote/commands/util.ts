// Command-error presentation, API-key lookup, and account-target resolution,
// shared by the remote command recipes. Owns exit/error output; never renders
// successful values.

import { color } from "@/utils/termcolors.js";
import type { AgencyConfig } from "@/config.js";
import { buildServeAddress, canonicalOrigin } from "../../statelog/serveUrl.js";
import type { ServeAddress } from "../../statelog/serveUrl.js";
import { createAccountClient } from "../../statelog/accountClient.js";
import { createProjectClient } from "../../statelog/projectClient.js";
import type { HostedAgentInfo } from "../../statelog/projectClient.js";
import { AccountScopeError } from "../../statelog/accountClient.js";

/** What every remote command needs: the resolved config and the path it came
 *  from, for messages that point the user at the right file. */
export type RemoteCommandContext = {
  config: AgencyConfig;
  configPath: string;
};

const DEFAULT_API_KEY_ENV = "STATELOG_API_KEY";

/** The API key together with the environment variable it came from, so a command
 *  can name that variable in its guidance without the HTTP client knowing it. */
export type ResolvedApiKey = {
  apiKey: string;
  apiKeyEnvName: string;
};

/** An account-management target: a canonical origin plus the resolved key. */
export type AccountTarget = ResolvedApiKey & {
  origin: string;
};

/** Options common to every account-management command. */
export type AccountCommandOptions = {
  host?: string;
  apiKeyEnv?: string;
};

/** A project-read command additionally selects a project by slug. */
export type ProjectCommandOptions = AccountCommandOptions & {
  project?: string;
};

/** An account target with the project slug these reads operate on. */
export type ProjectTarget = AccountTarget & {
  projectSlug: string;
};

/** Print an error and exit non-zero. Typed `never` so callers can use it in an
 *  expression position (`const x = maybe() ?? fail(...)`). */
export function fail(message: string): never {
  console.error(color.red(message));
  process.exit(1);
}

/** The API key and its variable name, or exit with a clear message. The key is
 *  only ever read from the environment, never a flag. */
export function resolveApiKey(options: { apiKeyEnv?: string }): ResolvedApiKey {
  const apiKeyEnvName = options.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const apiKey = process.env[apiKeyEnvName];
  if (!apiKey) {
    fail(`Missing API key — set $${apiKeyEnvName}.`);
  }
  return { apiKey, apiKeyEnvName };
}

/** The API key value alone, for callers that do not need the variable name. */
export function apiKeyOrExit(options: { apiKeyEnv?: string }): string {
  return resolveApiKey(options).apiKey;
}

/** Resolve where an account-management command talks to: a canonical origin
 *  (from `--host`, then `agency.json` `log.host`) and the resolved API key.
 *  Exits with a clear message on a missing or invalid origin, or a missing
 *  key. */
export function resolveAccountTarget(
  context: RemoteCommandContext,
  options: { host?: string; apiKeyEnv?: string },
): AccountTarget {
  const origin = resolveOrigin(context, options);
  return { origin, ...resolveApiKey(options) };
}

/** The canonical origin alone (from `--host`, then `agency.json` `log.host`),
 *  with no credential access. Split out so a project command can validate its
 *  CLI input — origin and slug — BEFORE touching the key. */
function resolveOrigin(context: RemoteCommandContext, options: { host?: string }): string {
  const selected = options.host ?? context.config.log?.host;
  if (!selected) {
    fail("No statelog host. Set log.host in agency.json, or pass --host.");
  }
  const origin = canonicalOrigin(selected);
  if (!origin) {
    fail(
      `Invalid statelog host "${selected}". Use an HTTP(S) origin with no path, credentials, query, or fragment.`,
    );
  }
  return origin;
}

/** Origin plus slug, from flags or `agency.json`; no credential access. */
export type ProjectLocation = { origin: string; projectSlug: string };

export function resolveProjectLocation(
  context: RemoteCommandContext,
  options: { host?: string; project?: string },
): ProjectLocation {
  const origin = resolveOrigin(context, options);
  const projectSlug = resolveProjectSlug(context, options);
  return { origin, projectSlug };
}

/** Resolve a project target: origin, slug, and key. The API key is read LAST,
 *  so a CLI-input error (missing host, empty or absent project) is reported
 *  even with the key unset — no credential access before the input is known
 *  good. */
export function resolveProjectTarget(
  context: RemoteCommandContext,
  options: ProjectCommandOptions,
): ProjectTarget {
  const location = resolveProjectLocation(context, options);
  return { ...location, ...resolveApiKey(options) };
}

function resolveProjectSlug(context: RemoteCommandContext, options: { project?: string }): string {
  if (options.project !== undefined) {
    if (options.project.length === 0) {
      fail("--project must not be empty.");
    }
    return options.project;
  }
  const configured = context.config.log?.projectId;
  if (configured) {
    return configured;
  }
  fail("No project. Set log.projectId in agency.json, or pass --project <slug>.");
}

/** A project target plus the deployed agent and its serve address. */
export type ServeTarget = ProjectTarget & { address: ServeAddress; agent: HostedAgentInfo };

const AGENCY_SUFFIX = ".agency";

/** The serve address of the project's deployed agent: user id from `whoami`,
 *  file from the project's entry point. Exits when nothing is deployed or a
 *  lookup fails. */
export async function resolveServeTarget(
  context: RemoteCommandContext,
  options: ProjectCommandOptions,
): Promise<ServeTarget> {
  const target = resolveProjectTarget(context, options);
  let userId: string;
  let agent: HostedAgentInfo;
  try {
    ({ userId } = await createAccountClient(target.origin, target.apiKey).whoami());
    agent = await createProjectClient(
      target.origin,
      target.projectSlug,
      target.apiKey,
    ).fetchAgentInfo();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const { entryPoint } = agent;
  if (entryPoint === null) {
    fail(
      `Nothing is deployed to project ${target.projectSlug} on ${target.origin}. Run 'agency remote deploy <file>' first.`,
    );
  }
  const filename = entryPoint.endsWith(AGENCY_SUFFIX)
    ? entryPoint.slice(0, -AGENCY_SUFFIX.length)
    : entryPoint;
  const address = buildServeAddress({
    origin: target.origin,
    userId,
    projectId: target.projectSlug,
    filename,
  });
  return { ...target, address, agent };
}

/** Turn a project-read command error into a clean CLI exit. The client is
 *  responsible for secret-free messages; pull errors already carry their
 *  committed-destinations context. No command prints a caught stack. */
export function failProjectCommand(error: unknown): never {
  if (error instanceof Error) {
    fail(error.message);
  }
  fail(String(error));
}

/** Write exactly one JSON document to stdout and nothing else, so `--json`
 *  output is never contaminated by prose or ANSI. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Turn a client error into a clean CLI exit. An AccountScopeError becomes
 *  guidance naming the resolved API-key variable — the one place that knows both
 *  the scope error (from the client) and the variable name (from the target). */
export function failAccount(error: unknown, apiKeyEnvName: string): never {
  if (error instanceof AccountScopeError) {
    fail(
      `$${apiKeyEnvName} is a project-scoped key; this needs an account-scoped key. Create one in the statelog web UI.`,
    );
  }
  if (error instanceof Error) {
    fail(error.message);
  }
  fail(String(error));
}
