# Scheduled agents: push a branch, do the work, stay inside a budget

Design for changing the three scheduled maintenance agents
(`docs-review`, `constants-review`, `stdlib-docs-links`) from opening pull
requests to pushing a branch, from reporting problems to fixing them, and from
unbounded to budgeted.

## Why

Three problems with the agents as they stand.

**They need a permission we do not want to grant.** Opening a pull request from
a workflow requires turning on *"Allow GitHub Actions to create and approve pull
requests"* in repository settings. That setting applies to every workflow in the
repository, not just these three. Pushing a branch needs only `contents: write`,
which the jobs already have.

**Two of the three only write a report.** `docs-review` and `constants-review`
audit the codebase and produce a list of things a human should go fix. That
leaves all the work undone. A branch with the fix applied is strictly more
useful: the review effort is the same, and merging is one click instead of an
afternoon.

**Nothing caps what a run can spend.** `docs-review` starts one LLM thread per
file under `docs/dev/` — about sixty today — with no ceiling on cost or time.

## What changes

### 1. Branch instead of pull request

`pr.agency` becomes `branch.agency`. Its whole documented purpose today is
pull-request mechanics, so the name would otherwise be a lie.

- `openPr` becomes `pushBranch`. Same body, minus the `gh pr create` call. It
  returns the GitHub compare URL (`…/compare/<branch>?expand=1`) instead of a
  pull request URL. That link is a one-click "open the PR" for the human.
- `openPrExists` is deleted. It existed to skip a run when last week's pull
  request was still open; with a fixed branch there is nothing to check.
- Each agent owns exactly one branch, force-pushed on every run:

  | Agent | Branch |
  |---|---|
  | `docs-review` | `chore/docs-freshness` |
  | `constants-review` | `chore/constants-review` |
  | `stdlib-docs-links` | `chore/stdlib-doc-links` |

- `stamp()` no longer names branches. It moves into the report header so a
  reader can still tell when a run happened.
- The three workflow files drop `pull-requests: write` and keep
  `contents: write`.

**Force-push safeguard.** Before pushing, `pushBranch` reads the author of the
remote branch's tip commit:

- `agency-scheduler[bot]` — force-push. This includes the case where a human has
  opened a pull request from the branch but not edited it; that pull request
  simply refreshes to the current findings.
- anyone else — skip the push and print a warning naming the branch.

So a run freely overwrites its own previous output but never a human's commits.
This costs one `git log -1` call.

`CLAUDE.md` says *"NEVER force push or amend commits."* That rule is about
shared history. These are bot-owned scratch branches whose entire content is
regenerated each run, and the safeguard above means a force-push can never
destroy human work. `branch.agency`'s module doc records this exception so it
does not read as a violation.

### 2. The agents do the work

`docs-review` and `constants-review` gain the `edit` tool from `std::fs`
alongside the `read` and `grep` they already have. They fix what they find
instead of describing it.

**Why handing over `edit` is safe enough here.** The previous design withheld
write tools so that a prompt injection buried in a document could not escalate.
That threat model does not apply: these agents read only files already committed
to `main`, so injecting text requires commit access — and anyone with commit
access can do the damage directly. The control guarded against an attacker who
already had the capability being guarded.

**`std::fs.edit` is already fail-closed.** Its contract: *"Each edit's oldText
must match a unique, non-overlapping region of the file as it stands when that
edit runs. If any edit fails, nothing is written."* A hallucinated or ambiguous
replacement is rejected atomically. No hand-rolled verification is needed, and
writing one would duplicate stdlib behavior.

**A handler scopes each agent to its own directory.** Handlers are the
language's safety mechanism, so the scope check belongs in one:

```ts
} with (i) {
  if (i.effect == "std::edit") {
    if (isInside(i.data.dir, i.data.filename, devDir)) { return approve() }
    print("Rejected edit outside ${devDir}: ${i.data.filename}")
    return reject()
  }
  return pass()
}
```

A confused run cannot wander into `lib/` or `.github/`. Because `std::edit`
carries `before` and `after` in its payload, the same handler records a diff of
every applied change for the report at no extra cost.

`isInside` is a new helper in `branch.agency`, and it must get two details right
or the control does not hold:

- **Join before comparing.** The `std::edit` payload carries `dir` and
  `filename` separately and the file is `dir/filename`. Checking `dir` alone
  lets a `filename` of `../../lib/config.ts` escape. Join them, then resolve the
  result to an absolute path (`git rev-parse --show-toplevel` gives the root to
  resolve against), so `..` segments are collapsed before the check.
- **Compare against the directory plus a trailing separator**, not a bare
  prefix. A plain `startsWith("docs/dev")` also accepts `docs/dev-scratch`.
  Comparing against `docs/dev/` — or requiring exact equality with the directory
  itself — closes that.

Both are ordinary path-prefix mistakes, and this handler is the control that
replaces the previously withheld write tools, so the tests below cover them
explicitly.

**No `exec` for any agent.** This is the one capability withheld, and for a
reason that survives the argument above: the runner holds a `GITHUB_TOKEN` with
`contents: write` in its environment. File edits land in the diff a human
reviews. Shell commands do not — they could push to other branches or send the
token elsewhere, and none of it would appear in the diff. File editing is fully
covered by the review gate; shell access is not covered at all.

**Reports change meaning.** `docs/dev/_reports/*.md` becomes a record of what
*was changed and why*, plus anything the model proposed that `edit` rejected. It
is committed on the branch beside the fix, so the diff and its rationale arrive
together.

`stdlib-docs-links` already applies its own fix behind a deterministic
fail-closed guard and gives the model no tools. It changes only in the branch
model and the guard added below.

### 3. Cost and time guards

Every agent wraps its LLM phase in a guard.

| Agent | Cadence | `cost:` | `time:` | Workflow `timeout-minutes` |
|---|---|---|---|---|
| `docs-review` | weekly | `$3.00` | `25m` | 30 |
| `constants-review` | weekly | `$3.00` | `25m` | 30 |
| `stdlib-docs-links` | daily | `$0.50` | `25m` | 30 |

**The guard is 25 minutes against a 30-minute workflow timeout, deliberately.**
If the two were equal, the runner would usually kill the job first and the
branch would never be pushed. Five minutes of headroom lets the guard fire, the
agent write its files, and the push complete.

**The guard wraps the LLM phase only — not the file writes or the push.** A time
guard tripping in the middle of `git push` would leave a half-pushed branch and
no report. Guarding the expensive nondeterministic part and leaving the cheap
deterministic part outside caps spend without risking a torn result.

**`saveDraft` makes a trip non-destructive.** Without it a tripped guard discards
everything, so a 25-minute, $3 run that trips pushes nothing:

```ts
const result = guard(label: "docs-review", cost: $3.00, time: 25m) {
  let sections: string[] = []
  for (rel in files) {
    // ... review one doc, apply edits ...
    sections.push(finding)
    saveDraft(sections)
  }
  return sections
}
```

A trip now returns `success` carrying the last draft, so the branch still gets
however many files the run completed.

**Truncation must be visible.** Because `saveDraft` turns a trip into a success,
the returned value alone cannot distinguish a complete run from a truncated one.
The agent compares the number of files processed against the number found and
writes the result into the report header — *"reviewed 41 of 60 docs before the
25m budget tripped"* — so a short report never reads as a clean bill of health.

Guards also bound the cost consequence of dropping the skip guard in §1:
`docs-review` is capped at $3.00 per week, roughly $156 a year worst case.

### 4. Notification: out of scope

The repository owner will add email notification separately. `pushBranch`
returns the compare URL and each agent prints it, which is the seam that code
will hook into. No notification mechanism is designed or built here.

## Prerequisite

The three workflow files currently pin `egonSchiele/run-agency-action` at
`2a3030d` (v1.0.2), which is broken — it fails in about fourteen seconds before
running the agent at all. `v1.0.3` (`4768784aa7611fafee0801e01cdaea9f06d08dfb`)
fixes it. Until the pin is bumped, none of the work in this spec can run.

Bumping is a separate change with its own documented procedure in
`docs/dev/updating-pinned-actions.md`, and it touches two places:

1. `lib/cli/schedule/backends/pinnedActions.ts` and the matching tag list in the
   `makefile` — these control workflows generated in *future*.
2. The three existing files in `.github/workflows/` — these are what actually
   runs. The documented procedure does not mention them, so following it alone
   would leave the scheduled jobs broken while appearing to have fixed them.

## Testing

- **`branch.agency` unit coverage** for `pushBranch`: force-push proceeds on a
  bot-authored tip, skips on a human-authored tip, and returns a well-formed
  compare URL.
- **Path-scope handler** (`isInside`): an edit inside the agent's directory is
  approved; one outside is rejected and reported. This is the control that
  replaces the withheld write tools, so it needs direct tests for both ways it
  can silently fail — a `filename` containing `../` that escapes the directory,
  and a sibling directory sharing a name prefix (`docs/dev-scratch` against
  `docs/dev`).
- **Truncation reporting**: a guard trip yields a branch whose report states how
  many files were processed out of how many found.
- **No LLM calls required.** All of the above are deterministic and belong in
  `tests/agency/` or `tests/agency-js/` per `docs/misc/TESTING.md`.
- The agents' end-to-end behavior stays covered by running them manually with
  `workflow_dispatch` before relying on the schedule.

## Consequences

- Merging becomes: review a diff, click "Compare & pull request", merge.
- *"Allow GitHub Actions to create and approve pull requests"* stays off.
- Each agent leaves at most one branch behind, always reflecting the latest run.
- Unreviewed findings from a previous run are replaced rather than queued. This
  is intentional: each run re-derives its findings against current code, so the
  newer branch supersedes the older one.
- Weekly spend is bounded and predictable.
- A run that trips its budget still delivers partial, clearly-labeled work.
