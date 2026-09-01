import { _gitRun } from "../git.js";

export type RepoCoord = { owner: string; repo: string };

function stripGitSuffix(repo: string): string {
  return repo.replace(/\.git$/, "");
}

/** Owner/repo from a git remote URL, for both the HTTPS and SSH forms.
 *  Allows dots in repo names; strips an optional `.git` suffix and an
 *  optional trailing slash. */
export function parseRemoteUrl(url: string): RepoCoord | undefined {
  const httpsMatch = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/.exec(url);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: stripGitSuffix(httpsMatch[2]) };
  }
  const sshMatch = /^git@github\.com:([^/]+)\/([^/]+?)$/.exec(url);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: stripGitSuffix(sshMatch[2]) };
  }
  return undefined;
}

/** Strip embedded credentials (https://user:token@host/...) from a URL
 *  before it can reach an error message. An unparseable value (e.g. the
 *  SSH form) carries no embedded credential and passes through. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * The owner/repo pair a GitHub call operates on. An explicit pair wins with
 * no subprocess; empty defaults resolve from the `origin` remote of `cwd`
 * through the hardened git runner, which refuses an empty or relative cwd
 * rather than falling back to process.cwd() — a lost directory must never
 * silently target a different repository, because this pair feeds interrupt
 * payloads and the @always(owner, repo) approval scope. Callers must resolve
 * BEFORE raising their interrupt, so the payload shows the real repository.
 */
export async function _ghResolveRepo(owner: string, repo: string, cwd: string): Promise<RepoCoord> {
  if (owner !== "" && repo !== "") {
    return { owner, repo };
  }
  if (owner !== "" || repo !== "") {
    throw new Error(
      "Pass both owner and repo, or neither (empty defaults resolve from the origin remote).",
    );
  }
  let url: string;
  try {
    url = (await _gitRun(cwd, ["remote", "get-url", "origin"])).trim();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not read the git remote named origin (${detail}). Pass owner and repo explicitly.`,
    );
  }
  const parsed = parseRemoteUrl(url);
  if (!parsed) {
    throw new Error(
      `Could not parse a GitHub owner/repo from remote URL: ${redactUrl(url)}. Pass owner and repo explicitly.`,
    );
  }
  return parsed;
}
