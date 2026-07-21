---
name: gh: pull requests, issues & CI
description: Use the gh (GitHub CLI) for pull requests, issues, and CI. Open, view, diff, and review PRs; read check results and failing CI logs; create, comment on, and search issues; and reach any endpoint with `gh api`. Read this whenever a task involves GitHub.
---

# Working with GitHub via `gh`

`gh` is the GitHub CLI. It talks to GitHub for you: pull requests, issues, CI
results, and the raw API. You already have a shell and `git`, so use `gh` for
anything that lives on GitHub rather than in the local repo.

Run any `gh` command from inside the repository's working tree. `gh` reads the
`origin` remote to know which repo you are acting on, so you rarely pass the repo
name yourself.

## First: confirm you are authenticated

```bash
gh auth status
```

If this prints an account and "Logged in", you are ready. If it reports you are
not logged in, read the `gh: authentication setup` skill. If no credentials are
available at all, say so to the caller and stop — do not guess.

## Multi-line text: always use a file or heredoc

A PR body, issue body, or comment is almost always multi-line Markdown. Passing
it with `--body "..."` mangles newlines and breaks on quotes. Instead write the
text to a file and pass `--body-file`, or pipe a heredoc:

```bash
# Write the body to a temp file first, then reference it.
cat > /tmp/pr-body.md <<'EOF'
## Summary
- Adds retry logic to the upload client
- Covers the timeout path with a new test

Closes #42
EOF

gh pr create --title "Add upload retry logic" --body-file /tmp/pr-body.md
```

The `<<'EOF'` form (quoted delimiter) is important: it stops the shell from
expanding `$`, backticks, and `!` inside your Markdown.

## Pull requests

### Create a PR

```bash
# Push your branch first, then open the PR against the default base branch.
git push -u origin HEAD
gh pr create --title "Short imperative title" --body-file /tmp/pr-body.md
```

Useful flags: `--draft` (open as a draft), `--base <branch>` (target a branch
other than the default), `--reviewer user1,user2`, `--label "bug"`.

To close an issue automatically when the PR merges, put a keyword in the PR
body: `Closes #42`. Each issue needs its own keyword — `Closes #1, closes #2`
closes both, but `Closes #1, #2` only closes #1.

### Inspect a PR without changing branches

You can read a PR's metadata and diff without checking it out. This keeps your
working tree where it is:

```bash
gh pr view 123               # title, body, state, checks, comments
gh pr view 123 --comments    # include the full comment thread
gh pr diff 123               # the full diff
gh pr diff 123 --name-only   # just the changed file paths
```

Only run `gh pr checkout 123` if you actually need the PR's code in your working
tree (for example, to run its tests). It switches your branch.

### Read a PR as structured data

Add `--json` with the fields you want, and `--jq` to pull values out. This is
the reliable way to feed a PR into your own logic:

```bash
gh pr view 123 --json title,state,headRefOid,statusCheckRollup
gh pr view 123 --json headRefOid --jq '.headRefOid'   # the head commit SHA
```

### Comment on or review a PR

```bash
gh pr comment 123 --body-file /tmp/comment.md          # a plain comment
gh pr review 123 --approve --body "LGTM"
gh pr review 123 --request-changes --body-file /tmp/review.md
gh pr review 123 --comment --body "A few non-blocking notes"
```

## CI: reading check results and failures

When a PR's checks fail, find out why before you try to fix anything:

```bash
gh pr checks 123             # one line per check with pass/fail
gh pr checks 123 --watch     # block until the checks finish

gh run list --branch "$(git branch --show-current)" --limit 5
gh run view <run-id>              # summary of jobs in a workflow run
gh run view <run-id> --log-failed # only the log lines from failed steps
```

`--log-failed` is the fast path: it skips the passing output and shows just the
failing step's log, which is usually where the error is.

## Issues

```bash
gh issue list                                  # open issues in this repo
gh issue list --state all --label bug --assignee @me
gh issue view 42                               # body, labels, state
gh issue view 42 --comments                    # include the discussion
gh issue view 42 --json title,body,comments,labels,state

gh issue create --title "..." --body-file /tmp/issue.md --label bug
gh issue comment 42 --body-file /tmp/note.md
gh issue close 42
gh issue close 42 --reason "not planned"
```

Do not trust root-cause analysis written in an issue. Read the code and the
execution path yourself, then form your own conclusion.

## `gh api`: the escape hatch

Anything the dedicated commands do not cover, you can reach directly. `gh api`
handles authentication and the base URL for you:

```bash
# GET — the {owner}/{repo} placeholders are filled from the current repo.
gh api repos/{owner}/{repo}/pulls/123/files --jq '.[].filename'

# POST with typed fields (-F parses numbers/booleans; -f keeps strings).
gh api repos/{owner}/{repo}/issues/42/labels -f 'labels[]=priority:high'

# Paginate through every page of a list endpoint.
gh api --paginate repos/{owner}/{repo}/issues
```

Reach for `gh api` only when no `gh <command>` fits. The named commands are
clearer and less error-prone.
