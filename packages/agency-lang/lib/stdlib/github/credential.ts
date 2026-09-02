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

// Visible ASCII only. A token with a newline or a non-ASCII byte would make
// undici reject the Authorization header with an error that quotes the
// whole header value, and that error would carry the token into a failure
// message. Refuse such a token here, without echoing it.
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]+$/;

function checkTokenShape(token: string, source: string): string {
  if (!HEADER_SAFE_TOKEN.test(token)) {
    throw new Error(
      `The GitHub token from ${source} contains whitespace or a non-ASCII character, ` +
        "which cannot be sent in an HTTP header. Replace it with the token exactly as GitHub issued it.",
    );
  }
  return token;
}

/** Precedence: env, then gh, then keyring. Pure over its sources so tests
 *  can prove the order with a different value per source. Throws on a miss. */
export async function resolveTokenFromSources(sources: CredentialSources): Promise<string> {
  const fromEnv = sources.env.GITHUB_TOKEN || sources.env.GH_TOKEN;
  if (fromEnv) {
    return checkTokenShape(fromEnv, sources.env.GITHUB_TOKEN ? "GITHUB_TOKEN" : "GH_TOKEN");
  }
  const fromGh = await readSource(sources.ghAuthToken);
  if (fromGh) {
    return checkTokenShape(fromGh, "gh auth token");
  }
  const fromKeyring = await readSource(() => sources.keyringGet("github-token", "agency-lang"));
  if (fromKeyring) {
    return checkTokenShape(fromKeyring, 'the keyring entry "github-token"');
  }
  throw new Error(MISS_MESSAGE);
}

/** A source that throws is a miss, not an error: gh absent or not logged
 *  in is a normal state, and _getSecret throws on platforms with no keyring
 *  backend (Windows). Either way the chain moves on, and a total miss still
 *  surfaces every remedy via MISS_MESSAGE rather than the source's own,
 *  unrelated advice. */
async function readSource(read: () => Promise<string | null>): Promise<string | null> {
  try {
    return await read();
  } catch {
    return null;
  }
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

/** Forget the cached token. Called on a 401 so the remedies in that failure
 *  message (a new gh login, a new GITHUB_TOKEN, a new keyring entry) take
 *  effect on the next call instead of after a restart. */
export function invalidateGithubCredentialCache(): void {
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
