import type { Octokit } from "@octokit/rest";
import { resolveRepo } from "./repo.js";
import { getOctokit } from "./octokit.js";
import type { Result } from "./result.js";

export type BaseCtxArgs = { owner?: string; repo?: string; token?: string };

export async function withCtx<T>(
  args: BaseCtxArgs,
  fn: (octokit: Octokit, owner: string, repo: string) => Promise<Result<T>>,
): Promise<Result<T>> {
  const repoResult = await resolveRepo({ owner: args.owner, repo: args.repo });
  if (repoResult.success === false) return repoResult;
  const octokitResult = getOctokit(args.token);
  if (octokitResult.success === false) return octokitResult;
  return fn(octokitResult.value, repoResult.value.owner, repoResult.value.repo);
}
