# Updating pinned GitHub Action versions

`agency schedule add --backend github` writes a workflow that pins every
action to an exact SHA (with the tag in an inline comment) for security
hardening. The SHAs live in [`lib/cli/schedule/backends/pinnedActions.ts`](../../lib/cli/schedule/backends/pinnedActions.ts)
and are hand-maintained — agency-lang deliberately ships no Octokit
dependency to refresh them automatically.

This doc is the procedure for bumping a pinned action.

## When to bump

- A new patch/minor of `egonSchiele/run-agency-action` ships with bug
  fixes you want users to pick up.
- `actions/checkout` (or any other action we add later) ships a security
  release.

Bumping is a release-engineering task — it ships in the next agency-lang
release.

## Procedure

### 1. Decide the new tag

Pick the exact tag you want to pin (e.g. `v1.0.3`, `v4.2.0`). Avoid
moving major-tag aliases like `v1` or `v4`, since those drift and would
make the inline `# v4` comment a lie.

### 2. Look up the SHAs

The Makefile target `refresh-action-pins` queries the GitHub API for the
SHAs of the *exact* tags currently listed in
[`lib/cli/schedule/backends/pinnedActions.ts`](../../lib/cli/schedule/backends/pinnedActions.ts):

```bash
make refresh-action-pins
```

Sample output:

```
Look up these SHAs and update lib/cli/schedule/backends/pinnedActions.ts by hand:
  actions/checkout                         b4ffde65f46336ab88eb53be808477a3936bae11  # v4.1.7
  egonSchiele/run-agency-action            2a3030d846ce45a7c9d5eafad345e86db4f83a38  # v1.0.2
```

If you want to pin a *different* tag (e.g. bumping `v1.0.2` →
`v1.0.3`), edit the `for spec in ...` line in the [Makefile](../../makefile)
to list the new tag, then run the target again.

The target uses the `gh` CLI (already installed on every developer/CI
machine that touches GitHub), so no Octokit dependency is added to
agency-lang itself.

### 3. Update `pinnedActions.ts`

Open [`lib/cli/schedule/backends/pinnedActions.ts`](../../lib/cli/schedule/backends/pinnedActions.ts)
and paste the new SHA + tag into the corresponding entry:

```ts
"egonSchiele/run-agency-action": {
  sha: "<paste from step 2>",
  tag: "v1.0.3",
},
```

### 4. Update the Makefile target's tag list

The exact tags in the `refresh-action-pins` target's `for spec in ...`
loop MUST match the `tag:` values in `pinnedActions.ts`. They're the
source of truth for "which SHA does this version actually point to".
Edit both files in the same change.

### 5. Regenerate the snapshots

The github-backend snapshot tests bake the SHA + tag into their
`__snapshots__/*.yml` fixtures:

```bash
rm lib/cli/schedule/backends/__snapshots__/*.yml
pnpm test:run lib/cli/schedule/backends/github.snapshot.test.ts
```

Inspect the diff to confirm only the SHA and tag changed.

### 6. Verify

```bash
pnpm run typecheck
pnpm test:run lib/cli/schedule
```

All schedule tests should pass.

### 7. Commit

A version bump is a single commit touching three files:

```
lib/cli/schedule/backends/pinnedActions.ts
makefile
lib/cli/schedule/backends/__snapshots__/*.yml
```

Open a PR with a title like `chore(schedule): bump
egonSchiele/run-agency-action to v1.0.3`.

## What about the all-zeros placeholder?

When agency-lang ships the github backend before a new action version is
published (e.g. shipping support for a yet-to-be-released
`run-agency-action@v2.0.0`), `pinnedActions.ts` may carry a placeholder
SHA of all zeros. The runtime catches this in
[`actionRef()`](../../lib/cli/schedule/backends/github.ts) and throws a
clear error if a user tries to `--backend github` without `--no-pin`.

Once the action is actually published, follow the procedure above to
replace the placeholder with the real SHA.
