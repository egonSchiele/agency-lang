import { success, failure, isFailure } from "agency-lang/runtime";
import { runGit, assertValidRefName } from "./internal/git.js";
import type { Result } from "./internal/result.js";

const DEFAULT_AUTHOR = { name: "Agency Lang Agent", email: "agency-bot@agency-lang.com" };

function trailer(): string {
  const version = process.env.AGENCY_RUN_ACTION_VERSION;
  return version
    ? `Generated-by-Agency-Action: egonSchiele/run-agency-action@${version}`
    : `Generated-by-Agency-Action: local`;
}

export async function commitFiles(args: {
  message: string;
  files?: string[];
  author?: { name: string; email: string };
  push?: boolean;
  branch?: string;
}): Promise<Result<{ sha: string }>> {
  if (args.branch !== undefined) {
    try {
      assertValidRefName(args.branch);
    } catch (e) {
      return failure((e as Error).message) as Result<{ sha: string }>;
    }
  }

  const shouldPush = args.push ?? true;
  const author = args.author ?? DEFAULT_AUTHOR;

  if (args.branch) {
    const checkout = await runGit(["checkout", "-B", args.branch]);
    if (isFailure(checkout)) return checkout as Result<{ sha: string }>;
  }

  const add = args.files && args.files.length > 0
    ? await runGit(["add", "--", ...args.files])
    : await runGit(["add", "-u"]);
  if (isFailure(add)) return add as Result<{ sha: string }>;

  const commit = await runGit([
    "-c", `user.name=${author.name}`,
    "-c", `user.email=${author.email}`,
    "commit", "-m", args.message, "--trailer", trailer(),
  ]);
  if (isFailure(commit)) return commit as Result<{ sha: string }>;

  if (shouldPush) {
    const branchResult = args.branch
      ? { ok: true as const, name: args.branch }
      : await currentBranch();
    if (!branchResult.ok) return branchResult.failure as Result<{ sha: string }>;
    const push = await runGit(["push", "--set-upstream", "origin", branchResult.name]);
    if (isFailure(push)) return push as Result<{ sha: string }>;
  }

  const head = await runGit(["rev-parse", "HEAD"]);
  if (isFailure(head)) return head as Result<{ sha: string }>;
  return success({ sha: head.value.stdout.trim() }) as Result<{ sha: string }>;
}

type BranchLookup = { ok: true; name: string } | { ok: false; failure: Result<never> };

async function currentBranch(): Promise<BranchLookup> {
  const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (isFailure(result)) return { ok: false, failure: result as Result<never> };
  return { ok: true, name: result.value.stdout.trim() };
}
