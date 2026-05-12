import { success, failure } from "agency-lang/runtime";
import { withCtx, type BaseCtxArgs } from "./internal/withCtx.js";
import { formatError } from "./internal/errors.js";
import type { Result } from "./internal/result.js";

export async function defaultBranch(args: BaseCtxArgs): Promise<Result<string>> {
  return withCtx(args, async (octokit, owner, repo) => {
    try {
      const meta = await octokit.rest.repos.get({ owner, repo });
      return success(meta.data.default_branch) as Result<string>;
    } catch (e) {
      return failure(`defaultBranch failed: ${formatError(e)}`) as Result<string>;
    }
  });
}
