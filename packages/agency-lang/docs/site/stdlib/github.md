---
name: "github"
description: "Typed GitHub tools for agents: read and write pull requests and issues, each operation behind its own interrupt effect."
---

# github

Typed GitHub tools for agents. Each operation (ghPrGet, ghIssueComment, ...)
  raises its own effect, so a policy can approve exactly the operations it
  means to. Approving a pull request is its own effect, separate from
  reviewing it, so it can be forbidden by name. Every write puts the text it
  is about to post in the interrupt payload, since it goes out under the
  approver's name. GitHub treats a pull request as an issue, so the issue
  tools (ghIssueComment, ghIssueClose, ghIssueLabel) take pull request
  numbers too. There is no function to create, update, or merge a pull
  request.
  Every tool operates on one repository. With `owner` and `repo` left empty it
  uses the origin remote of the agent working directory, which `agency agent`
  sets for you; under plain `agency run` nothing sets it, so pass both names
  or call `setAgentCwd` first. Approving an effect "always" pins the approval
  to that one repository.

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
    // One interrupt, one request, however many inline comments.
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L77))

### IssueState

```ts
export type IssueState = "open" | "closed" | "all"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L79))

### ReviewEvent

```ts
export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L81))

### DiffSide

```ts
export type DiffSide = "LEFT" | "RIGHT"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L83))

### CloseReason

```ts
export type CloseReason = "completed" | "not_planned"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L85))

### ReviewComment

```ts
export type ReviewComment = {
  path: string;
  line: number;
  body: string;
  side?: DiffSide
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L87))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L94))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L107))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L123))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L131))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L139))

### CheckRun

```ts
export type CheckRun = {
  name: string;
  status: string;
  conclusion?: string;
  url: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L148))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L155))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L166))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L177))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L183))

### std::github::prDiff

```ts
@always(owner, repo)
effect std::github::prDiff {
  owner: string;
  repo: string;
  number: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L192))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L198))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L206))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L214))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L222))

### std::github::issueGet

```ts
@always(owner, repo)
effect std::github::issueGet {
  owner: string;
  repo: string;
  number: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L230))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L236))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L245))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L253))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L263))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L272))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L281))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L288))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L297))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L304))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L312))

## Functions

### ghPrGet

```ts
ghPrGet(
  number: number,
  owner: string = "",
  repo: string = "",
): PrSummary raises <std::github::prGet>
```

Read one pull request: title, state, author, branches, and body.
  @param number - The pull request number.
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** [PrSummary](#prsummary)

**Throws:** `std::github::prGet`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L323))

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
  @param state - Filter by state: "open", "closed", or "all".
  @param base - Only pull requests targeting this base branch ("" for any).
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L344))

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
  @param number - The pull request number.
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `string`

**Throws:** `std::github::prDiff`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L375))

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
  @param number - The pull request number.
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L397))

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

List the reviews on a pull request: verdicts, authors, and bodies.
  @param number - The pull request number.
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L426))

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
  @param number - The pull request number.
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L455))

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
  @param number - The pull request number.
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L484))

### ghIssueGet

```ts
ghIssueGet(
  number: number,
  owner: string = "",
  repo: string = "",
): IssueSummary raises <std::github::issueGet>
```

Read one issue: title, state, author, labels, and body. Fails if the number
  belongs to a pull request; use ghPrGet for those.
  @param number - The issue number.
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** [IssueSummary](#issuesummary)

**Throws:** `std::github::issueGet`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L513))

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

List issues, optionally filtered by labels. GitHub counts pull requests
  toward each page and this tool drops them, so a page can come back short or
  empty while later pages still hold issues. To page through every issue
  exactly, use ghIssueSearch with "is:issue".
  @param state - Filter by state: "open", "closed", or "all".
  @param labels - Only issues carrying all of these labels ([] for any).
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L535))

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
  @param number - The issue number.
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L569))

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
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L598))

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

Post one inline review comment on a line of a pull request. For several
  comments at once, use ghPrReview: one call, one approval.
  @param number - The pull request number.
  @param path - The file the comment attaches to.
  @param line - The line number in the diff.
  @param body - The comment text (markdown).
  @param side - Which side of the diff: "RIGHT" (new code) or "LEFT" (old).
  @param commitSha - The commit to anchor to. Empty means the PR head commit.
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L631))

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

Submit a review on a pull request: a verdict, an overall body, and any
  number of inline comments, in one call. To approve a pull request, use
  ghPrApprove; approving is its own permission.
  @param number - The pull request number.
  @param event - "COMMENT" or "REQUEST_CHANGES".
  @param body - The overall review text (markdown).
  @param comments - Inline comments, each with path, line, body, and an optional side.
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L684))

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
  @param number - The pull request number.
  @param body - Optional approval text (markdown).
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| body | `string` | "" |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** [ReviewSummary](#reviewsummary)

**Throws:** `std::github::prApprove`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L719))

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
  @param title - The issue title.
  @param body - The issue body (markdown).
  @param labels - Labels to apply on creation.
  @param assignees - Usernames to assign on creation.
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L746))

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
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| body | `string` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** [CommentInfo](#commentinfo)

**Throws:** `std::github::issueComment`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L777))

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
  @param reason - Why it is closing: "completed" or "not_planned".
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| reason | [CloseReason](#closereason) | "completed" |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** [IssueSummary](#issuesummary)

**Throws:** `std::github::issueUpdate`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L803))

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
  @param owner - Repository owner. Defaults to the origin remote of the agent working directory.
  @param repo - Repository name. Defaults to the origin remote of the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| labels | `string[]` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `string[]`

**Throws:** `std::github::issueLabel`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L830))
