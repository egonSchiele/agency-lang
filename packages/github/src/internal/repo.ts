import { execFile } from "child_process";
import { promisify } from "util";
import { success, failure } from "agency-lang/runtime";
import type { Result } from "./result.js";

const execFileAsync = promisify(execFile);

export type RepoCoord = { owner: string; repo: string };

export function parseRemoteUrl(url: string): RepoCoord | undefined {
  const httpsMatch = /^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?\/?$/.exec(url);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  const sshMatch = /^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  return undefined;
}

export async function resolveRepo(override?: { owner?: string; repo?: string }): Promise<Result<RepoCoord>> {
  if (override?.owner && override?.repo) {
    return success({ owner: override.owner, repo: override.repo }) as Result<RepoCoord>;
  }
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"]);
    const url = stdout.trim();
    const parsed = parseRemoteUrl(url);
    if (!parsed) return failure(`Could not parse GitHub owner/repo from remote URL: ${url}`) as Result<RepoCoord>;
    return success(parsed) as Result<RepoCoord>;
  } catch (e) {
    console.error("resolveRepo: could not read git remote 'origin':", e);
    return failure(`Could not read git remote 'origin': ${(e as Error).message}`) as Result<RepoCoord>;
  }
}
