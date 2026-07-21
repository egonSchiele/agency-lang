---
name: gh: authentication setup
description: Set up GitHub authentication for the gh CLI when `gh auth status` reports you are not logged in. Covers non-interactive token login, wiring gh's credentials into git, and the GH_TOKEN / GITHUB_TOKEN environment variables.
---

# Authenticating the `gh` CLI

Read this only when `gh auth status` reports that you are not logged in. If it
already shows an account, you are authenticated — go back to the task.

You run without a browser, so the interactive `gh auth login` flow that opens a
web page will not work. Use a token instead.

## Is a token already available?

Check the environment first — a token is often already present:

```bash
gh auth status
echo "${GH_TOKEN:-${GITHUB_TOKEN:-no token in env}}"
```

`gh` reads `GH_TOKEN` and `GITHUB_TOKEN` automatically. If either is set, `gh`
is effectively authenticated already and `gh auth status` should reflect that.
If neither is set and you cannot find a token, tell the caller that GitHub
authentication is missing and stop — you cannot mint a token yourself.

## Log in with a token

If you have a personal access token but `gh` is not using it, pipe it in. Do not
put the token directly on the command line, where it would be saved in shell
history:

```bash
echo "$GITHUB_TOKEN" | gh auth login --with-token
```

The token needs the `repo` scope for repository work, and `workflow` if you will
touch GitHub Actions.

## Let git use gh's credentials

So that `git push`, `git pull`, and `git clone` over HTTPS authenticate through
`gh`:

```bash
gh auth setup-git
```

## Verify

```bash
gh auth status        # should now show your account as logged in
gh api user --jq '.login'   # prints your GitHub username
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `gh auth status`: not logged in, but a token is set | The token may be invalid or expired. Confirm with `gh api user`; if it fails, the token is bad. |
| `git push` still prompts for a password | Run `gh auth setup-git` so git uses gh's credentials over HTTPS. |
| `HTTP 403` / "Resource not accessible" | The token lacks the needed scope (for example `workflow` for Actions). A new token with the right scopes is required. |
