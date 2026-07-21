---
name: gh: repositories, releases & workflows
description: Use the gh (GitHub CLI) to manage repositories and releases, beyond day-to-day PR and issue work. Create, clone, fork, and edit repos; cut releases and upload assets; trigger and re-run Actions workflows; set secrets; and create gists.
---

# Repositories, releases, and workflows via `gh`

This skill covers the GitHub operations you reach for less often than PRs and
issues. For pull requests, issues, and CI, read the `gh: pull requests, issues
& CI` skill instead. If `gh auth status` says you are not logged in, read the
`gh: authentication setup` skill first.

As with all `gh` work, write any multi-line body (release notes, descriptions)
to a file and pass it with a `--notes-file` / `--body-file` flag rather than
inlining it with quotes.

## Repositories

```bash
gh repo clone owner/repo                 # clone (add `-- --depth 1` for shallow)
gh repo view owner/repo                  # description, default branch, topics
gh repo create my-project --public --clone
gh repo create my-project --private --description "..." --license MIT --clone
gh repo create owner/name --source . --push   # publish the current directory

gh repo fork owner/repo --clone          # fork, clone, and add `upstream`
gh repo sync owner/repo                   # pull upstream changes into a fork

gh repo edit --description "..." --add-topic "cli,automation"
gh repo edit --default-branch main --enable-auto-merge
```

## Releases

```bash
gh release create v1.2.0 --title "v1.2.0" --generate-notes
gh release create v1.2.0 --notes-file /tmp/notes.md
gh release create v2.0.0-rc1 --draft --prerelease --generate-notes

# Attach built artifacts by listing them after the tag.
gh release create v1.2.0 ./dist/app-linux ./dist/app-macos --generate-notes

gh release list
gh release view v1.2.0
gh release download v1.2.0 --dir ./downloads
```

`--generate-notes` writes the release notes from merged PRs and commits since the
last release, so you rarely need to write them by hand.

## Actions workflows

```bash
gh workflow list
gh workflow run ci.yml --ref main                  # trigger a workflow_dispatch
gh workflow run deploy.yml -f environment=staging  # pass inputs with -f

gh run list --workflow ci.yml --limit 10
gh run view <run-id>
gh run rerun <run-id>            # re-run the whole workflow
gh run rerun <run-id> --failed   # re-run only the failed jobs
gh run watch <run-id>            # block until the run finishes
```

## Secrets

Pass the value on stdin or from a file, never with `--body "..."` — a value on
the command line is captured in shell history and visible in process listings.

```bash
printf %s "$API_KEY" | gh secret set API_KEY   # value piped in on stdin
gh secret set SSH_KEY < ~/.ssh/id_ed25519      # value read from a file
gh secret list                                 # names only; values are never shown
gh secret delete API_KEY
```

`gh secret set` encrypts the value with the repository's public key for you. Set
repository secrets by default; add `--env <name>` for an environment secret or
`--org <name>` for an organization secret.

## Gists

```bash
gh gist create script.py --public --desc "One-off helper"
gh gist list
gh gist view <id>
```
