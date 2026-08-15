// Resolving *where* an agent deploys to: the statelog host, project, and API
// key. Host and project come from the same `log` config observability uses
// (agency.json), with flag overrides. The API key is read only from an
// environment variable — never a flag or agency.json — so it can't be committed
// or leak into process listings.

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
};

export type ResolveTargetResult =
  { ok: true; target: DeployTarget; provenance: TargetProvenance } | { ok: false; error: string };

const DEFAULT_API_KEY_ENV = "STATELOG_API_KEY";

/**
 * Resolve the deploy target. Host and project come from a flag or agency.json
 * `log.*`; the API key is read from an environment variable (the `--api-key-env`
 * one, or `STATELOG_API_KEY` by default). Fails with everything that's missing
 * or malformed rather than one problem at a time.
 */
export function resolveDeployTarget(
  log: LogConfig | undefined,
  overrides: TargetOverrides,
  env: NodeJS.ProcessEnv,
): ResolveTargetResult {
  const logConfig = log ?? {};

  const host = overrides.host ?? logConfig.host;
  const hostFrom = overrides.host ? "--host" : "agency.json log.host";

  const projectId = overrides.project ?? logConfig.projectId;
  const projectFrom = overrides.project ? "--project" : "agency.json log.projectId";

  const apiKeyEnvName = overrides.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const apiKey = env[apiKeyEnvName];

  const missing: string[] = [];
  if (!host) {
    missing.push("host (set log.host in agency.json, or pass --host)");
  } else if (!isValidUrl(host)) {
    missing.push(`a valid host URL (got "${host}" — include the scheme, e.g. https://…)`);
  }
  if (!projectId) {
    missing.push("project (set log.projectId in agency.json, or pass --project)");
  }
  if (!apiKey) {
    missing.push(`API key (set $${apiKeyEnvName}, or pass --api-key-env <NAME>)`);
  }
  if (missing.length > 0) {
    return { ok: false, error: `Cannot deploy — missing ${missing.join("; ")}.` };
  }

  return {
    ok: true,
    target: { host: host!, projectId: projectId!, apiKey: apiKey! },
    provenance: { host: hostFrom, projectId: projectFrom, apiKey: `$${apiKeyEnvName}` },
  };
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
