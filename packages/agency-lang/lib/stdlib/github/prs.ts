import { z } from "zod";
import { _githubRequest, type GithubEndpoint } from "./request.js";
import { pagingQuery, _ghCheckNumber } from "./args.js";

export function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

// GitHub sends user: null for deleted accounts.
export const RawUser = z.object({ login: z.string() }).nullable();

// --- Response schemas --------------------------------------------------------
// Each validates the raw GitHub payload and transforms it to the public shape.
// The exported types are z.infer of the transforms and mirror the native
// declarations in stdlib/github.agency; keep the two in sync. Field policy:
// nullable/optional ONLY where GitHub documents it (default applied in the
// transform); everything else required, so drift fails loudly.

// The list endpoint returns a slimmer object than the get endpoint: no
// additions, deletions, or changed_files. Hence two schemas and two types.
const RawPrListItemSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  user: RawUser,
  base: z.object({ ref: z.string() }),
  head: z.object({ ref: z.string(), sha: z.string() }),
  draft: z.boolean().optional(),
  body: z.string().nullable(),
  html_url: z.string(),
});

function toPrListItem(raw: z.infer<typeof RawPrListItemSchema>) {
  return {
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
  };
}

const PrListItemSchema = RawPrListItemSchema.transform(toPrListItem);
export type PrListItem = z.infer<typeof PrListItemSchema>;

const PrSummarySchema = RawPrListItemSchema.extend({
  additions: z.number(),
  deletions: z.number(),
  changed_files: z.number(),
}).transform((raw) => ({
  ...toPrListItem(raw),
  additions: raw.additions,
  deletions: raw.deletions,
  changedFiles: raw.changed_files,
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
    submitted_at: z.string().nullable().optional(), // null or absent on PENDING reviews
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

// Shared with issues.ts: a top-level PR comment is an issue comment on GitHub.
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

export type ReviewComment = { path: string; line: number; body: string; side?: string };

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

const prList: GithubEndpoint<PrListParams, PrListItem[]> = {
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
  response: z.array(PrListItemSchema),
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

const prReviews: GithubEndpoint<PagedPrParams, ReviewSummary[]> = {
  name: "GET /repos/{owner}/{repo}/pulls/{number}/reviews",
  method: "GET",
  path: (params) => `${repoPath(params.owner, params.repo)}/pulls/${params.number}/reviews`,
  query: (params) => pagingQuery(params.perPage, params.page),
  response: z.array(ReviewSummarySchema),
};

const prReviewComments: GithubEndpoint<PagedPrParams, ReviewCommentInfo[]> = {
  name: "GET /repos/{owner}/{repo}/pulls/{number}/comments",
  method: "GET",
  path: (params) => `${repoPath(params.owner, params.repo)}/pulls/${params.number}/comments`,
  query: (params) => pagingQuery(params.perPage, params.page),
  response: z.array(ReviewCommentInfoSchema),
};

const prCheckRuns: GithubEndpoint<
  RepoParams & { sha: string; perPage: number; page: number },
  CheckRun[]
> = {
  name: "GET /repos/{owner}/{repo}/commits/{sha}/check-runs",
  method: "GET",
  path: (params) => `${repoPath(params.owner, params.repo)}/commits/${params.sha}/check-runs`,
  query: (params) => pagingQuery(params.perPage, params.page),
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
): Promise<PrListItem[]> {
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
  perPage: number,
  page: number,
  owner: string,
  repo: string,
): Promise<ReviewSummary[]> {
  return _githubRequest(prReviews, { owner, repo, number, perPage, page });
}

export async function _ghPrReviewComments(
  number: number,
  perPage: number,
  page: number,
  owner: string,
  repo: string,
): Promise<ReviewCommentInfo[]> {
  return _githubRequest(prReviewComments, { owner, repo, number, perPage, page });
}

export async function _ghPrHeadSha(number: number, owner: string, repo: string): Promise<string> {
  const pr = await _githubRequest(prGet, { owner, repo, number });
  if (pr.headSha === "") {
    throw new Error(`Could not resolve the head commit of PR #${number}`);
  }
  return pr.headSha;
}

// Two requests behind the one prChecks interrupt, because check runs are
// keyed by commit SHA. The spec allows this: the extra read is not
// model-controlled.
export async function _ghPrChecks(
  number: number,
  perPage: number,
  page: number,
  owner: string,
  repo: string,
): Promise<CheckRun[]> {
  const sha = await _ghPrHeadSha(number, owner, repo);
  return _githubRequest(prCheckRuns, { owner, repo, sha, perPage, page });
}

// --- Write endpoints ---------------------------------------------------------

const prReviewCommentCreate: GithubEndpoint<
  PrParams & { filePath: string; line: number; body: string; side: string; commitSha: string },
  ReviewCommentInfo
> = {
  name: "POST /repos/{owner}/{repo}/pulls/{number}/comments",
  method: "POST",
  path: (params) => `${repoPath(params.owner, params.repo)}/pulls/${params.number}/comments`,
  body: (params) => ({
    path: params.filePath,
    line: params.line,
    side: params.side,
    commit_id: params.commitSha,
    body: params.body,
  }),
  response: ReviewCommentInfoSchema,
};

const prReviewCreate: GithubEndpoint<
  PrParams & { event: string; body: string; comments: ReviewComment[] },
  ReviewSummary
> = {
  name: "POST /repos/{owner}/{repo}/pulls/{number}/reviews",
  method: "POST",
  path: (params) => `${repoPath(params.owner, params.repo)}/pulls/${params.number}/reviews`,
  body: (params) => ({
    event: params.event,
    body: params.body,
    comments: params.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side ?? "RIGHT",
      body: comment.body,
    })),
  }),
  response: ReviewSummarySchema,
};

// --- Write bindings ----------------------------------------------------------

export async function _ghPrReviewComment(
  number: number,
  filePath: string,
  line: number,
  body: string,
  side: string,
  commitSha: string,
  owner: string,
  repo: string,
): Promise<ReviewCommentInfo> {
  return _githubRequest(prReviewCommentCreate, {
    owner,
    repo,
    number,
    filePath,
    line,
    body,
    side,
    commitSha,
  });
}

/** Throws on a review GitHub would refuse, so the interrupt is never raised
 *  for it: a REQUEST_CHANGES review with no body, or a comment whose line is
 *  not a positive whole number. Pure. */
export function _ghCheckReview(event: string, body: string, comments: ReviewComment[]): void {
  // The ReviewEvent type already excludes APPROVE; this is the backstop.
  if (event === "APPROVE") {
    throw new Error("To approve a pull request, use ghPrApprove. Approving is its own permission.");
  }
  if (event === "REQUEST_CHANGES" && body.trim() === "") {
    throw new Error("A REQUEST_CHANGES review needs a body saying what to change.");
  }
  for (const comment of comments) {
    _ghCheckNumber(comment.line);
  }
}

export async function _ghPrReview(
  number: number,
  event: string,
  body: string,
  comments: ReviewComment[],
  owner: string,
  repo: string,
): Promise<ReviewSummary> {
  _ghCheckReview(event, body, comments);
  return _githubRequest(prReviewCreate, { owner, repo, number, event, body, comments });
}

export async function _ghPrApprove(
  number: number,
  body: string,
  owner: string,
  repo: string,
): Promise<ReviewSummary> {
  return _githubRequest(prReviewCreate, {
    owner,
    repo,
    number,
    event: "APPROVE",
    body,
    comments: [],
  });
}
