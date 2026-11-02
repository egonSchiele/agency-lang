---
name: "github"
description: "Read and manage GitHub issues and pull request reviews."
---

# github

Inspect issues, pull requests, diffs, and checks, then post comments or
  reviews. Each operation has its own effect. Pull request approval is
  separate from commenting or requesting changes, so a policy can allow
  reviews while rejecting approvals. Write interrupts include the text
  about to be posted under the authenticated account. GitHub treats a pull request as an issue, so the issue
  tools (ghIssueComment, ghIssueClose, ghIssueLabel) take pull request
  numbers too. There is no function to create, update, or merge a pull
  request.
  Every tool operates on one repository. With `owner` and `repo` left empty it
  uses the origin remote of the agent working directory, which `agency agent`
  sets for you; under plain `agency run` nothing sets it, so pass both names
  or call `setAgentCwd` first. Approving an effect "always" pins the approval
  to that one repository.
  The coding agent carries all of these tools and the review agent carries
  the reads, through the githubTools and githubReadTools bundles in
  std::agents/lib/toolkits.

  The credential comes from GITHUB_TOKEN / GH_TOKEN, then `gh auth token`,
  then the system keyring (setSecret("github-token", ...)). No tool ever
  takes or returns a token.

  ```ts
  import { ghPrGet, ghPrFiles, ghPrReview } from "std::github"

  node main() {
    const pr = ghPrGet(1002) with approve
    print(pr.title)
    const files = ghPrFiles(1002) with approve
    for (file in files) {
      print("${file.path}: +${file.additions} -${file.deletions}")
    }
    ghPrReview(1002, "COMMENT", "Two small things.", [
      { path: "lib/a.ts", line: 12, body: "This can be a const." },
    ]) with approve
  }
  ```

## Types

### PrState

```ts
export type PrState = "open" | "closed" | "all"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L78))

### IssueState

```ts
export type IssueState = "open" | "closed" | "all"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L80))

### ReviewEvent

```ts
export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L82))

### DiffSide

```ts
export type DiffSide = "LEFT" | "RIGHT"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L84))

### CloseReason

```ts
export type CloseReason = "completed" | "not_planned"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L86))

### ReviewComment

```ts
export type ReviewComment = {
  path: string;
  line: number;
  body: string;
  side?: DiffSide
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L88))

### PrListItem

```ts
export type PrListItem = {
  number: number;
  title: string;
  state: string;
  author: string;
  base: string;
  head: string;
  headSha: string;
  draft: boolean;
  body: string;
  url: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L95))

### PrSummary

```ts
export type PrSummary = {
  number: number;
  title: string;
  state: string;
  author: string;
  base: string;
  head: string;
  headSha: string;
  draft: boolean;
  body: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L108))

### PrFile

```ts
export type PrFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L124))

### ReviewSummary

```ts
export type ReviewSummary = {
  id: number;
  author: string;
  state: string;
  body: string;
  submittedAt: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L132))

### ReviewCommentInfo

```ts
export type ReviewCommentInfo = {
  id: number;
  path: string;
  line?: number;
  author: string;
  body: string;
  url: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L140))

### CheckRun

```ts
export type CheckRun = {
  name: string;
  status: string;
  conclusion?: string;
  url: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L149))

### IssueSummary

```ts
export type IssueSummary = {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  assignees: string[];
  body: string;
  url: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L156))

### CommentInfo

```ts
export type CommentInfo = {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L167))

## Effects

### std::github::prGet

```ts
@always(owner, repo)
effect std::github::prGet {
  owner: string;
  repo: string;
  number: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L178))

### std::github::prList

```ts
@always(owner, repo)
effect std::github::prList {
  owner: string;
  repo: string;
  state: string;
  base: string;
  perPage: number;
  page: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L184))

### std::github::prDiff

```ts
@always(owner, repo)
effect std::github::prDiff {
  owner: string;
  repo: string;
  number: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L193))

### std::github::prFiles

```ts
@always(owner, repo)
effect std::github::prFiles {
  owner: string;
  repo: string;
  number: number;
  perPage: number;
  page: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L199))

### std::github::prReviewList

```ts
@always(owner, repo)
effect std::github::prReviewList {
  owner: string;
  repo: string;
  number: number;
  perPage: number;
  page: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L207))

### std::github::prReviewCommentList

```ts
@always(owner, repo)
effect std::github::prReviewCommentList {
  owner: string;
  repo: string;
  number: number;
  perPage: number;
  page: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L215))

### std::github::prChecks

```ts
@always(owner, repo)
effect std::github::prChecks {
  owner: string;
  repo: string;
  number: number;
  perPage: number;
  page: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L223))

### std::github::issueGet

```ts
@always(owner, repo)
effect std::github::issueGet {
  owner: string;
  repo: string;
  number: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L231))

### std::github::issueList

```ts
@always(owner, repo)
effect std::github::issueList {
  owner: string;
  repo: string;
  state: string;
  labels: string[];
  perPage: number;
  page: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L237))

### std::github::issueCommentList

```ts
@always(owner, repo)
effect std::github::issueCommentList {
  owner: string;
  repo: string;
  number: number;
  perPage: number;
  page: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L246))

### std::github::issueSearch

```ts
@always(owner, repo)
effect std::github::issueSearch {
  owner: string;
  repo: string;
  query: string;
  perPage: number;
  page: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L254))

### std::github::prReviewComment

```ts
@always(owner, repo)
effect std::github::prReviewComment {
  owner: string;
  repo: string;
  number: number;
  path: string;
  line: number;
  body: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L264))

### std::github::prReview

```ts
@always(owner, repo)
effect std::github::prReview {
  owner: string;
  repo: string;
  number: number;
  event: string;
  body: string;
  comments: ReviewComment[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L273))

### std::github::prApprove

```ts
@always(owner, repo)
effect std::github::prApprove {
  owner: string;
  repo: string;
  number: number;
  body: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L282))

### std::github::issueCreate

```ts
@always(owner, repo)
effect std::github::issueCreate {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
  assignees: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L289))

### std::github::issueComment

```ts
@always(owner, repo)
effect std::github::issueComment {
  owner: string;
  repo: string;
  number: number;
  body: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L298))

### std::github::issueUpdate

```ts
@always(owner, repo)
effect std::github::issueUpdate {
  owner: string;
  repo: string;
  number: number;
  state: string;
  reason: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L305))

### std::github::issueLabel

```ts
@always(owner, repo)
effect std::github::issueLabel {
  owner: string;
  repo: string;
  number: number;
  labels: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L313))

## Functions

### ghPrGet

```ts
ghPrGet(
  number: number,
  owner: string = "",
  repo: string = "",
): PrSummary raises <std::github::prGet>
```

Read a pull request’s details and description.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** [PrSummary](#prsummary)

**Throws:** `std::github::prGet`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L325))

### ghPrList

```ts
ghPrList(
  state: PrState = "open",
  base: string = "",
  perPage: number = 30,
  page: number = 1,
  owner: string = "",
  repo: string = "",
): PrListItem[] raises <std::github::prList>
```

List pull requests. Each item has no change counts; ghPrGet returns those.
  @param base - Only pull requests targeting this base branch ("" for any).
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [PrState](#prstate) | "open" |
| base | `string` | "" |
| perPage | `number` | 30 |
| page | `number` | 1 |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `PrListItem[]`

**Throws:** `std::github::prList`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L346))

### ghPrDiff

```ts
ghPrDiff(
  number: number,
  owner: string = "",
  repo: string = "",
): string raises <std::github::prDiff>
```

Read the full unified diff of a pull request as one string. GitHub refuses
  this for very large pull requests; use ghPrFiles for those.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `string`

**Throws:** `std::github::prDiff`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L377))

### ghPrFiles

```ts
ghPrFiles(
  number: number,
  perPage: number = 100,
  page: number = 1,
  owner: string = "",
  repo: string = "",
): PrFile[] raises <std::github::prFiles>
```

List the files a pull request changes, with per-file add/delete counts and patch hunks.
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| perPage | `number` | 100 |
| page | `number` | 1 |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `PrFile[]`

**Throws:** `std::github::prFiles`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L399))

### ghPrReviews

```ts
ghPrReviews(
  number: number,
  perPage: number = 30,
  page: number = 1,
  owner: string = "",
  repo: string = "",
): ReviewSummary[] raises <std::github::prReviewList>
```

Read the submitted reviews on a pull request.
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| perPage | `number` | 30 |
| page | `number` | 1 |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `ReviewSummary[]`

**Throws:** `std::github::prReviewList`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L428))

### ghPrReviewComments

```ts
ghPrReviewComments(
  number: number,
  perPage: number = 30,
  page: number = 1,
  owner: string = "",
  repo: string = "",
): ReviewCommentInfo[] raises <std::github::prReviewCommentList>
```

List the inline review comments on a pull request, with file and line.
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| perPage | `number` | 30 |
| page | `number` | 1 |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `ReviewCommentInfo[]`

**Throws:** `std::github::prReviewCommentList`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L457))

### ghPrChecks

```ts
ghPrChecks(
  number: number,
  perPage: number = 30,
  page: number = 1,
  owner: string = "",
  repo: string = "",
): CheckRun[] raises <std::github::prChecks>
```

List the CI check runs on the head commit of a pull request.
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| perPage | `number` | 30 |
| page | `number` | 1 |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `CheckRun[]`

**Throws:** `std::github::prChecks`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L486))

### ghIssueGet

```ts
ghIssueGet(
  number: number,
  owner: string = "",
  repo: string = "",
): IssueSummary raises <std::github::issueGet>
```

Read an issue’s details and description. Pull request numbers are rejected.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** [IssueSummary](#issuesummary)

**Throws:** `std::github::issueGet`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L515))

### ghIssueList

```ts
ghIssueList(
  state: IssueState = "open",
  labels: string[] = [],
  perPage: number = 30,
  page: number = 1,
  owner: string = "",
  repo: string = "",
): IssueSummary[] raises <std::github::issueList>
```

List issues, optionally filtered by labels. A short or empty page can
  still have later pages because pull requests are excluded from results.
  @param labels - Only issues carrying all of these labels ([] for any).
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

GitHub includes pull requests in the underlying page, then this tool
  removes them. Use `ghIssueSearch` with `is:issue` when you need pagination
  that counts issues alone.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [IssueState](#issuestate) | "open" |
| labels | `string[]` | [] |
| perPage | `number` | 30 |
| page | `number` | 1 |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `IssueSummary[]`

**Throws:** `std::github::issueList`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L541))

### ghIssueComments

```ts
ghIssueComments(
  number: number,
  perPage: number = 30,
  page: number = 1,
  owner: string = "",
  repo: string = "",
): CommentInfo[] raises <std::github::issueCommentList>
```

List the comments on an issue.
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| perPage | `number` | 30 |
| page | `number` | 1 |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `CommentInfo[]`

**Throws:** `std::github::issueCommentList`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L573))

### ghIssueSearch

```ts
ghIssueSearch(
  query: string,
  perPage: number = 30,
  page: number = 1,
  owner: string = "",
  repo: string = "",
): IssueSummary[] raises <std::github::issueSearch>
```

Search issues and pull requests in one repository. The query must not
  contain a repo:, org:, or user: qualifier.
  @param query - GitHub search syntax, e.g. "crash in:title label:bug".
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |
| perPage | `number` | 30 |
| page | `number` | 1 |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `IssueSummary[]`

**Throws:** `std::github::issueSearch`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L602))

### ghPrReviewComment

```ts
ghPrReviewComment(
  number: number,
  path: string,
  line: number,
  body: string,
  side: DiffSide = "RIGHT",
  commitSha: string = "",
  owner: string = "",
  repo: string = "",
): ReviewCommentInfo raises <std::github::prReviewComment>
```

Post one inline comment on a pull request diff.
  @param path - The repository-relative path shown in the pull request diff.
  @param line - The one-based file line on the chosen diff side, within a changed hunk.
  @param body - The comment text (markdown).
  @param side - Which side of the diff: "RIGHT" (new code) or "LEFT" (old).
  @param commitSha - The commit to anchor to. Empty means the PR head commit.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

Use `ghPrReview` to submit several inline comments in one review. The
  comment attaches to the selected commit, defaulting to the PR head.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| path | `string` |  |
| line | `number` |  |
| body | `string` |  |
| side | [DiffSide](#diffside) | "RIGHT" |
| commitSha | `string` | "" |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** [ReviewCommentInfo](#reviewcommentinfo)

**Throws:** `std::github::prReviewComment`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L640))

### ghPrReview

```ts
ghPrReview(
  number: number,
  event: ReviewEvent = "COMMENT",
  body: string = "",
  comments: ReviewComment[] = [],
  owner: string = "",
  repo: string = "",
): ReviewSummary raises <std::github::prReview>
```

Submit a pull request review with an overall comment and optional inline
  comments, either commenting or requesting changes.
  @param body - Overall review text in Markdown, required when requesting changes.
  @param comments - Inline comments, each with path, line, body, and an optional side.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

Submit overall feedback and inline comments together. Use `ghPrApprove`
  for a formal approval, which has its own effect.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| event | [ReviewEvent](#reviewevent) | "COMMENT" |
| body | `string` | "" |
| comments | `ReviewComment[]` | [] |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** [ReviewSummary](#reviewsummary)

**Throws:** `std::github::prReview`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L696))

### ghPrApprove

```ts
ghPrApprove(
  number: number,
  body: string = "",
  owner: string = "",
  repo: string = "",
): ReviewSummary raises <std::github::prApprove>
```

Approve a pull request. This is a formal review approval that can satisfy
  branch protection and unblock a merge.
  @param body - Optional approval text (markdown).
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| body | `string` | "" |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** [ReviewSummary](#reviewsummary)

**Throws:** `std::github::prApprove`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L729))

### ghIssueCreate

```ts
ghIssueCreate(
  title: string,
  body: string,
  labels: string[] = [],
  assignees: string[] = [],
  owner: string = "",
  repo: string = "",
): IssueSummary raises <std::github::issueCreate>
```

Create an issue.
  @param body - The issue body (markdown).
  @param labels - Labels to apply on creation.
  @param assignees - Usernames to assign on creation.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |
| body | `string` |  |
| labels | `string[]` | [] |
| assignees | `string[]` | [] |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** [IssueSummary](#issuesummary)

**Throws:** `std::github::issueCreate`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L756))

### ghIssueComment

```ts
ghIssueComment(
  number: number,
  body: string,
  owner: string = "",
  repo: string = "",
): CommentInfo raises <std::github::issueComment>
```

Post a comment on an issue or pull request.
  @param number - The issue or pull request number.
  @param body - The comment text (markdown).
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| body | `string` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** [CommentInfo](#commentinfo)

**Throws:** `std::github::issueComment`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L787))

### ghIssueClose

```ts
ghIssueClose(
  number: number,
  reason: CloseReason = "completed",
  owner: string = "",
  repo: string = "",
): IssueSummary raises <std::github::issueUpdate>
```

Close an issue or pull request.
  @param number - The issue or pull request number.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| reason | [CloseReason](#closereason) | "completed" |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** [IssueSummary](#issuesummary)

**Throws:** `std::github::issueUpdate`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L814))

### ghIssueLabel

```ts
ghIssueLabel(
  number: number,
  labels: string[],
  owner: string = "",
  repo: string = "",
): string[] raises <std::github::issueLabel>
```

Add labels to an issue or pull request. Returns the full label list after the change.
  @param number - The issue or pull request number.
  @param labels - The labels to add.
  @param owner - Pass with repo, or leave both empty to use the agent working directory’s origin remote.
  @param repo - The repository name without the owner, supplied together with owner.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| labels | `string[]` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `string[]`

**Throws:** `std::github::issueLabel`

**Needs:** `fileRead`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L841))
