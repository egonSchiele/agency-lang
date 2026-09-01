import { execFile } from "child_process";
import { promisify } from "util";
import { _getSecret } from "../keyring.js";

const execFileAsync = promisify(execFile);

export type CredentialSources = {
  env: Record<string, string | undefined>;
  ghAuthToken: () => Promise<string | null>;
  keyringGet: (key: string, service: string) => Promise<string | null>;
};

const MISS_MESSAGE = `No GitHub credential. Do one of:
  - run \`gh auth login\`
  - set GITHUB_TOKEN in the environment
  - store a token with setSecret("github-token", "<token>")`;

/** Precedence: env, then gh, then keyring. Pure over its sources so tests
 *  can prove the order with a different value per source. Throws on a miss. */
export async function resolveTokenFromSources(sources: CredentialSources): Promise<string> {
  const fromEnv = sources.env.GITHUB_TOKEN || sources.env.GH_TOKEN;
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const fromGh = await sources.ghAuthToken();
    if (fromGh) {
      return fromGh;
    }
  } catch {
    // Expected miss, not a swallowed error: gh absent or not logged in is a
    // normal state, and the chain falls through to the keyring. A total miss
    // still surfaces every remedy via MISS_MESSAGE.
  }
  const fromKeyring = await sources.keyringGet("github-token", "agency-lang");
  if (fromKeyring) {
    return fromKeyring;
  }
  throw new Error(MISS_MESSAGE);
}

// gh can hang on a broken keyring backend or a credential helper waiting for
// input, and this runs inside _githubRequest where a hang stalls the whole
// agent. The command prints one line; seconds are plenty.
const GH_AUTH_TOKEN_TIMEOUT_MS = 5000;

async function ghAuthToken(): Promise<string | null> {
  // Fixed literal argv, no shell, nothing model-supplied.
  const { stdout } = await execFileAsync("gh", ["auth", "token"], {
    timeout: GH_AUTH_TOKEN_TIMEOUT_MS,
  });
  const token = stdout.trim();
  return token === "" ? null : token;
}

// Process-lifetime cache so we do not spawn `gh` per request. Derived from
// the environment, not per-run state — the same footing as the effect-set
// cache in lib/runtime/effectSets.ts and the always-scope registry — so the
// coding-standards rule against per-run module state does not apply. Never
// checkpointed. Only a SUCCESS is cached: a miss re-resolves next call, so a
// setSecret() in the same session takes effect without a restart.
let cachedToken: string | null = null;

export function _resetGithubCredentialCacheForTests(): void {
  cachedToken = null;
}

/** The cache layer over the precedence logic, injectable so tests can drive
 *  the cache with fake sources and never touch a real credential. */
export async function _resolveAndCache(sources: CredentialSources): Promise<string> {
  if (cachedToken !== null) {
    return cachedToken;
  }
  const token = await resolveTokenFromSources(sources);
  cachedToken = token;
  return token;
}

/** The token for GitHub requests. Called ONLY by _githubRequest, after the
 *  operation's interrupt is approved — never from Agency. The invariant:
 *  nothing reads the token without an approved interrupt in front of it. */
export async function resolveGithubToken(): Promise<string> {
  return _resolveAndCache({
    env: process.env,
    ghAuthToken,
    keyringGet: _getSecret,
  });
}
