# @agency-lang/github

GitHub operations stdlib for Agency. Built on Octokit + the local `git` binary.

## Install

```bash
npm install @agency-lang/github
```

## Auth

- `GITHUB_TOKEN` — preferred (auto-provided in `egonSchiele/run-agency-action`).
- `GH_TOKEN` — `gh` CLI compatibility.
- `token` argument on each call — explicit override.

## Repo context

Auto-detected from `git remote get-url origin` (HTTPS or SSH form). Override per call with `owner` / `repo` arguments.

## Functions

| Function | Read-only? | Description |
|---|---|---|
| `createBranch` |  | Create a branch from another (default: default branch). |
| `deleteBranch` |  | Delete a branch. |
| `branchExists` | ✓ | Check whether a branch exists. |
| `commitFiles` |  | Stage + commit local changes, optionally push. Adds a `Generated-by-Agency-Action` trailer. |
| `openPullRequest` |  | Open a PR. |
| `listPullRequests` | ✓ | List PRs. |
| `commentOnPullRequest` |  | Comment on a PR. |
| `addLabel` |  | Add labels. |
| `requestReview` |  | Request reviewers. |
| `listIssues` | ✓ | List issues (excludes PRs). |
| `commentOnIssue` |  | Comment on an issue. |
| `createIssue` |  | Create an issue. |
| `defaultBranch` | ✓ | Get the repo's default branch. |

Read-only functions are marked `safe` so they're surfaced as `readOnlyHint` in `agency serve mcp`.

## Security

- Branch names are validated with a strict regex before being passed to `git`. Argument-injection patterns like `--upload-pack=...` are rejected.
- File paths in `git add` are passed after a `--` separator.
- `git push` is never `--force` or `--force-with-lease`.
- `commitFiles` does not modify global git config or write tokens to disk; auth uses whatever `origin` already has (e.g. `actions/checkout`'s extraheader, or your local credential helper).

## Example

```ts
import { commitFiles, openPullRequest } from "pkg::@agency-lang/github"

node main() {
  const commit = commitFiles(message: "agent: tidy", branch: "agent/tidy")
  openPullRequest(title: "Tidy", body: "Automated.", head: "agent/tidy")
}
```
