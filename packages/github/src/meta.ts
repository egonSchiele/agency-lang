import { success, failure } from "agency-lang/runtime";
import { withCtx, type BaseCtxArgs } from "./internal/withCtx.js";
import type { Result } from "./internal/result.js";

export async function defaultBranch(args: BaseCtxArgs): Promise<Result<string>> {
  return withCtx(args, async (octokit, owner, repo) => {
    try {
      const meta = await octokit.rest.repos.get({ owner, repo });
      return success(meta.data.default_branch) as Result<string>;
    } catch (e) {
      console.error("defaultBranch failed:", e);
      return failure(`defaultBranch failed: ${(e as Error).message}`) as Result<string>;
    }
  });
}
