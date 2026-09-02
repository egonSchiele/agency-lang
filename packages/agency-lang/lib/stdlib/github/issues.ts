import { z } from "zod";
import { _githubRequest, type GithubEndpoint } from "./request.js";
import { pagingQuery } from "./args.js";
import { repoPath, RawUser, CommentInfoSchema, type CommentInfo } from "./prs.js";

// Same schema policy as prs.ts: see the comment there.

// GitHub sends labels as objects or bare strings depending on the API path.
const RawLabel = z.union([z.string(), z.object({ name: z.string().optional() })]);

function labelName(label: z.infer<typeof RawLabel>): string {
  return typeof label === "string" ? label : (label.name ?? "");
}

// GitHub models a pull request as an issue, so the issues endpoints return
// and accept pull request numbers. ghIssueGet refuses one, ghIssueList drops
// them, and ghIssueSearch keeps them (it promises both). The issue writes
// work on pull requests too, on purpose.
const RawIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  user: RawUser,
  labels: z.array(RawLabel),
  assignees: z.array(z.object({ login: z.string() })).nullable(),
  body: z.string().nullable(),
  html_url: z.string(),
  pull_request: z.unknown().optional(),
});
type RawIssue = z.infer<typeof RawIssueSchema>;

function toIssueSummary(raw: RawIssue) {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    author: raw.user?.login ?? "",
    labels: raw.labels.map(labelName),
    assignees: (raw.assignees ?? []).map((assignee) => assignee.login),
    body: raw.body ?? "",
    url: raw.html_url,
  };
}

function isPullRequest(raw: RawIssue): boolean {
  return raw.pull_request !== undefined && raw.pull_request !== null;
}

const IssueSummarySchema = RawIssueSchema.transform(toIssueSummary);
const IssueGetSchema = RawIssueSchema.transform((raw, ctx) => {
  if (isPullRequest(raw)) {
    ctx.addIssue({
      code: "custom",
      message: `#${raw.number} is a pull request, not an issue. Use ghPrGet to read it.`,
    });
    return z.NEVER;
  }
  return toIssueSummary(raw);
});
const IssueListSchema = z
  .array(RawIssueSchema)
  .transform((items) => items.filter((item) => !isPullRequest(item)).map(toIssueSummary));
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

const issueGet: GithubEndpoint<IssueParams, IssueSummary> = {
  name: "GET /repos/{owner}/{repo}/issues/{number}",
  method: "GET",
  path: (params) => `${repoPath(params.owner, params.repo)}/issues/${params.number}`,
  response: IssueGetSchema,
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
  response: IssueListSchema,
};

const issueComments: GithubEndpoint<PagedIssueParams, CommentInfo[]> = {
  name: "GET /repos/{owner}/{repo}/issues/{number}/comments",
  method: "GET",
  path: (params) => `${repoPath(params.owner, params.repo)}/issues/${params.number}/comments`,
  query: (params) => pagingQuery(params.perPage, params.page),
  response: z.array(CommentInfoSchema),
};

// The search endpoint is account-global; _ghScopedSearchQuery confines every
// query to one repository.
const issueSearch: GithubEndpoint<
  { scopedQuery: string; perPage: number; page: number },
  IssueSummary[]
> = {
  name: "GET /search/issues",
  method: "GET",
  path: () => "/search/issues",
  query: (params) => ({
    q: params.scopedQuery,
    ...pagingQuery(params.perPage, params.page),
  }),
  response: z.object({ items: z.array(IssueSummarySchema) }).transform((raw) => raw.items),
};

// GitHub search unions repository qualifiers, so a user-supplied `repo:`
// (or `org:`/`user:`, which widen the same way) would escape the repository
// the interrupt was approved for. The word boundary catches a qualifier
// after any punctuation, `(repo:` and `-repo:` included.
const SCOPE_QUALIFIER = /\b(repo|org|user):/i;

/** The search string ghIssueSearch sends: the user's query confined to one
 *  repository. Throws if the query carries its own repository qualifier. */
export function _ghScopedSearchQuery(owner: string, repo: string, query: string): string {
  if (SCOPE_QUALIFIER.test(query)) {
    throw new Error(
      "The search query must not contain a repo:, org:, or user: qualifier. " +
        "ghIssueSearch always searches one repository; pass owner and repo to choose it.",
    );
  }
  return `repo:${owner}/${repo} ${query}`;
}

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
  scopedQuery: string,
  perPage: number,
  page: number,
): Promise<IssueSummary[]> {
  return _githubRequest(issueSearch, { scopedQuery, perPage, page });
}

// --- Write endpoints ---------------------------------------------------------

const issueCreate: GithubEndpoint<
  RepoParams & { title: string; body: string; labels: string[]; assignees: string[] },
  IssueSummary
> = {
  name: "POST /repos/{owner}/{repo}/issues",
  method: "POST",
  path: (params) => `${repoPath(params.owner, params.repo)}/issues`,
  body: (params) => {
    const payload: Record<string, unknown> = { title: params.title, body: params.body };
    if (params.labels.length > 0) {
      payload.labels = params.labels;
    }
    if (params.assignees.length > 0) {
      payload.assignees = params.assignees;
    }
    return payload;
  },
  response: IssueSummarySchema,
};

const issueCommentCreate: GithubEndpoint<IssueParams & { body: string }, CommentInfo> = {
  name: "POST /repos/{owner}/{repo}/issues/{number}/comments",
  method: "POST",
  path: (params) => `${repoPath(params.owner, params.repo)}/issues/${params.number}/comments`,
  body: (params) => ({ body: params.body }),
  response: CommentInfoSchema,
};

const issueClose: GithubEndpoint<IssueParams & { reason: string }, IssueSummary> = {
  name: "PATCH /repos/{owner}/{repo}/issues/{number}",
  method: "PATCH",
  path: (params) => `${repoPath(params.owner, params.repo)}/issues/${params.number}`,
  body: (params) => ({ state: "closed", state_reason: params.reason }),
  response: IssueSummarySchema,
};

const issueLabelAdd: GithubEndpoint<IssueParams & { labels: string[] }, string[]> = {
  name: "POST /repos/{owner}/{repo}/issues/{number}/labels",
  method: "POST",
  path: (params) => `${repoPath(params.owner, params.repo)}/issues/${params.number}/labels`,
  body: (params) => ({ labels: params.labels }),
  response: z.array(RawLabel).transform((labels) => labels.map(labelName)),
};

// --- Write bindings ----------------------------------------------------------

export async function _ghIssueCreate(
  title: string,
  body: string,
  labels: string[],
  assignees: string[],
  owner: string,
  repo: string,
): Promise<IssueSummary> {
  return _githubRequest(issueCreate, { owner, repo, title, body, labels, assignees });
}

export async function _ghIssueComment(
  number: number,
  body: string,
  owner: string,
  repo: string,
): Promise<CommentInfo> {
  return _githubRequest(issueCommentCreate, { owner, repo, number, body });
}

export async function _ghIssueClose(
  number: number,
  reason: string,
  owner: string,
  repo: string,
): Promise<IssueSummary> {
  return _githubRequest(issueClose, { owner, repo, number, reason });
}

export async function _ghIssueLabel(
  number: number,
  labels: string[],
  owner: string,
  repo: string,
): Promise<string[]> {
  return _githubRequest(issueLabelAdd, { owner, repo, number, labels });
}
