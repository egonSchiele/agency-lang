import { _gitRun } from "../git.js";
import { isAbortError } from "../../runtime/errors.js";

export type RepoCoord = { owner: string; repo: string };

// GitHub's own rules: a login is alphanumeric with single inner hyphens; a
// repository name adds dots and underscores.
const OWNER_PATTERN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** Throws unless both names are ones GitHub could have issued. The pair
 *  feeds URL paths, the search query, and the @always approval scope, so a
 *  name with a space or a `/` in it must never get that far. */
function checkRepoCoord(coord: RepoCoord): RepoCoord {
  if (!OWNER_PATTERN.test(coord.owner)) {
    throw new Error(`"${coord.owner}" is not a valid GitHub owner name.`);
  }
  if (!REPO_PATTERN.test(coord.repo)) {
    throw new Error(`"${coord.repo}" is not a valid GitHub repository name.`);
  }
  return coord;
}

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

// `scheme://user:token@` — the userinfo of a URL the URL parser refused
// (a bad port, say). Greedy through the LAST `@` before the path, so an
// `@` inside the userinfo cannot leave the rest of it in place. The SSH
// form has no scheme, so it does not match.
const USERINFO_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i;

/** Strip embedded credentials (https://user:token@host/...) from a URL
 *  before it can reach an error message. A value the URL parser refuses
 *  still has its userinfo cut out textually, so a malformed remote can
 *  never leak a token either. */
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
    return url.replace(USERINFO_PATTERN, "$1");
  }
}

/**
 * The owner/repo pair a GitHub call operates on. An explicit pair wins with
 * no subprocess; empty defaults resolve from the `origin` remote of `cwd`.
 * The git runner refuses an empty or relative cwd rather than falling back
 * to process.cwd(), so a lost directory can never silently target another
 * repository. Callers resolve BEFORE raising their interrupt, so the payload
 * and the @always(owner, repo) scope name the real repository.
 */
export async function _ghResolveRepo(owner: string, repo: string, cwd: string): Promise<RepoCoord> {
  if (owner !== "" && repo !== "") {
    return checkRepoCoord({ owner, repo });
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
    // A cancellation (Ctrl-C, guard trip) must stay abort-shaped so
    // __tryCall propagates it instead of reporting a repository failure.
    if (isAbortError(e)) {
      throw e;
    }
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
  return checkRepoCoord(parsed);
}
