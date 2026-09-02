---
name: "github"
description: "Typed GitHub tools for agents: read pull requests and issues, each operation behind its own interrupt effect."
---

# github

Typed GitHub tools for agents. Each read (ghPrGet, ghIssueList, ...) raises
  its own effect, so a policy can approve exactly the operations it means to.
  Every tool operates on one repository, defaulting to the origin remote of
  the agent working directory; pass `owner` and `repo` to target another.
  Approving an effect "always" pins the approval to that one repository.

  The credential comes from GITHUB_TOKEN / GH_TOKEN, then `gh auth token`,
  then the system keyring (setSecret("github-token", ...)). No tool ever
  takes or returns a token.

  ```ts
  import { ghPrGet, ghPrFiles } from "std::github"

  node main() {
    const pr = ghPrGet(1002) with approve
    print(pr.title)
    const files = ghPrFiles(1002) with approve
    for (file in files) {
      print("${file.path}: +${file.additions} -${file.deletions}")
    }
  }
  ```

## Types

### PrState

```ts
export type PrState = "open" | "closed" | "all"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L38))

### IssueState

```ts
export type IssueState = "open" | "closed" | "all"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L39))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L41))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L56))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L57))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L58))

### CheckRun

```ts
export type CheckRun = {
  name: string;
  status: string;
  conclusion?: string;
  url: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L59))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L60))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L70))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L75))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L77))

### std::github::prDiff

```ts
@always(owner, repo)
effect std::github::prDiff {
  owner: string;
  repo: string;
  number: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L79))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L81))

### std::github::prReviewList

```ts
@always(owner, repo)
effect std::github::prReviewList {
  owner: string;
  repo: string;
  number: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L83))

### std::github::prReviewCommentList

```ts
@always(owner, repo)
effect std::github::prReviewCommentList {
  owner: string;
  repo: string;
  number: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L85))

### std::github::prChecks

```ts
@always(owner, repo)
effect std::github::prChecks {
  owner: string;
  repo: string;
  number: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L87))

### std::github::issueGet

```ts
@always(owner, repo)
effect std::github::issueGet {
  owner: string;
  repo: string;
  number: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L89))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L91))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L93))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L95))

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
  @param owner - Repository owner. Defaults to the origin remote of the current repo.
  @param repo - Repository name. Defaults to the origin remote of the current repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** [PrSummary](#prsummary)

**Throws:** `std::github::prGet`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L101))

### ghPrList

```ts
ghPrList(
  state: PrState = "open",
  base: string = "",
  perPage: number = 30,
  page: number = 1,
  owner: string = "",
  repo: string = "",
): PrSummary[] raises <std::github::prList>
```

List pull requests.
  @param state - Filter by state: "open", "closed", or "all".
  @param base - Only pull requests targeting this base branch ("" for any).
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Repository owner. Defaults to the origin remote of the current repo.
  @param repo - Repository name. Defaults to the origin remote of the current repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [PrState](#prstate) | "open" |
| base | `string` | "" |
| perPage | `number` | 30 |
| page | `number` | 1 |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `PrSummary[]`

**Throws:** `std::github::prList`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L113))

### ghPrDiff

```ts
ghPrDiff(
  number: number,
  owner: string = "",
  repo: string = "",
): string raises <std::github::prDiff>
```

Read the full unified diff of a pull request as one string.
  @param number - The pull request number.
  @param owner - Repository owner. Defaults to the origin remote of the current repo.
  @param repo - Repository name. Defaults to the origin remote of the current repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `string`

**Throws:** `std::github::prDiff`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L128))

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
  @param owner - Repository owner. Defaults to the origin remote of the current repo.
  @param repo - Repository name. Defaults to the origin remote of the current repo.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L140))

### ghPrReviews

```ts
ghPrReviews(
  number: number,
  owner: string = "",
  repo: string = "",
): ReviewSummary[] raises <std::github::prReviewList>
```

List the reviews on a pull request: verdicts, authors, and bodies.
  @param number - The pull request number.
  @param owner - Repository owner. Defaults to the origin remote of the current repo.
  @param repo - Repository name. Defaults to the origin remote of the current repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `ReviewSummary[]`

**Throws:** `std::github::prReviewList`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L154))

### ghPrReviewComments

```ts
ghPrReviewComments(
  number: number,
  owner: string = "",
  repo: string = "",
): ReviewCommentInfo[] raises <std::github::prReviewCommentList>
```

List the inline review comments on a pull request, with file and line.
  @param number - The pull request number.
  @param owner - Repository owner. Defaults to the origin remote of the current repo.
  @param repo - Repository name. Defaults to the origin remote of the current repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `ReviewCommentInfo[]`

**Throws:** `std::github::prReviewCommentList`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L166))

### ghPrChecks

```ts
ghPrChecks(
  number: number,
  owner: string = "",
  repo: string = "",
): CheckRun[] raises <std::github::prChecks>
```

List the CI check runs on the head commit of a pull request.
  @param number - The pull request number.
  @param owner - Repository owner. Defaults to the origin remote of the current repo.
  @param repo - Repository name. Defaults to the origin remote of the current repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** `CheckRun[]`

**Throws:** `std::github::prChecks`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L178))

### ghIssueGet

```ts
ghIssueGet(
  number: number,
  owner: string = "",
  repo: string = "",
): IssueSummary raises <std::github::issueGet>
```

Read one issue: title, state, author, labels, and body.
  @param number - The issue number.
  @param owner - Repository owner. Defaults to the origin remote of the current repo.
  @param repo - Repository name. Defaults to the origin remote of the current repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| owner | `string` | "" |
| repo | `string` | "" |

**Returns:** [IssueSummary](#issuesummary)

**Throws:** `std::github::issueGet`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L190))

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

List issues, optionally filtered by labels.
  @param state - Filter by state: "open", "closed", or "all".
  @param labels - Only issues carrying all of these labels ([] for any).
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Repository owner. Defaults to the origin remote of the current repo.
  @param repo - Repository name. Defaults to the origin remote of the current repo.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L202))

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
  @param owner - Repository owner. Defaults to the origin remote of the current repo.
  @param repo - Repository name. Defaults to the origin remote of the current repo.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L217))

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

Search issues and pull requests in one repository.
  @param query - GitHub search syntax, e.g. "crash in:title label:bug".
  @param perPage - Results per page, at most 100.
  @param page - Page number, starting at 1.
  @param owner - Repository owner. Defaults to the origin remote of the current repo.
  @param repo - Repository name. Defaults to the origin remote of the current repo.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/github.agency#L231))
