---
name: GitHub: pull requests, issues & CI
description: How to work with GitHub pull requests and issues. You have typed tools (ghPrGet, ghPrDiff, ghPrReview, ghIssueCreate, ...) for reading and reviewing PRs and for reading, creating, commenting on, closing, and labeling issues. Use those first. Use the gh CLI only for what they do not cover, such as creating or merging a PR, reading CI logs, and gh api. Read this whenever a task involves GitHub.
---

# Working with GitHub

You have two ways to reach GitHub. Typed tools cover reading and reviewing
pull requests and most issue work. The `gh` CLI covers the rest. Use the
typed tools whenever one fits. Each one takes plain arguments (a title, a
body, a number), so there is no `--body-file`, no heredoc, and no JSON to
parse. Each one also shows the user exactly what it is about to post before
it goes out, so approvals are precise.

Every typed tool acts on the repository whose `origin` remote is in the
working directory. Leave `owner` and `repo` empty unless the task names a
different repository.

## Which tool for which task

| Task | Tool |
| --- | --- |
| Read a PR: title, body, state, author, branches | `ghPrGet(number)` |
| List open PRs, or PRs against a base branch | `ghPrList(state, base)` |
| Read the full diff of a PR | `ghPrDiff(number)` |
| List the files a PR changed | `ghPrFiles(number)` |
| Read the reviews on a PR | `ghPrReviews(number)` |
| Read the inline review comments on a PR | `ghPrReviewComments(number)` |
| See whether CI passed on a PR | `ghPrChecks(number)` |
| Leave one inline comment on a line of the diff | `ghPrReviewComment(number, path, line, body)` |
| Submit a review: a comment or request changes, with optional inline comments | `ghPrReview(number, event, body, comments)` |
| Approve a PR | `ghPrApprove(number, body)` |
| Read an issue | `ghIssueGet(number)` |
| List issues, optionally by label | `ghIssueList(state, labels)` |
| Read the comments on an issue | `ghIssueComments(number)` |
| Search issues in this repository | `ghIssueSearch(query)` |
| Create an issue | `ghIssueCreate(title, body, labels, assignees)` |
| Comment on an issue or a PR | `ghIssueComment(number, body)` |
| Close an issue | `ghIssueClose(number, reason)` |
| Add labels to an issue or a PR | `ghIssueLabel(number, labels)` |

GitHub treats a pull request as an issue, so `ghIssueComment`,
`ghIssueClose`, and `ghIssueLabel` take pull request numbers too.

`ghPrReview` cannot approve. Approving is its own tool, `ghPrApprove`, so
the user can allow reviews and still forbid approvals. If you are asked to
review and the review is clean, say so in the review body with the
`COMMENT` event. Only call `ghPrApprove` when the task asks you to approve.

## Reviewing a pull request

1. `ghPrGet` for the description and the branches.
2. `ghPrDiff` for the change, or `ghPrFiles` first when the PR is large.
3. `ghPrChecks` to see whether CI is green.
4. `ghPrReviews` and `ghPrReviewComments` to avoid repeating a point
   someone already made.
5. `ghPrReview` with `event: "REQUEST_CHANGES"` or `"COMMENT"`, and the
   inline comments in `comments` so each point sits on the line it is
   about. A `REQUEST_CHANGES` review needs a body.

Do not trust root-cause analysis written in an issue or a PR description.
Read the code and the execution path yourself, then form your own
conclusion.

## What still needs `gh`

The typed tools do not create, update, or merge pull requests, and they do
not read CI logs. For those, use the `gh` CLI from inside the repository's
working tree. `gh` reads the `origin` remote, so you rarely pass the repo
name yourself.

### First: confirm you are authenticated

```bash
gh auth status
```

If this prints an account and "Logged in", you are ready. If it reports you
are not logged in, read the `gh: authentication setup` skill.

The typed tools look for a token in three places, in this order: the
`GITHUB_TOKEN` or `GH_TOKEN` environment variable, then `gh auth token`, then
the Agency keyring entry saved with `setSecret("github-token", "<token>")`.
So a machine set up for `gh` is set up for the typed tools too. The reverse
is not always true: `gh auth status` can report no login while the typed
tools still work from an environment variable or the keyring. If a typed
tool succeeds, you are authenticated, whatever `gh` says. Say so to the
caller and stop only when a typed tool fails with "No GitHub credential" and
`gh auth status` also reports no login.

### Multi-line text: always use a file or heredoc

A PR body is almost always multi-line Markdown. Passing it with
`--body "..."` mangles newlines and breaks on quotes. Write the text to a
file and pass `--body-file`:

```bash
cat > /tmp/pr-body.md <<'EOF'
## Summary
- Adds retry logic to the upload client
- Covers the timeout path with a new test

Closes #42
EOF
```

The `<<'EOF'` form (quoted delimiter) is important: it stops the shell from
expanding `$`, backticks, and `!` inside your Markdown.

### Create a PR

```bash
# Push your branch first, then open the PR against the default base branch.
git push -u origin HEAD
gh pr create --title "Short imperative title" --body-file /tmp/pr-body.md
```

Useful flags: `--draft` (open as a draft), `--base <branch>` (target a
branch other than the default), `--reviewer user1,user2`, `--label "bug"`.

To close an issue automatically when the PR merges, put a keyword in the PR
body: `Closes #42`. Each issue needs its own keyword. `Closes #1, closes #2`
closes both. `Closes #1, #2` only closes #1.

Only run `gh pr checkout 123` if you need the PR's code in your working
tree (for example, to run its tests). It switches your branch.

### CI logs

`ghPrChecks` tells you which checks failed. To read why:

```bash
gh run list --branch "$(git branch --show-current)" --limit 5
gh run view <run-id>              # summary of jobs in a workflow run
gh run view <run-id> --log-failed # only the log lines from failed steps
```

`--log-failed` is the fast path: it skips the passing output and shows just
the failing step's log, which is usually where the error is.

### `gh api`: the escape hatch

Anything neither the typed tools nor a `gh` command covers, you can reach
directly. `gh api` handles authentication and the base URL for you:

```bash
# GET: the {owner}/{repo} placeholders are filled from the current repo.
gh api repos/{owner}/{repo}/pulls/123/requested_reviewers

# POST with typed fields (-F parses numbers/booleans; -f keeps strings).
gh api repos/{owner}/{repo}/pulls/123/requested_reviewers -f 'reviewers[]=someone'

# Paginate through every page of a list endpoint.
gh api --paginate repos/{owner}/{repo}/pulls/123/commits
```

Reach for `gh api` only when nothing else fits.
