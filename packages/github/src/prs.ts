import type { RestEndpointMethodTypes } from "@octokit/rest";
import { success, failure } from "agency-lang/runtime";
import { withCtx, type BaseCtxArgs } from "./internal/withCtx.js";
import type { Result } from "./internal/result.js";
import type { PullRequest } from "./types.js";

type PullsListItem = RestEndpointMethodTypes["pulls"]["list"]["response"]["data"][number];

function toPullRequest(p: PullsListItem): PullRequest {
  return {
    number: p.number,
    title: p.title,
    body: p.body ?? "",
    author: p.user?.login ?? "",
    head: p.head.ref,
    base: p.base.ref,
    labels: p.labels.map((l) => typeof l === "string" ? l : (l.name ?? "")),
    url: p.html_url,
    state: p.state,
    createdAt: p.created_at,
  };
}

export async function openPullRequest(
  args: { title: string; body: string; head: string; base?: string; draft?: boolean; labels?: string[] } & BaseCtxArgs,
): Promise<Result<{ number: number; url: string }>> {
  return withCtx(args, async (octokit, owner, repo) => {
    try {
      // Treat empty-string `base` as unset so the Agency wrapper's
      // `base: string = ""` default falls through to the repo default branch.
      const baseBranch = (args.base && args.base !== "")
        ? args.base
        : (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
      const created = await octokit.rest.pulls.create({
        owner, repo, title: args.title, body: args.body, head: args.head, base: baseBranch, draft: args.draft,
      });
      if (args.labels && args.labels.length > 0) {
        await octokit.rest.issues.addLabels({ owner, repo, issue_number: created.data.number, labels: args.labels });
      }
      return success({ number: created.data.number, url: created.data.html_url }) as Result<{ number: number; url: string }>;
    } catch (e) {
      return failure(`openPullRequest failed: ${(e as Error).message}`) as Result<{ number: number; url: string }>;
    }
  });
}

export async function listPullRequests(
  args: { state?: "open" | "closed" | "all"; base?: string; head?: string } & BaseCtxArgs,
): Promise<Result<PullRequest[]>> {
  return withCtx(args, async (octokit, owner, repo) => {
    try {
      // Normalize empty-string filters to undefined so they aren't sent to the API
      // (the Agency wrapper passes "" as default for omitted filters).
      const list = await octokit.rest.pulls.list({
        owner,
        repo,
        state: args.state ?? "open",
        base: args.base || undefined,
        head: args.head || undefined,
      });
      return success(list.data.map(toPullRequest)) as Result<PullRequest[]>;
    } catch (e) {
      return failure(`listPullRequests failed: ${(e as Error).message}`) as Result<PullRequest[]>;
    }
  });
}

export async function commentOnPullRequest(args: { number: number; body: string } & BaseCtxArgs): Promise<Result<void>> {
  return withCtx(args, async (octokit, owner, repo) => {
    try {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: args.number, body: args.body });
      return success(undefined) as Result<void>;
    } catch (e) {
      return failure(`commentOnPullRequest failed: ${(e as Error).message}`) as Result<void>;
    }
  });
}

export async function addLabel(args: { number: number; labels: string[] } & BaseCtxArgs): Promise<Result<void>> {
  return withCtx(args, async (octokit, owner, repo) => {
    try {
      await octokit.rest.issues.addLabels({ owner, repo, issue_number: args.number, labels: args.labels });
      return success(undefined) as Result<void>;
    } catch (e) {
      return failure(`addLabel failed: ${(e as Error).message}`) as Result<void>;
    }
  });
}

export async function requestReview(
  args: { number: number; reviewers?: string[]; teamReviewers?: string[] } & BaseCtxArgs,
): Promise<Result<void>> {
  return withCtx(args, async (octokit, owner, repo) => {
    try {
      await octokit.rest.pulls.requestReviewers({
        owner, repo, pull_number: args.number, reviewers: args.reviewers, team_reviewers: args.teamReviewers,
      });
      return success(undefined) as Result<void>;
    } catch (e) {
      return failure(`requestReview failed: ${(e as Error).message}`) as Result<void>;
    }
  });
}
