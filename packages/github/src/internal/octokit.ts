import { Octokit } from "@octokit/rest";
import { success, failure } from "agency-lang/runtime";
import type { Result } from "./result.js";

export function resolveToken(explicit?: string): string | undefined {
  if (explicit) return explicit;
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
}

export function getOctokit(explicit?: string): Result<Octokit> {
  const token = resolveToken(explicit);
  if (!token) return failure("No GitHub token. Set GITHUB_TOKEN or pass token explicitly.") as Result<Octokit>;
  return success(new Octokit({ auth: token })) as Result<Octokit>;
}
