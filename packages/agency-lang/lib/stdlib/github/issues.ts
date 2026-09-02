import { z } from "zod";
import { _githubRequest, pagingQuery, type GithubEndpoint } from "./request.js";
import { repoPath, RawUser, CommentInfoSchema, type CommentInfo } from "./prs.js";

// Same schema policy as prs.ts: see the comment there.

// GitHub sends labels as objects or bare strings depending on the API path.
const RawLabel = z.union([z.string(), z.object({ name: z.string().optional() })]);

function labelName(label: z.infer<typeof RawLabel>): string {
  return typeof label === "string" ? label : (label.name ?? "");
}

const IssueSummarySchema = z
  .object({
    number: z.number(),
    title: z.string(),
    state: z.string(),
    user: RawUser,
    labels: z.array(RawLabel),
    assignees: z.array(z.object({ login: z.string() })).nullable(),
    body: z.string().nullable(),
    html_url: z.string(),
  })
  .transform((raw) => ({
    number: raw.number,
    title: raw.title,
    state: raw.state,
    author: raw.user?.login ?? "",
    labels: raw.labels.map(labelName),
    assignees: (raw.assignees ?? []).map((assignee) => assignee.login),
    body: raw.body ?? "",
    url: raw.html_url,
  }));
export type IssueSummary = z.infer<typeof IssueSummarySchema>;

// --- Endpoint declarations ---------------------------------------------------
// The complete list of issue endpoints this module can hit.

type RepoParams = { owner: string; repo: string };
type IssueParams = RepoParams & { number: number };
type PagedIssueParams = IssueParams & { perPage: number; page: number };
type IssueListParams = RepoParams & {
  state: string;
  labels: string[];
  perPage: number;
  page: number;
};
type IssueSearchParams = RepoParams & { query: string; perPage: number; page: number };

const issueGet: GithubEndpoint<IssueParams, IssueSummary> = {
  name: "GET /repos/{owner}/{repo}/issues/{number}",
  method: "GET",
  path: (params) => `${repoPath(params.owner, params.repo)}/issues/${params.number}`,
  response: IssueSummarySchema,
};

const issueList: GithubEndpoint<IssueListParams, IssueSummary[]> = {
  name: "GET /repos/{owner}/{repo}/issues",
  method: "GET",
  path: (params) => `${repoPath(params.owner, params.repo)}/issues`,
  query: (params) => {
    const query: Record<string, string> = {
      state: params.state,
      ...pagingQuery(params.perPage, params.page),
    };
    if (params.labels.length > 0) {
      query.labels = params.labels.join(",");
    }
    return query;
  },
  response: z.array(IssueSummarySchema),
};

const issueComments: GithubEndpoint<PagedIssueParams, CommentInfo[]> = {
  name: "GET /repos/{owner}/{repo}/issues/{number}/comments",
  method: "GET",
  path: (params) => `${repoPath(params.owner, params.repo)}/issues/${params.number}/comments`,
  query: (params) => pagingQuery(params.perPage, params.page),
  response: z.array(CommentInfoSchema),
};

// The search endpoint is account-global. Forcing the repo: qualifier onto
// every query is what makes @always(owner, repo) meaningful for it.
const issueSearch: GithubEndpoint<IssueSearchParams, IssueSummary[]> = {
  name: "GET /search/issues",
  method: "GET",
  path: () => "/search/issues",
  query: (params) => ({
    q: `repo:${params.owner}/${params.repo} ${params.query}`,
    ...pagingQuery(params.perPage, params.page),
  }),
  response: z.object({ items: z.array(IssueSummarySchema) }).transform((raw) => raw.items),
};

// --- Bindings stdlib/github.agency imports -----------------------------------

export async function _ghIssueGet(
  number: number,
  owner: string,
  repo: string,
): Promise<IssueSummary> {
  return _githubRequest(issueGet, { owner, repo, number });
}

export async function _ghIssueList(
  state: string,
  labels: string[],
  perPage: number,
  page: number,
  owner: string,
  repo: string,
): Promise<IssueSummary[]> {
  return _githubRequest(issueList, { owner, repo, state, labels, perPage, page });
}

export async function _ghIssueComments(
  number: number,
  perPage: number,
  page: number,
  owner: string,
  repo: string,
): Promise<CommentInfo[]> {
  return _githubRequest(issueComments, { owner, repo, number, perPage, page });
}

export async function _ghIssueSearch(
  query: string,
  perPage: number,
  page: number,
  owner: string,
  repo: string,
): Promise<IssueSummary[]> {
  return _githubRequest(issueSearch, { owner, repo, query, perPage, page });
}
