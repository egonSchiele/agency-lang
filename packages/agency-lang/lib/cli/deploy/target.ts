// Resolving *where* an agent deploys to: the statelog host, project, and API
// key. These come from the same `log` config that observability already uses
// (agency.json), with flag and env overrides.

export type DeployTarget = {
  host: string;
  projectId: string;
  apiKey: string;
};

/** Human-readable origin of each resolved field, for the deploy summary. */
export type TargetProvenance = {
  host: string;
  projectId: string;
  apiKey: string;
};

export type TargetOverrides = {
  host?: string;
  project?: string;
  /** Name of the env var to read the API key from (never the key itself). */
  apiKeyEnv?: string;
};

/** The `log` section of AgencyConfig, narrowed to the fields deploy needs. */
export type LogConfig = {
  host?: string;
  projectId?: string;
  apiKey?: string;
};

export type ResolveTargetResult =
  | { ok: true; target: DeployTarget; provenance: TargetProvenance }
  | { ok: false; error: string };

const DEFAULT_HOST = "http://localhost:1065";
const DEFAULT_API_KEY_ENV = "STATELOG_API_KEY";

/**
 * Resolve the deploy target. Per field the precedence is flag > agency.json
 * `log.*` > env/default. The API key is env-first — read from an env var, never
 * passed as a flag — so it stays out of shell history and process listings.
 */
export function resolveDeployTarget(
  log: LogConfig | undefined,
  overrides: TargetOverrides,
  env: NodeJS.ProcessEnv,
): ResolveTargetResult {
  const logConfig = log ?? {};

  const host = overrides.host ?? logConfig.host ?? DEFAULT_HOST;
  let hostFrom: string;
  if (overrides.host) {
    hostFrom = "--host";
  } else if (logConfig.host) {
    hostFrom = "agency.json log.host";
  } else {
    hostFrom = `default (${DEFAULT_HOST})`;
  }

  const projectId = overrides.project ?? logConfig.projectId;
  const projectFrom = overrides.project ? "--project" : "agency.json log.projectId";

  const apiKey = resolveApiKey(logConfig, overrides.apiKeyEnv, env);

  const missing: string[] = [];
  if (!projectId) {
    missing.push("project (set log.projectId in agency.json, or pass --project)");
  }
  if (!apiKey.value) {
    missing.push(`API key (set ${apiKey.from}, or pass --api-key-env <NAME>)`);
  }
  if (missing.length > 0) {
    return { ok: false, error: `Cannot deploy — missing ${missing.join("; ")}.` };
  }

  return {
    ok: true,
    target: { host, projectId: projectId!, apiKey: apiKey.value! },
    provenance: { host: hostFrom, projectId: projectFrom, apiKey: apiKey.from },
  };
}

/** Env-first API-key resolution: an explicit `--api-key-env` wins, else the key
 *  baked in agency.json `log.apiKey`, else the conventional STATELOG_API_KEY. */
function resolveApiKey(
  log: LogConfig,
  apiKeyEnv: string | undefined,
  env: NodeJS.ProcessEnv,
): { value: string | undefined; from: string } {
  if (apiKeyEnv) {
    return { value: env[apiKeyEnv], from: `$${apiKeyEnv}` };
  }
  if (log.apiKey) {
    return { value: log.apiKey, from: "agency.json log.apiKey" };
  }
  return { value: env[DEFAULT_API_KEY_ENV], from: `$${DEFAULT_API_KEY_ENV}` };
}
