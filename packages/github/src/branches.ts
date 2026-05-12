import { success, failure } from "agency-lang/runtime";
import { withCtx, type BaseCtxArgs } from "./internal/withCtx.js";
import { assertValidRefName } from "./internal/git.js";
import type { Result } from "./internal/result.js";

export async function createBranch(
  args: { name: string; from?: string } & BaseCtxArgs,
): Promise<Result<void>> {
  try {
    assertValidRefName(args.name);
    if (args.from) assertValidRefName(args.from);
  } catch (e) {
    return failure((e as Error).message) as Result<void>;
  }

  return withCtx(args, async (octokit, owner, repo) => {
    try {
      // Treat empty-string `from` as unset so the Agency wrapper's
      // `from: string = ""` default falls through to the repo default branch.
      const fromBranch = (args.from && args.from !== "") ? args.from : (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
      const fromRef = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${fromBranch}` });
      await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${args.name}`, sha: fromRef.data.object.sha });
      return success(undefined) as Result<void>;
    } catch (e) {
      return failure(`createBranch failed: ${(e as Error).message}`) as Result<void>;
    }
  });
}

export async function deleteBranch(args: { name: string } & BaseCtxArgs): Promise<Result<void>> {
  try {
    assertValidRefName(args.name);
  } catch (e) {
    return failure((e as Error).message) as Result<void>;
  }
  return withCtx(args, async (octokit, owner, repo) => {
    try {
      await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${args.name}` });
      return success(undefined) as Result<void>;
    } catch (e) {
      return failure(`deleteBranch failed: ${(e as Error).message}`) as Result<void>;
    }
  });
}

export async function branchExists(args: { name: string } & BaseCtxArgs): Promise<Result<boolean>> {
  try {
    assertValidRefName(args.name);
  } catch (e) {
    return failure((e as Error).message) as Result<boolean>;
  }
  return withCtx(args, async (octokit, owner, repo) => {
    try {
      await octokit.rest.git.getRef({ owner, repo, ref: `heads/${args.name}` });
      return success(true) as Result<boolean>;
    } catch (e) {
      // 404 means the branch doesn't exist — that's a successful "false" result.
      if ((e as { status?: number }).status === 404) return success(false) as Result<boolean>;
      return failure(`branchExists failed: ${(e as Error).message}`) as Result<boolean>;
    }
  });
}
