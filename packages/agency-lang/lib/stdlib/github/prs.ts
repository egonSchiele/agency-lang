import { z } from "zod";
import { _githubRequest, pagingQuery, type GithubEndpoint } from "./request.js";

export function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

// GitHub sends user: null for deleted accounts.
export const RawUser = z.object({ login: z.string() }).nullable();

// --- Response schemas --------------------------------------------------------
// Each validates the raw GitHub payload and transforms it to the public shape;
// the exported types are z.infer of the transforms, and they mirror the native
// declarations in stdlib/github.agency — keep the two in sync. Field policy:
// nullable/optional ONLY where GitHub documents it (default applied in the
// transform); everything else required, so drift fails loudly.

const PrSummarySchema = z
  .object({
    number: z.number(),
    title: z.string(),
    state: z.string(),
    user: RawUser,
    base: z.object({ ref: z.string() }),
    head: z.object({ ref: z.string(), sha: z.string() }),
    draft: z.boolean().optional(),
    body: z.string().nullable(),
    html_url: z.string(),
    additions: z.number().optional(), // absent in list responses
    deletions: z.number().optional(),
    changed_files: z.number().optional(),
  })
  .transform((raw) => ({
    number: raw.number,
    title: raw.title,
    state: raw.state,
    author: raw.user?.login ?? "",
    base: raw.base.ref,
    head: raw.head.ref,
    headSha: raw.head.sha,
    draft: raw.draft ?? false,
    body: raw.body ?? "",
    url: raw.html_url,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changed_files ?? 0,
  }));
export type PrSummary = z.infer<typeof PrSummarySchema>;

const PrFileSchema = z
  .object({
    filename: z.string(),
    status: z.string(),
    additions: z.number(),
    deletions: z.number(),
    patch: z.string().optional(), // absent for binary files
  })
  .transform((raw) => ({
    path: raw.filename,
    status: raw.status,
    additions: raw.additions,
    deletions: raw.deletions,
    patch: raw.patch ?? "",
  }));
export type PrFile = z.infer<typeof PrFileSchema>;

const ReviewSummarySchema = z
  .object({
    id: z.number(),
    user: RawUser,
    state: z.string(),
    body: z.string().nullable(),
    submitted_at: z.string().optional(), // absent on PENDING reviews
  })
  .transform((raw) => ({
    id: raw.id,
    author: raw.user?.login ?? "",
    state: raw.state,
    body: raw.body ?? "",
    submittedAt: raw.submitted_at ?? "",
  }));
export type ReviewSummary = z.infer<typeof ReviewSummarySchema>;

const ReviewCommentInfoSchema = z
  .object({
    id: z.number(),
    path: z.string(),
    line: z.number().nullable().optional(), // null/absent on outdated comments
    user: RawUser,
    body: z.string(),
    html_url: z.string(),
  })
  .transform((raw) => ({
    id: raw.id,
    path: raw.path,
    line: raw.line ?? null,
    author: raw.user?.login ?? "",
    body: raw.body,
    url: raw.html_url,
  }));
export type ReviewCommentInfo = z.infer<typeof ReviewCommentInfoSchema>;

const CheckRunSchema = z
  .object({
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(), // null while in progress
    html_url: z.string().nullable(),
  })
  .transform((raw) => ({
    name: raw.name,
    status: raw.status,
    conclusion: raw.conclusion,
    url: raw.html_url ?? "",
  }));
export type CheckRun = z.infer<typeof CheckRunSchema>;

// Lives here rather than issues.ts because a top-level PR comment posts to
// the issues endpoint, so the PR-comment endpoint needs it too — and
// issues.ts already imports from this file (one direction, no cycle).
export const CommentInfoSchema = z
  .object({
    id: z.number(),
    user: RawUser,
    body: z.string(),
    created_at: z.string(),
    html_url: z.string(),
  })
  .transform((raw) => ({
    id: raw.id,
    author: raw.user?.login ?? "",
    body: raw.body,
    createdAt: raw.created_at,
    url: raw.html_url,
  }));
export type CommentInfo = z.infer<typeof CommentInfoSchema>;

// --- Endpoint declarations ---------------------------------------------------
// The complete list of PR endpoints this module can hit.

type RepoParams = { owner: string; repo: string };
type PrParams = RepoParams & { number: number };
type PagedPrParams = PrParams & { perPage: number; page: number };
type PrListParams = RepoParams & { state: string; base: string; perPage: number; page: number };

const prGet: GithubEndpoint<PrParams, PrSummary> = {
  name: "GET /repos/{owner}/{repo}/pulls/{number}",
  method: "GET",
  path: (params) => `${repoPath(params.owner, params.repo)}/pulls/${params.number}`,
  response: PrSummarySchema,
};

const prList: GithubEndpoint<PrListParams, PrSummary[]> = {
  name: "GET /repos/{owner}/{repo}/pulls",
  method: "GET",
  path: (params) => `${repoPath(params.owner, params.repo)}/pulls`,
  query: (params) => {
    const query: Record<string, string> = {
      state: params.state,
      ...pagingQuery(params.perPage, params.page),
    };
    if (params.base !== "") {
      query.base = params.base;
    }
    return query;
  },
  response: z.array(PrSummarySchema),
};

const prDiff: GithubEndpoint<PrParams, string> = {
  name: "GET /repos/{owner}/{repo}/pulls/{number} (diff)",
  method: "GET",
  path: (params) => `${repoPath(params.owner, params.repo)}/pulls/${params.number}`,
  accept: "application/vnd.github.v3.diff",
  response: z.string(),
};

const prFiles: GithubEndpoint<PagedPrParams, PrFile[]> = {
  name: "GET /repos/{owner}/{repo}/pulls/{number}/files",
  method: "GET",
  path: (params) => `${repoPath(params.owner, params.repo)}/pulls/${params.number}/files`,
  query: (params) => pagingQuery(params.perPage, params.page),
  response: z.array(PrFileSchema),
};

const prReviews: GithubEndpoint<PrParams, ReviewSummary[]> = {
  name: "GET /repos/{owner}/{repo}/pulls/{number}/reviews",
  method: "GET",
  path: (params) => `${repoPath(params.owner, params.repo)}/pulls/${params.number}/reviews`,
  response: z.array(ReviewSummarySchema),
};

const prReviewComments: GithubEndpoint<PrParams, ReviewCommentInfo[]> = {
  name: "GET /repos/{owner}/{repo}/pulls/{number}/comments",
  method: "GET",
  path: (params) => `${repoPath(params.owner, params.repo)}/pulls/${params.number}/comments`,
  response: z.array(ReviewCommentInfoSchema),
};

const prCheckRuns: GithubEndpoint<RepoParams & { sha: string }, CheckRun[]> = {
  name: "GET /repos/{owner}/{repo}/commits/{sha}/check-runs",
  method: "GET",
  path: (params) => `${repoPath(params.owner, params.repo)}/commits/${params.sha}/check-runs`,
  response: z.object({ check_runs: z.array(CheckRunSchema) }).transform((raw) => raw.check_runs),
};

// --- Bindings stdlib/github.agency imports -----------------------------------

export async function _ghPrGet(number: number, owner: string, repo: string): Promise<PrSummary> {
  return _githubRequest(prGet, { owner, repo, number });
}

export async function _ghPrList(
  state: string,
  base: string,
  perPage: number,
  page: number,
  owner: string,
  repo: string,
): Promise<PrSummary[]> {
  return _githubRequest(prList, { owner, repo, state, base, perPage, page });
}

export async function _ghPrDiff(number: number, owner: string, repo: string): Promise<string> {
  return _githubRequest(prDiff, { owner, repo, number });
}

export async function _ghPrFiles(
  number: number,
  perPage: number,
  page: number,
  owner: string,
  repo: string,
): Promise<PrFile[]> {
  return _githubRequest(prFiles, { owner, repo, number, perPage, page });
}

export async function _ghPrReviews(
  number: number,
  owner: string,
  repo: string,
): Promise<ReviewSummary[]> {
  return _githubRequest(prReviews, { owner, repo, number });
}

export async function _ghPrReviewComments(
  number: number,
  owner: string,
  repo: string,
): Promise<ReviewCommentInfo[]> {
  return _githubRequest(prReviewComments, { owner, repo, number });
}

// Two requests behind the one prChecks interrupt: check runs are keyed by
// commit SHA, so the PR's head SHA has to be looked up first. The extra
// request is read-only and not model-controlled; the model supplies only the
// PR number the payload shows.
export async function _ghPrChecks(
  number: number,
  owner: string,
  repo: string,
): Promise<CheckRun[]> {
  const pr = await _githubRequest(prGet, { owner, repo, number });
  if (pr.headSha === "") {
    throw new Error(`Could not resolve the head commit of PR #${number}`);
  }
  return _githubRequest(prCheckRuns, { owner, repo, sha: pr.headSha });
}
