import { execFile } from "child_process";
import { promisify } from "util";
import { success, failure } from "agency-lang/runtime";
import type { Result } from "./result.js";

const execFileAsync = promisify(execFile);

export type RepoCoord = { owner: string; repo: string };

function stripGitSuffix(repo: string): string {
  return repo.replace(/\.git$/, "");
}

export function parseRemoteUrl(url: string): RepoCoord | undefined {
  // Allow dots in repo names (e.g. `foo.bar`); strip an optional `.git` suffix
  // and an optional trailing slash.
  const httpsMatch = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/.exec(url);
  if (httpsMatch) return { owner: httpsMatch[1], repo: stripGitSuffix(httpsMatch[2]) };
  const sshMatch = /^git@github\.com:([^/]+)\/([^/]+?)$/.exec(url);
  if (sshMatch) return { owner: sshMatch[1], repo: stripGitSuffix(sshMatch[2]) };
  return undefined;
}

// Strip any embedded credentials (e.g. `https://user:token@github.com/...`)
// from a URL before logging it, to avoid leaking tokens through error messages.
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
    return url;
  } catch {
    // Not a parseable URL (e.g. SSH form like `git@github.com:o/r.git`) — no
    // credentials to leak in that shape, return as-is.
    return url;
  }
}

export async function resolveRepo(override?: { owner?: string; repo?: string }): Promise<Result<RepoCoord>> {
  if (override?.owner && override?.repo) {
    return success({ owner: override.owner, repo: override.repo }) as Result<RepoCoord>;
  }
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"]);
    const url = stdout.trim();
    const parsed = parseRemoteUrl(url);
    if (!parsed) return failure(`Could not parse GitHub owner/repo from remote URL: ${redactUrl(url)}`) as Result<RepoCoord>;
    return success(parsed) as Result<RepoCoord>;
  } catch (e) {
    return failure(`Could not read git remote 'origin': ${(e as Error).message}`) as Result<RepoCoord>;
  }
}
