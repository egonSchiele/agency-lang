// Command-error presentation, API-key lookup, and account-target resolution,
// shared by the remote command recipes. Owns exit/error output; never renders
// successful values.

import { color } from "@/utils/termcolors.js";
import type { AgencyConfig } from "@/config.js";
import { readBinding } from "../binding.js";
import { canonicalOrigin } from "../../statelog/serveUrl.js";
import { AccountScopeError } from "../../statelog/accountClient.js";

/** What every remote command needs: the resolved config and the exact path it
 *  came from (so a binding writes back to that file, not a re-derived one). */
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

/** Resolve where an account-management command talks to: a canonical origin (from
 *  `--host`, then `agency.json` `log.host`, then an existing binding's origin)
 *  and the resolved API key. Exits with a clear message on a missing or invalid
 *  origin, or a missing key. */
export function resolveAccountTarget(
  context: RemoteCommandContext,
  options: { host?: string; apiKeyEnv?: string },
): AccountTarget {
  const bindingOrigin = readBinding(context.configPath)?.origin;
  const selected = options.host ?? context.config.log?.host ?? bindingOrigin;
  if (!selected) {
    fail(
      "No statelog host. Set log.host in agency.json, pass --host, or link this directory first.",
    );
  }
  const origin = canonicalOrigin(selected);
  if (!origin) {
    fail(
      `Invalid statelog host "${selected}". Use an HTTP(S) origin with no path, credentials, query, or fragment.`,
    );
  }
  return { origin, ...resolveApiKey(options) };
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
