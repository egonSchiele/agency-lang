// Redact anything credential-shaped before it can reach a failure message
// (ported from packages/github/src/internal/errors.ts).
const CREDENTIAL_LIKE =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[^\s]+|token\s+[^\s]+)/gi;

export function scrub(s: string): string {
  return s.replace(CREDENTIAL_LIKE, "[REDACTED]");
}

type GithubErrorBody = { message?: unknown; errors?: unknown };

function parseErrorBody(bodyText: string): { message: string; errors: string } {
  try {
    const parsed = JSON.parse(bodyText) as GithubErrorBody;
    const message = typeof parsed.message === "string" ? scrub(parsed.message) : "";
    const errors = Array.isArray(parsed.errors) ? scrub(JSON.stringify(parsed.errors)) : "";
    return { message, errors };
  } catch {
    // A non-JSON error body (an HTML error page from a proxy, say) is a
    // normal case, not a swallowed failure: the caller still reports the
    // HTTP status, method, and URL without these two detail fields.
    return { message: "", errors: "" };
  }
}

/** A failure message a model can act on, per status. */
export function githubFailureMessage(
  status: number,
  headers: Headers,
  bodyText: string,
  method: string,
  url: string,
): string {
  const { message, errors } = parseErrorBody(bodyText);
  const detail = message ? `: ${message}` : "";
  if (status === 401) {
    return (
      `GitHub returned 401 — the token is invalid or expired${detail}. Do one of:\n` +
      "  - run `gh auth login`\n" +
      "  - set GITHUB_TOKEN in the environment\n" +
      '  - store a token with setSecret("github-token", "<token>")'
    );
  }
  if (status === 403 && headers.get("x-ratelimit-remaining") === "0") {
    const reset = headers.get("x-ratelimit-reset") ?? "unknown";
    return `GitHub rate limit exceeded${detail}. It resets at ${reset} (unix seconds). Wait, then retry.`;
  }
  if ((status === 403 || status === 404) && method !== "GET") {
    return (
      `GitHub returned ${status} for ${method} ${url}${detail}. ` +
      "Either the resource does not exist, or the token lacks the repo scope " +
      "(GitHub returns 404 for resources the token cannot see)."
    );
  }
  if (status === 422) {
    const errorDetail = errors ? ` Details: ${errors}` : "";
    return `GitHub rejected the request as invalid (422)${detail}.${errorDetail}`;
  }
  return `GitHub returned HTTP ${status} for ${method} ${url}${detail}`;
}
