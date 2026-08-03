// Command-error presentation and API-key lookup, shared by the remote command
// recipes. Owns exit/error output; never renders successful values.

import { color } from "@/utils/termcolors.js";
import type { AgencyConfig } from "@/config.js";

/** What every remote command needs: the resolved config and the exact path it
 *  came from (so a binding writes back to that file, not a re-derived one). */
export type RemoteCommandContext = {
  config: AgencyConfig;
  configPath: string;
};

const DEFAULT_API_KEY_ENV = "STATELOG_API_KEY";

/** Print an error and exit non-zero. Typed `never` so callers can use it in an
 *  expression position (`const x = maybe() ?? fail(...)`). */
export function fail(message: string): never {
  console.error(color.red(message));
  process.exit(1);
}

/** The API key from its environment variable, or exit with a clear message.
 *  The key is only ever read from the environment, never a flag. */
export function apiKeyOrExit(options: { apiKeyEnv?: string }): string {
  const name = options.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const key = process.env[name];
  if (!key) {
    fail(`Missing API key — set $${name}.`);
  }
  return key;
}
