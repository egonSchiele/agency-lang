# Scheduled Agents: Branch Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change the three scheduled maintenance agents to push a branch instead of opening a pull request, apply their fixes instead of only reporting them, and run inside a cost and time budget.

**Architecture:** `pr.agency` is renamed `branch.agency`; its `openPr` becomes `pushBranch`, which force-pushes one fixed branch per agent and returns a GitHub compare URL. `docs-review` and `constants-review` gain the `edit` tool from `std::fs`, with a handler that rejects any edit under `.github/`. Every agent wraps its LLM phase — not its git phase — in a `guard`. All decision logic is extracted into pure exported functions so it can be tested without LLM calls.

**Tech Stack:** Agency language, `std::fs` (`edit`, `write`, `mkdir`), `std::shell` (`exec`, `grep`, `glob`), `std::system` (`env`, `exit`), GitHub Actions, TypeScript (for the pinned-action generator).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-13-scheduled-agents-branch-output-design.md`.
- All paths are relative to `packages/agency-lang/` unless they begin with `.github/`, which is repo-root.
- Agency syntax: `def`/`node` with curly braces, parenthesised conditions, `let`/`const` declarations, `for (x in xs)`. Verify against `docs/site/guide/basic-syntax.md` when unsure.
- Tests go in `tests/agency/scheduled-helpers.agency`, which already exists and uses the pattern "each `node` self-checks and returns `"ok"` or `"bad:<value>"`". **No LLM calls in any test.**
- Run a single Agency test with `pnpm run agency test tests/agency/scheduled-helpers.agency`.
- Do NOT run the full test suite locally; it is slow and expensive. CI runs it on the PR.
- Save test output to a file rather than re-running to see failures.
- The bot identity is exactly `agency-scheduler[bot]`.
- Guard values: `docs-review` and `constants-review` `cost: $3.00`, `stdlib-docs-links` `cost: $0.50`; all three `time: 25m` against the workflows' unchanged `timeout-minutes: 30`.
- No agent gets the `exec` tool.
- Commit messages and PR bodies must be written to a file and passed with `-F`, never inline on the command line (apostrophes break it).

---

### Task 1: Bump the run-agency-action pin to v1.0.3

The three scheduled workflows pin `2a3030d` (v1.0.2), which fails in ~14 seconds before running the agent. Nothing else in this plan can run until this lands. Procedure documented in `docs/dev/updating-pinned-actions.md`, plus the three live workflow files that procedure omits.

**Files:**
- Modify: `lib/cli/schedule/backends/pinnedActions.ts:15-18`
- Modify: `makefile:168`
- Modify: `.github/workflows/docs-review.yml:21`
- Modify: `.github/workflows/constants-review.yml:21`
- Modify: `.github/workflows/stdlib-docs-links.yml:21`
- Regenerate: `lib/cli/schedule/backends/__snapshots__/*.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: `PINNED_ACTIONS["egonSchiele/run-agency-action"] = { sha: "4768784aa7611fafee0801e01cdaea9f06d08dfb", tag: "v1.0.3" }`.

- [ ] **Step 1: Confirm the tag still resolves to the expected SHA**

```bash
gh api repos/egonSchiele/run-agency-action/git/ref/tags/v1.0.3 --jq '.object.sha'
```

Expected: `4768784aa7611fafee0801e01cdaea9f06d08dfb`. If it differs, use what the command returns and use that value everywhere below.

- [ ] **Step 2: Update the generator pin**

In `lib/cli/schedule/backends/pinnedActions.ts`:

```ts
  "egonSchiele/run-agency-action": {
    sha: "4768784aa7611fafee0801e01cdaea9f06d08dfb",
    tag: "v1.0.3",
  },
```

- [ ] **Step 3: Update the makefile tag list to match**

In `makefile` line 168, change `egonSchiele/run-agency-action@v1.0.2` to `egonSchiele/run-agency-action@v1.0.3`. The tags here must match `pinnedActions.ts` exactly; they are the source of truth for which SHA a version points at.

- [ ] **Step 4: Update the three live workflow files**

These are what actually runs on a schedule. The documented procedure does not mention them, so skipping this leaves the jobs broken while appearing fixed. In each of `.github/workflows/docs-review.yml`, `.github/workflows/constants-review.yml`, and `.github/workflows/stdlib-docs-links.yml`, change:

```yaml
      - uses: egonSchiele/run-agency-action@2a3030d846ce45a7c9d5eafad345e86db4f83a38  # v1.0.2
```

to:

```yaml
      - uses: egonSchiele/run-agency-action@4768784aa7611fafee0801e01cdaea9f06d08dfb  # v1.0.3
```

- [ ] **Step 5: Regenerate the snapshots**

```bash
rm lib/cli/schedule/backends/__snapshots__/*.yml
pnpm test:run lib/cli/schedule/backends/github.snapshot.test.ts 2>&1 | tee /tmp/snap.log
```

Expected: PASS, and `git diff` on the snapshot directory shows only the SHA and the `# v1.0.2` → `# v1.0.3` comment changing. Anything else means something unrelated moved — stop and investigate.

- [ ] **Step 6: Verify**

```bash
pnpm run typecheck 2>&1 | tee /tmp/tc.log
pnpm test:run lib/cli/schedule 2>&1 | tee /tmp/sched.log
grep -rn "2a3030d846ce45a7c9d5eafad345e86db4f83a38" . --include=*.ts --include=*.yml --include=makefile | grep -v node_modules
```

Expected: typecheck clean, schedule tests pass, and the `grep` returns **nothing** — no reference to the old SHA anywhere.

- [ ] **Step 7: Commit**

```bash
git add lib/cli/schedule/backends/pinnedActions.ts makefile \
  lib/cli/schedule/backends/__snapshots__ \
  ../../.github/workflows/docs-review.yml \
  ../../.github/workflows/constants-review.yml \
  ../../.github/workflows/stdlib-docs-links.yml
git commit -F - <<'EOF'
chore(schedule): bump egonSchiele/run-agency-action to v1.0.3

v1.0.2 failed in ~14s for every consumer, before running the agent at all:
setup-node was handed a cache-dependency-path outside $GITHUB_WORKSPACE, which
@actions/glob discards. All three scheduled jobs have failed on every run since
they were created.

Updates the generator pin (pinnedActions.ts + the matching makefile tag list)
and, separately, the three live workflow files. The documented procedure in
docs/dev/updating-pinned-actions.md covers only the generator, which affects
workflows generated in future — the existing three had to be re-pinned by hand
or the scheduled jobs would stay broken while looking fixed.
EOF
```

---

### Task 2: Pure helpers in branch.agency

Extract every decision this redesign introduces into pure functions first, so each one is testable without git or an LLM. `pushBranch` in Task 3 then just wires them to git commands.

**Files:**
- Create: `agents/scheduled/branch.agency` (initially the pure helpers only)
- Test: `tests/agency/scheduled-helpers.agency` (append)

**Interfaces:**
- Consumes: nothing.
- Produces, all exported from `agents/scheduled/branch.agency`:
  - `BOT_NAME: string` — the constant `"agency-scheduler[bot]"`
  - `compareUrl(repo: string, branch: string): string`
  - `isGithubPath(dir: string, filename: string): boolean`
  - `shouldForcePush(tipAuthor: string): boolean`
  - `truncationNote(processed: number, total: number, label: string): string`

- [ ] **Step 1: Write the failing tests**

Append to `tests/agency/scheduled-helpers.agency`, and add the import at the top of the file alongside the existing `stdlib-docs-links.agency` import:

```ts
import { compareUrl, isGithubPath, shouldForcePush, truncationNote } from "../../agents/scheduled/branch.agency"

node compareUrlBuilds() {
  const got = compareUrl("egonSchiele/agency-lang", "chore/docs-freshness")
  if (got == "https://github.com/egonSchiele/agency-lang/compare/chore/docs-freshness?expand=1") { return "ok" }
  return "bad:${got}"
}

node compareUrlEmptyRepo() {
  // GITHUB_REPOSITORY is unset outside Actions; callers must get "" not a broken URL.
  const got = compareUrl("", "chore/docs-freshness")
  if (got == "") { return "ok" }
  return "bad:${got}"
}

node githubPathDirect() {
  const got = isGithubPath(".github/workflows", "ci.yml")
  if (got) { return "ok" }
  return "bad:false"
}

node githubPathTraversal() {
  // The whole reason this is a substring test: traversal must not slip past.
  const got = isGithubPath("packages/agency-lang/docs/dev", "../../../../.github/workflows/ci.yml")
  if (got) { return "ok" }
  return "bad:false"
}

node githubPathAllowsDocs() {
  const got = isGithubPath("packages/agency-lang/docs/dev", "interrupts.md")
  if (!got) { return "ok" }
  return "bad:true"
}

node forcePushWhenBotTip() {
  const got = shouldForcePush("agency-scheduler[bot]")
  if (got) { return "ok" }
  return "bad:false"
}

node forcePushWhenNoRemoteBranch() {
  // "" means the branch does not exist on the remote yet.
  const got = shouldForcePush("")
  if (got) { return "ok" }
  return "bad:false"
}

node noForcePushOverHuman() {
  const got = shouldForcePush("Aditya Bhargava")
  if (!got) { return "ok" }
  return "bad:true"
}

node truncationNoteWhenShort() {
  const got = truncationNote(41, 60, "docs")
  if (got.includes("41 of 60 docs")) { return "ok" }
  return "bad:${got}"
}

node truncationNoteWhenComplete() {
  const got = truncationNote(60, 60, "docs")
  if (got == "") { return "ok" }
  return "bad:${got}"
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm run agency test tests/agency/scheduled-helpers.agency 2>&1 | tee /tmp/helpers.log
```

Expected: FAIL — `branch.agency` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `agents/scheduled/branch.agency`:

```ts
/** @module
  Shared helpers for the scheduled maintenance agents in this directory.

  These agents run non-interactively on GitHub Actions (see the generated
  `.github/workflows/*.yml`), so every effectful call is discharged with
  `with approve`. Safety comes from the workflow, not from in-agent prompting:
  a least-privilege `GITHUB_TOKEN` (`contents: write` only — these agents do
  not open pull requests), triggers that take no attacker-controlled input
  (`schedule` + `workflow_dispatch` only), and the fact that every change lands
  on a branch a human reviews before merging.

  Failures are loud on purpose. `run()` aborts the whole process with a
  non-zero exit code the moment any shell command fails, so a broken run shows
  up as a red workflow instead of a green one that quietly did nothing.

  On force-pushing: `CLAUDE.md` says never to force push. That rule protects
  shared history. Each agent owns one branch whose entire content it
  regenerates every run, and `pushBranch` refuses to push when the remote tip
  is not the bot's own commit — so a force-push can overwrite the agent's
  previous output but never a human's work.
*/

export const BOT_NAME = "agency-scheduler[bot]"

/** The "open a PR from this branch" link a human clicks after a run. */
export def compareUrl(repo: string, branch: string): string {
  """
  Build the GitHub compare URL for a pushed branch. Returns "" when repo is empty.

  @param repo - owner/name, as GitHub Actions sets GITHUB_REPOSITORY
  @param branch - the branch that was pushed
  """
  if (repo == "") { return "" }
  return "https://github.com/${repo}/compare/${branch}?expand=1"
}

/** True when an edit target lies under `.github/`, including via `../`. */
export def isGithubPath(dir: string, filename: string): boolean {
  """
  Report whether a std::edit target lands under .github/.

  A substring test rather than a path resolution: the `.github/` segment is
  present whether the model writes the path directly or reaches it by
  traversal, so no joining or `..` collapsing is needed. It can only
  over-reject, which fails closed.

  @param dir - The std::edit payload's dir
  @param filename - The std::edit payload's filename
  """
  const target = "${dir}/${filename}"
  return target.includes(".github/")
}

/** True when force-pushing the agent's branch cannot destroy human work. */
export def shouldForcePush(tipAuthor: string): boolean {
  """
  Decide whether to force-push, given the author of the remote branch tip.

  "" means the branch does not exist remotely yet. Any author other than the
  bot means a human has pushed to it, so the run must leave it alone.

  @param tipAuthor - Author name of the remote branch's tip commit, or ""
  """
  return tipAuthor == "" || tipAuthor == BOT_NAME
}

/** A report banner naming how much of the work a tripped budget cut short. */
export def truncationNote(processed: number, total: number, label: string): string {
  """
  Build a warning banner when a run processed fewer items than it found. Returns "" for a complete run.

  Without this, a run cut short by its budget produces a short report that is
  indistinguishable from a clean bill of health.

  @param processed - How many items the run actually got through
  @param total - How many items it found to do
  @param label - Plural noun for the items, e.g. "docs"
  """
  if (processed >= total) { return "" }
  return "> **Truncated:** reviewed ${processed} of ${total} ${label} before the budget tripped. The rest were not examined.\n"
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm run agency test tests/agency/scheduled-helpers.agency 2>&1 | tee /tmp/helpers.log
```

Expected: PASS, all nodes return `ok`.

- [ ] **Step 5: Commit**

```bash
git add agents/scheduled/branch.agency tests/agency/scheduled-helpers.agency
git commit -F - <<'EOF'
feat(scheduled): pure helpers for branch-based agent output

Four decisions this redesign introduces, extracted as pure functions so each
is testable without git or an LLM:

- compareUrl: the "open a PR from this branch" link, replacing the PR URL
- isGithubPath: substring test for .github/, which catches traversal spellings
  without path resolution and can only over-reject
- shouldForcePush: force-push only over the bot's own tip, never over a human's
- truncationNote: a banner so a budget-truncated run cannot read as clean

Task 3 wires these to git.
EOF
```

---

### Task 3: pushBranch replaces openPr

**Files:**
- Modify: `agents/scheduled/branch.agency` (append)
- Delete: `agents/scheduled/pr.agency` (after callers move in Tasks 4-6)

**Interfaces:**
- Consumes: `BOT_NAME`, `compareUrl`, `shouldForcePush` from Task 2.
- Produces:
  - `run(command: string, args: string[], cwd: string)` — moved verbatim from `pr.agency`
  - `repoRoot(): string`, `pkgDir(): string`, `stamp(): string`, `ensureDir(dir: string)` — moved verbatim from `pr.agency`
  - `remoteTipAuthor(root: string, branch: string): string`
  - `pushBranch(root: string, branch: string, paths: string[], commitMsg: string): string` — returns the compare URL, or `""` when nothing was committed or the push was skipped

- [ ] **Step 1: Move the unchanged helpers**

Copy `run`, `repoRoot`, `pkgDir`, `stamp`, and `ensureDir` from `agents/scheduled/pr.agency` into `agents/scheduled/branch.agency` **verbatim**, including their doc comments, along with the imports they need at the top of the file:

```ts
import { exec } from "std::shell"
import { mkdir } from "std::fs"
import { exit } from "std::system"
```

`openPrExists` is NOT moved — it is deleted. It existed to skip a run while last week's pull request was open; with one fixed branch there is nothing to check.

- [ ] **Step 2: Add remoteTipAuthor and pushBranch**

Append to `agents/scheduled/branch.agency`:

```ts
/**
  Author of the remote branch's tip commit, or "" when the branch does not
  exist remotely. A failed fetch means "no such branch", which is the normal
  first-run case — so it must NOT go through `run()`, which aborts on failure.
*/
export def remoteTipAuthor(root: string, branch: string): string {
  """
  Return the author name of a remote branch's tip commit, or "" if the branch does not exist.

  @param root - Absolute path to the repo root
  @param branch - Branch name on origin
  """
  const fetched = exec("git", ["-C", root, "fetch", "origin", branch], cwd: "") with approve
  if (fetched.exitCode != 0) {
    return ""
  }
  const author = exec("git", ["-C", root, "log", "-1", "--format=%an", "FETCH_HEAD"], cwd: "") with approve
  if (author.exitCode != 0) {
    return ""
  }
  return author.stdout.trim()
}

/**
  Commit the given files onto the agent's fixed branch and force-push it.
  Returns the compare URL a human clicks to open a PR, or "" when there was
  nothing to commit or the push was skipped to protect human commits.

  Only the files in `paths` are staged (never `git add -A`) so a stray build
  artifact the runner produced cannot leak into the branch.
*/
export def pushBranch(
  root: string,
  branch: string,
  paths: string[],
  commitMsg: string,
): string {
  """
  Commit specific files onto a fixed branch and force-push; returns the compare URL, or "" if nothing changed or the push was skipped.

  @param root - Absolute path to the repo root
  @param branch - The agent's fixed branch name
  @param paths - Repo-root-relative paths to stage and commit
  @param commitMsg - Commit message
  """
  const tipAuthor = remoteTipAuthor(root, branch)
  if (!shouldForcePush(tipAuthor)) {
    print("Branch ${branch} has commits by ${tipAuthor}; refusing to force-push over them. Merge or delete it to re-arm this agent.")
    return ""
  }

  run("git", ["-C", root, "config", "user.name", BOT_NAME], "")
  run("git", ["-C", root, "config", "user.email", "agency-scheduler@users.noreply.github.com"], "")
  // -B, not -b: the branch is fixed, so it may already exist locally.
  run("git", ["-C", root, "checkout", "-B", branch], "")

  const addArgs = ["-C", root, "add"]
  for (path in paths) {
    addArgs.push(path)
  }
  run("git", addArgs, "")

  // `git diff --cached --quiet` exits 0 when the index is empty and 1 when
  // there are staged changes. A non-zero exit here is EXPECTED, not a failure,
  // so it must NOT go through run(). An empty index means the generated output
  // already matches main — skip cleanly rather than pushing an empty commit.
  const staged = exec("git", ["-C", root, "diff", "--cached", "--quiet"], cwd: "") with approve
  if (staged.exitCode == 0) {
    print("No changes to commit; nothing to push.")
    return ""
  }

  run("git", ["-C", root, "commit", "-m", commitMsg], "")
  run("git", ["-C", root, "push", "--force", "origin", branch], "")

  const repo = env("GITHUB_REPOSITORY")
  if (repo == null) {
    return ""
  }
  return compareUrl(repo, branch)
}
```

Add `env` to the `std::system` import at the top of the file:

```ts
import { exit, env } from "std::system"
```

- [ ] **Step 3: Verify it parses**

```bash
pnpm run ast agents/scheduled/branch.agency > /tmp/branch-ast.json 2>&1
echo "exit=$?"
```

Expected: exit 0. On a parse error, check the syntax rules in `docs/site/guide/basic-syntax.md`.

- [ ] **Step 4: Re-run the helper tests**

```bash
pnpm run agency test tests/agency/scheduled-helpers.agency 2>&1 | tee /tmp/helpers.log
```

Expected: PASS — the pure helpers still behave the same with the git code alongside them.

- [ ] **Step 5: Commit**

```bash
git add agents/scheduled/branch.agency
git commit -F - <<'EOF'
feat(scheduled): pushBranch replaces openPr

Same git sequence minus `gh pr create`, so the agents need only
`contents: write` and the repository setting "Allow GitHub Actions to create
and approve pull requests" can stay off.

Each agent now owns one fixed branch, force-pushed. `remoteTipAuthor` +
`shouldForcePush` make that safe: a run overwrites its own previous output
freely, but skips the push when a human has added commits. `checkout -B`
rather than `-b` because a fixed branch may already exist locally.

Returns the compare URL instead of a PR URL — the one-click "open the PR" for
a human, and the seam where email notification will hook in later.

openPrExists is deleted: it skipped a run while last week's PR was open, and
there is no such thing to check now.
EOF
```

---

### Task 4: docs-review applies fixes, under a guard

The only agent that loops, so the only one where a partial run and its progress counter mean anything.

**Files:**
- Modify: `agents/scheduled/docs-review.agency`

**Interfaces:**
- Consumes: `pkgDir`, `repoRoot`, `stamp`, `ensureDir`, `pushBranch`, `isGithubPath`, `truncationNote` from `branch.agency`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Update the imports and module doc**

Replace the import line:

```ts
import { pkgDir, repoRoot, stamp, pushBranch, ensureDir, isGithubPath, truncationNote } from "./branch.agency"
```

Add `edit` to the `std::fs` imports. In the `@module` block, replace the two sentences describing report-only behavior and read-only tools with:

```
  It reviews each developer doc under `docs/dev/` against the current codebase,
  FIXES what it finds, and pushes a branch containing both the edits and a
  report explaining them. Each doc is reviewed in its own fresh thread so the
  reviews stay independent and the context stays small.

  Security posture: runs non-interactively on GitHub Actions with a least-
  privilege `GITHUB_TOKEN` (`contents: write` only). The model gets `read`,
  `grep`, and `edit` — but never `exec`. File edits land in the diff a human
  reviews before merging; shell commands would not, and the runner's token
  sits in its environment. A handler additionally rejects any edit under
  `.github/`, because opening a pull request runs that branch's workflows with
  repository secrets before the review finishes — the one edit that acts
  before the review gate closes. See `branch.agency`.
```

- [ ] **Step 2: Replace the skip guard with the budget guard**

Delete these lines:

```ts
  const branchPrefix = "chore/docs-freshness-"
  if (openPrExists(root, branchPrefix)) {
    print("An open docs-freshness PR already exists; skipping this run.")
    return
  }
```

Replace with:

```ts
  const branch = "chore/docs-freshness"
```

- [ ] **Step 3: Change the rubric to ask for fixes**

Replace the final sentence of `rubric` — the one starting "If the doc appears accurate and current" — with:

```
If the doc appears accurate and current, reply with exactly the text NO ISSUES and nothing else. Otherwise use the edit tool to FIX each stale claim in the doc, then reply with a short markdown bullet list describing what you changed and why; each bullet names the stale claim, the correction, and the code you verified it against (cite file:line). Keep each edit's oldText as small as possible while still matching uniquely. Do not rewrite prose you were not asked to fix.
```

- [ ] **Step 4: Wrap the loop in a guard with a progress counter**

Replace the review loop with:

```ts
  let sections: string[] = []
  let processed = 0
  const budget = guard(label: "docs-review", cost: $3.00, time: 25m) {
    let idx = 0
    for (rel in files) {
      const readResult = read(rel, devDir) with approve
      let content = ""
      if (readResult is success(text)) {
        content = text
      } else {
        print("Failed to read ${rel}. Aborting.")
        exit(1) with approve
      }

      const prompt = """${rubric}

Doc path (relative to packages/agency-lang): docs/dev/${rel}
Search code with grep/read using paths relative to the repository root.

Doc contents:
${content}"""
      let finding = ""
      thread(session: "docrev-${idx}") {
        finding = llm(prompt, tools: [read, grep, edit]) with approve
      }
      // The rubric asks for EXACTLY `NO ISSUES`; an exact match (not a
      // substring check) means a reply that merely mentions the phrase
      // alongside real findings is still treated as a finding.
      if (finding.trim() != "NO ISSUES") {
        sections.push("## docs/dev/${rel}\n\n${finding}")
      }
      processed += 1
      idx += 1
      // `processed` is a separate counter, NOT sections.length: sections only
      // grows when a doc HAS a problem, so a run that reviewed 40 docs and
      // found 3 issues would otherwise report "3 of 60".
      saveDraft({ processed: processed, sections: sections })
    }
    return { processed: processed, sections: sections }
  }

  if (budget is success(result)) {
    processed = result.processed
    sections = result.sections
  }
```

- [ ] **Step 5: Add the .github/ handler**

Wrap the `node main()` body so the whole run is covered. The handler goes at the end of the node:

```ts
} with (i) {
  if (i.effect == "std::edit") {
    if (isGithubPath(i.data.dir, i.data.filename)) {
      print("Rejected edit under .github/: ${i.data.dir}/${i.data.filename}")
      return reject()
    }
    return approve()
  }
  return pass()
}
```

- [ ] **Step 6: Add the truncation banner and push the branch**

Replace the report construction and `openPr` call with:

```ts
  const joined = sections.join("\n\n")
  const banner = truncationNote(processed, files.length, "docs")
  const report = """# docs/dev freshness review

Automated weekly audit of `docs/dev/` against the current codebase, run at ${stamp()} UTC. The edits on this branch have ALREADY been applied; each item below explains one of them.

${banner}
${joined}
"""

  const reportDir = "${devDir}/_reports"
  ensureDir(reportDir)
  const writeResult = write("docs-freshness.md", report, dir: reportDir) with approve
  if (writeResult is failure(err)) {
    print("Failed to write the report: ${err}. Aborting.")
    exit(1) with approve
  }

  const url = pushBranch(
    root,
    branch,
    ["packages/agency-lang/docs/dev"],
    "chore(docs): weekly docs/dev freshness fixes",
  )
  if (url == "") {
    print("No changes to push.")
  } else {
    print("Pushed ${branch}. Open a PR: ${url}")
  }
```

Note the staged path is now the whole `docs/dev` directory, not just the report file — the agent edits docs in place, so those edits must be staged too. It is still a narrow path, never `git add -A`.

- [ ] **Step 7: Verify it parses**

```bash
pnpm run ast agents/scheduled/docs-review.agency > /tmp/docs-review-ast.json 2>&1
echo "exit=$?"
```

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add agents/scheduled/docs-review.agency
git commit -F - <<'EOF'
feat(docs-review): fix the docs instead of describing the problem

The model gets the `edit` tool alongside `read` and `grep`, and the rubric now
asks it to fix each stale claim rather than list it. The report becomes a
record of what changed and why, committed beside the edits.

Withholding write tools guarded against a prompt injection in a doc — but
these agents read only files already on main, so injecting requires commit
access, and anyone with that can do the damage directly. `std::fs.edit` is
already atomic and fail-closed on an ambiguous match, so nothing hand-rolled
is needed. `exec` is still withheld: file edits land in the reviewed diff,
shell commands would not.

A handler rejects any edit under `.github/`, the one path whose contents run
before the review gate closes.

Budgeted at $3.00 / 25m against the workflow's 30m timeout, with five minutes
of headroom so the guard fires before the runner kills the job. saveDraft
carries an explicit `processed` counter so a truncated run still pushes its
partial work AND says how much it skipped.
EOF
```

---

### Task 5: constants-review applies fixes, under a guard

Same shape as Task 4 minus the loop: this agent makes a single LLM call, so there is no partial progress to count and no `saveDraft`. A tripped guard here means the run produced nothing, which is correct.

**Files:**
- Modify: `agents/scheduled/constants-review.agency`

**Interfaces:**
- Consumes: `pkgDir`, `repoRoot`, `stamp`, `ensureDir`, `pushBranch`, `isGithubPath` from `branch.agency`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Update imports, module doc, and branch name**

```ts
import { pkgDir, repoRoot, stamp, pushBranch, ensureDir, isGithubPath } from "./branch.agency"
```

Add `edit` to the `std::fs` imports. In the `@module` block, replace "It opens a PR containing a findings report; it does NOT move any constants itself — a human decides." with:

```
  It moves the constants it finds and pushes a branch containing both the
  changes and a report explaining them.
```

and replace the whole "Security posture:" paragraph with:

```
  Security posture: runs non-interactively on GitHub Actions with a least-
  privilege `GITHUB_TOKEN` (`contents: write` only). The model gets `read`,
  `grep`, and `edit` — but never `exec`. File edits land in the diff a human
  reviews before merging; shell commands would not, and the runner's token
  sits in its environment. A handler additionally rejects any edit under
  `.github/`, because opening a pull request runs that branch's workflows with
  repository secrets before the review finishes — the one edit that acts
  before the review gate closes. Because this agent changes code rather than
  prose, CI also runs on the branch and catches a bad move before the pull
  request is opened. See `branch.agency`.
```

Delete the skip guard:

```ts
  const branchPrefix = "chore/constants-review-"
  if (openPrExists(root, branchPrefix)) {
    print("An open constants-review PR already exists; skipping this run.")
    return
  }
```

Replace with:

```ts
  const branch = "chore/constants-review"
```

- [ ] **Step 2: Change the rubric to ask for the move**

Replace the rubric's final sentence — "For each candidate report a markdown bullet… reply with exactly the text NO ISSUES and nothing else." — with:

```
For each candidate: use the edit tool to add the constant to lib/constants.ts and update every call site to import it from there, then report a markdown bullet giving the literal value, every file:line you changed, and a one-line reason it belongs there. Keep each edit's oldText as small as possible while still matching uniquely. If you find nothing worth moving, change nothing and reply with exactly the text NO ISSUES and nothing else.
```

- [ ] **Step 3: Wrap the single LLM call in a guard**

Replace:

```ts
  let finding = ""
  thread(session: "constants-review") {
    finding = llm(prompt, tools: [read, grep]) with approve
  }
```

with:

```ts
  // One LLM call, so there is no partial progress to save: a tripped budget
  // means this run produced nothing, and the next weekly run starts fresh.
  let finding = ""
  const budget = guard(label: "constants-review", cost: $3.00, time: 25m) {
    let inner = ""
    thread(session: "constants-review") {
      inner = llm(prompt, tools: [read, grep, edit]) with approve
    }
    return inner
  }
  if (budget is success(text)) {
    finding = text
  } else {
    print("Budget tripped before the review finished; nothing to push.")
    return
  }
```

- [ ] **Step 4: Add the same .github/ handler**

Add to the end of `node main()`:

```ts
} with (i) {
  if (i.effect == "std::edit") {
    if (isGithubPath(i.data.dir, i.data.filename)) {
      print("Rejected edit under .github/: ${i.data.dir}/${i.data.filename}")
      return reject()
    }
    return approve()
  }
  return pass()
}
```

- [ ] **Step 5: Update the report and push the branch**

Change the report's second line to:

```
Automated weekly scan for 'magic' literals that belong in `lib/constants.ts`, run at ${stamp()} UTC. The changes on this branch have ALREADY been applied; each item below explains one of them. CI runs on this branch — check it before merging.
```

Replace the `openPr` call with:

```ts
  const url = pushBranch(
    root,
    branch,
    ["packages/agency-lang/lib", "packages/agency-lang/docs/dev/_reports"],
    "chore: centralize magic constants into lib/constants.ts",
  )
  if (url == "") {
    print("No changes to push.")
  } else {
    print("Pushed ${branch}. Open a PR: ${url}")
  }
```

- [ ] **Step 6: Verify it parses**

```bash
pnpm run ast agents/scheduled/constants-review.agency > /tmp/constants-ast.json 2>&1
echo "exit=$?"
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add agents/scheduled/constants-review.agency
git commit -F - <<'EOF'
feat(constants-review): move the constants instead of listing them

Same change as docs-review: the model gets `edit`, the rubric asks it to make
the move, and the report explains changes already applied.

No saveDraft here — this agent makes one LLM call, so there is no partial
progress to keep. A tripped budget means the run produced nothing and the next
weekly run starts fresh, which is the correct behavior.

This agent produces code changes rather than prose, so CI runs on the branch
and catches a bad move before the PR is even opened. The report says so.
EOF
```

---

### Task 6: stdlib-docs-links pushes a branch, under a guard

Already applies its own fix behind a deterministic guard and gives the model no tools. Only the branch model and the budget change.

**Files:**
- Modify: `agents/scheduled/stdlib-docs-links.agency`

**Interfaces:**
- Consumes: `pkgDir`, `repoRoot`, `stamp`, `pushBranch` from `branch.agency`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Update the import and branch name**

```ts
import { pkgDir, repoRoot, stamp, pushBranch } from "./branch.agency"
```

Delete the skip guard at lines 137-142:

```ts
  const branchPrefix = "chore/stdlib-doc-links-"
  if (openPrExists(root, branchPrefix)) {
    print("An open stdlib-doc-links PR already exists; skipping this run.")
    return
  }
```

Replace with:

```ts
  const branch = "chore/stdlib-doc-links"
```

Delete the later `const branch = "${branchPrefix}${stamp()}"` line, since `branch` is now defined above.

- [ ] **Step 2: Wrap the LLM call in a guard**

This agent gives the model no tools and makes one call, with no `thread()` wrapper. Replace this exact line:

```ts
  const raw: string = llm(prompt)
```

with:

```ts
  const budget = guard(label: "stdlib-docs-links", cost: $0.50, time: 25m) {
    const inner: string = llm(prompt)
    return inner
  }
  let raw = ""
  if (budget is success(text)) {
    raw = text
  } else {
    print("Budget tripped before the rewrite finished; nothing to push.")
    return
  }
```

Keep the `: string` annotation on the inner binding — the LLM's output type comes from the left-hand side annotation, so dropping it changes what the call returns.

The very next line, `const newConfig = stripFences(raw)`, is unchanged, and so is the entire fail-closed link check below it. Do NOT touch that check — the four conditions it enforces (structure preserved, no link dropped, every requested link added, no unexpected link introduced) are what make this agent safe to auto-apply.

No handler is needed: the model gets no tools here, so there is no `std::edit` interrupt to intercept.

- [ ] **Step 3: Replace openPr with pushBranch**

```ts
  const url = pushBranch(root, branch, paths, commitMsg)
  if (url == "") {
    print("No changes to push.")
  } else {
    print("Pushed ${branch}. Open a PR: ${url}")
  }
```

Delete the now-unused `title` and `body` variables that were only passed to `openPr`.

- [ ] **Step 4: Verify it parses and the helper tests still pass**

```bash
pnpm run ast agents/scheduled/stdlib-docs-links.agency > /tmp/links-ast.json 2>&1
echo "exit=$?"
pnpm run agency test tests/agency/scheduled-helpers.agency 2>&1 | tee /tmp/helpers.log
```

Expected: exit 0, and the helper tests still PASS — `tests/agency/scheduled-helpers.agency` imports `stripFences` and `extractLinks` from this file, so a careless edit there breaks them.

- [ ] **Step 5: Commit**

```bash
git add agents/scheduled/stdlib-docs-links.agency
git commit -F - <<'EOF'
feat(stdlib-docs-links): push a branch, under a $0.50 budget

This agent already applied its own fix behind a deterministic fail-closed link
check, so only the output shape and the budget change. The link check is
untouched — it is what makes auto-applying safe here.

No .github/ handler: the model gets no tools, so there is no std::edit
interrupt to intercept.
EOF
```

---

### Task 7: Drop pull-requests: write, delete pr.agency, update docs

**Files:**
- Modify: `.github/workflows/docs-review.yml:9-11`
- Modify: `.github/workflows/constants-review.yml:9-11`
- Modify: `.github/workflows/stdlib-docs-links.yml:9-11`
- Delete: `agents/scheduled/pr.agency`
- Modify: `docs/dev/updating-pinned-actions.md`

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: nothing.

- [ ] **Step 1: Narrow the workflow permissions**

In all three workflow files, replace:

```yaml
permissions:
  contents: write
  pull-requests: write
```

with:

```yaml
permissions:
  contents: write
```

- [ ] **Step 2: Confirm nothing still imports pr.agency, then delete it**

```bash
grep -rn "pr.agency\|openPr" agents/ tests/ --include=*.agency
```

Expected: **no output**. If anything matches, that file was missed in Tasks 4-6 — fix it before deleting.

```bash
git rm agents/scheduled/pr.agency
```

- [ ] **Step 3: Record the live-workflow step in the pin-bump docs**

The procedure in `docs/dev/updating-pinned-actions.md` covers only the generator. Following it exactly leaves the scheduled jobs on the old SHA. Add a step 5.5 after "Regenerate the snapshots":

```markdown
### 5.5. Re-pin the live workflow files

`pinnedActions.ts` controls workflows generated in *future*. The workflows that
actually run on a schedule already exist and hold their own copy of the SHA:

```bash
grep -rln "run-agency-action@" ../../.github/workflows/
```

Update the `uses:` line and its trailing `# vX.Y.Z` comment in each. Skipping
this leaves the scheduled jobs on the old version while every other file says
they were upgraded.
```

- [ ] **Step 4: Verify the whole set parses and tests pass**

```bash
for f in agents/scheduled/*.agency; do
  pnpm run ast "$f" > /dev/null 2>&1 || echo "PARSE FAIL: $f"
done
pnpm run agency test tests/agency/scheduled-helpers.agency 2>&1 | tee /tmp/helpers.log
grep -rn "pull-requests: write" ../../.github/workflows/docs-review.yml ../../.github/workflows/constants-review.yml ../../.github/workflows/stdlib-docs-links.yml
```

Expected: no parse failures, tests PASS, and the last `grep` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add -u agents/scheduled ../../.github/workflows docs/dev/updating-pinned-actions.md
git commit -F - <<'EOF'
chore(scheduled): drop pull-requests: write, delete pr.agency

No agent opens a pull request now, so the three workflows need only
`contents: write`. This is the security motivation for the whole change
showing up in the permission block: the repository setting "Allow GitHub
Actions to create and approve pull requests" can stay off.

pr.agency is deleted; branch.agency replaced it.

Also records the step the pin-bump procedure was missing: the live workflow
files carry their own copy of the action SHA, and updating only the generator
leaves the scheduled jobs on the old version while appearing to upgrade them.
EOF
```

---

### Task 8: Verify end to end with workflow_dispatch

Nothing before this proves the agents actually run on a runner. All three workflows already have `workflow_dispatch`.

**Files:** none — this task is verification only.

- [ ] **Step 1: Open the PR and let CI run**

Write the body to a file first — apostrophes on the command line will break it:

```bash
cat > /tmp/pr-body.md <<'EOF'
Implements docs/superpowers/specs/2026-08-13-scheduled-agents-branch-output-design.md.

The three scheduled agents now push a branch instead of opening a pull request,
apply their fixes instead of only reporting them, and run inside a cost and time
budget. Also bumps run-agency-action to v1.0.3, without which none of them run
at all.

The two controls worth reviewing closely are `isGithubPath` (rejects edits under
.github/, the one path that executes before the review gate closes) and
`shouldForcePush` (refuses to force-push over a human's commits). Both are pure
functions with direct tests in tests/agency/scheduled-helpers.agency.
EOF

git push -u origin scheduled-agents-branch-output
gh pr create --base main \
  --title "Scheduled agents: push a branch, do the work, stay in budget" \
  --body-file /tmp/pr-body.md
gh pr checks --watch
```

Expected: all checks pass.

- [ ] **Step 2: After merge, trigger the cheapest agent first**

```bash
gh workflow run stdlib-docs-links.yml
gh run watch
```

Expected: the job succeeds. Either it reports nothing to do, or it pushes `chore/stdlib-doc-links` and prints a compare URL.

- [ ] **Step 3: Confirm the branch and its permissions**

```bash
git fetch origin
git log --oneline origin/chore/stdlib-doc-links -1   # author should be agency-scheduler[bot]
```

If no branch was pushed, the run found nothing to do — that is a valid result, not a failure.

- [ ] **Step 4: Trigger the two expensive agents**

```bash
gh workflow run docs-review.yml
gh run watch
gh workflow run constants-review.yml
gh run watch
```

Expected: each succeeds and either reports nothing to do or pushes its branch. Review the resulting diffs, and check the report header for a truncation banner — if `docs-review` reports being cut short, the $3.00 budget needs raising, or coverage needs to rotate between runs (both noted as follow-ups in the spec).

- [ ] **Step 5: Confirm the force-push safeguard**

```bash
git checkout chore/docs-freshness
git commit --allow-empty -m "human edit"
git push
gh workflow run docs-review.yml
gh run watch
```

Expected: the run succeeds and prints "Branch chore/docs-freshness has commits by …; refusing to force-push over them." The branch keeps the human commit. Delete the branch afterward to re-arm the agent.

---

## Notes for the implementer

**Notification is deliberately absent.** The repository owner is adding email separately. `pushBranch` returns the compare URL and every agent prints it — that is the seam. Do not build a notification mechanism.

**Do not run the full test suite locally.** It is slow and expensive. Run the specific Agency test named in each task and let CI do the rest.

**Two things in this plan are the actual safety controls.** The `.github/` check in `isGithubPath` is what stands between a bad edit and code that runs before a human finishes reviewing. `shouldForcePush` is what stands between a scheduled run and someone's unpushed work. Both are pure functions with direct tests in Task 2 — if you change either, the tests must change with intent, not to make them pass.

**One thing the tests do not cover, deliberately.** The spec asks that a truncated run report *files reviewed*, not *findings*. `truncationNote` is unit-tested, but the correctness of `processed` itself is structural: it is incremented once per loop iteration, outside the `if` that appends to `sections`. Testing that would mean running the agent's loop, which needs LLM calls. If you restructure that loop, re-read the comment above `saveDraft` in Task 4 — moving `processed += 1` inside the `if` would silently reintroduce exactly the bug the counter exists to prevent, and nothing would fail.
