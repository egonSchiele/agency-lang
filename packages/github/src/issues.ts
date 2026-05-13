import type { RestEndpointMethodTypes } from "@octokit/rest";
import { success, failure } from "agency-lang/runtime";
import { withCtx, type BaseCtxArgs } from "./internal/withCtx.js";
import { formatError } from "./internal/errors.js";
import type { Result } from "./internal/result.js";
import type { Issue } from "./types.js";

type IssueListItem = RestEndpointMethodTypes["issues"]["listForRepo"]["response"]["data"][number];
type IssueCreated = RestEndpointMethodTypes["issues"]["create"]["response"]["data"];

function toIssue(item: IssueListItem | IssueCreated): Issue {
  return {
    number: item.number,
    title: item.title,
    body: item.body ?? "",
    author: item.user?.login ?? "",
    labels: (item.labels ?? []).map((l) => typeof l === "string" ? l : (l.name ?? "")),
    url: item.html_url,
    state: item.state,
    createdAt: item.created_at,
  };
}

export async function listIssues(
  args: { state?: "open" | "closed" | "all"; labels?: string[] } & BaseCtxArgs,
): Promise<Result<Issue[]>> {
  return withCtx(args, async (octokit, owner, repo) => {
    try {
      // Only pass the labels filter when non-empty — the Agency wrapper
      // defaults to `[]`, which would otherwise become `labels: ""`.
      const labelsFilter = args.labels && args.labels.length > 0 ? args.labels.join(",") : undefined;
      const list = await octokit.rest.issues.listForRepo({
        owner, repo, state: args.state ?? "open", labels: labelsFilter,
      });
      // The issues endpoint also returns PRs; filter them out.
      const onlyIssues = list.data.filter((item) => !("pull_request" in item) || !item.pull_request);
      return success(onlyIssues.map(toIssue)) as Result<Issue[]>;
    } catch (e) {
      return failure(`listIssues failed: ${formatError(e)}`) as Result<Issue[]>;
    }
  });
}

export async function commentOnIssue(args: { number: number; body: string } & BaseCtxArgs): Promise<Result<void>> {
  return withCtx(args, async (octokit, owner, repo) => {
    try {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: args.number, body: args.body });
      return success(undefined) as Result<void>;
    } catch (e) {
      return failure(`commentOnIssue failed: ${formatError(e)}`) as Result<void>;
    }
  });
}

export async function createIssue(
  args: { title: string; body: string; labels?: string[] } & BaseCtxArgs,
): Promise<Result<Issue>> {
  return withCtx(args, async (octokit, owner, repo) => {
    try {
      const created = await octokit.rest.issues.create({
        owner, repo, title: args.title, body: args.body, labels: args.labels,
      });
      return success(toIssue(created.data)) as Result<Issue>;
    } catch (e) {
      return failure(`createIssue failed: ${formatError(e)}`) as Result<Issue>;
    }
  });
}
