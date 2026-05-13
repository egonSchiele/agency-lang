// Safely format errors thrown by Octokit (and other unknown errors) for
// inclusion in user-facing failure Result strings.
//
// Defense-in-depth: we don't forward Octokit's `error.message` verbatim.
// Octokit's `RequestError` carries the original `request` object (which
// includes the `Authorization` header) on the error instance — `.message`
// itself doesn't currently include it, but a future upstream change to
// stringify request metadata into `.message` would silently leak tokens
// downstream because we forward error messages straight into Result
// failures.
//
// For Octokit-shaped errors (anything with a `status`), we use the
// structured `response.data.message` from the GitHub API instead. For
// other errors we fall back to `.message` after running a conservative
// scrub for anything that looks like a credential.

type OctokitLike = {
  status?: number;
  response?: { data?: { message?: unknown } };
  message?: unknown;
  name?: unknown;
};

const CREDENTIAL_LIKE = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[^\s]+|token\s+[^\s]+)/gi;

function scrub(s: string): string {
  return s.replace(CREDENTIAL_LIKE, "[REDACTED]");
}

function safeApiMessage(e: OctokitLike): string | undefined {
  const apiMsg = e.response?.data?.message;
  if (typeof apiMsg === "string" && apiMsg.length > 0) return apiMsg;
  return undefined;
}

export function formatError(e: unknown): string {
  if (typeof e !== "object" || e === null) return scrub(String(e));
  const oe = e as OctokitLike;
  // Octokit-like: prefer the structured API message + status. This avoids
  // any future-leak risk from `.message` including request metadata.
  if (typeof oe.status === "number") {
    const apiMsg = safeApiMessage(oe);
    return apiMsg ? `HTTP ${oe.status}: ${scrub(apiMsg)}` : `HTTP ${oe.status}`;
  }
  if (typeof oe.message === "string") return scrub(oe.message);
  return "unknown error";
}
