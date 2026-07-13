# Fix `review()` Crash and Unblock `verify` — Implementation Plan (Sub-project C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the code agent's `review()` step from crashing on non-Agency replies and unblock the shadowed `verify` step, by reviewing the `.agency` files the agent actually changed (found via `std::git`) instead of extracting snippets from the chat reply.

**Architecture:** Replace the code agent's auto-review of the chat message with an auto-review of the changed `.agency` files on disk. For a Python/C/shell task no `.agency` files change, so review is a no-op, `feedbackHasErrors` is false, and the loop falls through to `verify` — which is exactly the fix. The `--agent review` specialist keeps its snippet-based `review(userMsg)`.

**Tech Stack:** Agency stdlib (`std::git` `gitStatus`, `std::agency` `review`, `std::index` `read`), the `agency test` harness. Builds on the `std::agents` PR (#534) where `verify` was lifted to `std::agency` and the agent's `verify.agency` delegates; the loop change here is independent of that but assumes it is present.

## Global Constraints

- **Do not change `reviewAgent` / `review(userMsg)`** — the `--agent review` specialist legitimately reviews snippets a user pastes. Add a new entry point for the code agent's auto-check instead.
- **Reviewing files, not chat text.** The code agent's auto-review must only ever see `.agency` file contents, never the model's prose reply.
- **Fail safe on non-git dirs.** If the working directory is not a git repo (or `gitStatus` fails), the auto-review returns no findings (a no-op) so `verify` still runs. A `glob`+snapshot fallback is an optional enhancement, not required for v1.
- **Agency syntax:** `{ }` blocks, parens+braces on control flow, `for (x in xs)`, no lambdas (blocks/`\x -> ...`), prefer `match`. `try expr` yields a `Result`. Verify snippets with `pnpm run ast <file>`.
- **Build:** `make` after editing stdlib/agent `.agency` files. Save test output to a file; do NOT run the full agency suite locally.
- **Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-12-fix-review-crash-unblock-verify-design.md`.

## File Structure

- **Modify `packages/agency-lang/lib/agents/agency-agent/subagents/review.agency`** — add `filterAgencyPaths` (pure), `changedAgencyFiles` (git-driven), and `reviewWrittenFiles()` (the new code-agent entry point). Keep `review(userMsg)`, `reviewAgent`, and the `Feedback`/render/haserrors surface unchanged.
- **Modify `packages/agency-lang/lib/agents/agency-agent/subagents/code.agency`** — change the one call site from `review(reply)` to `reviewWrittenFiles()`.
- **Create `packages/agency-lang/tests/agency/agents/filterAgencyPaths.agency` + `.test.json`** — deterministic unit test of the pure path filter.
- **Create `packages/agency-lang/tests/integration/agents/review_crash.mjs`** (or extend the existing `tests/integration/agents/test.mjs`) — real-LLM regression: a Python task completes without phantom-error thrash and `verify` runs.

---

### Task 1: `filterAgencyPaths` — pure path filter (no git, no LLM)

**Files:**
- Modify: `lib/agents/agency-agent/subagents/review.agency`
- Test: `tests/agency/agents/filterAgencyPaths.agency` + `.test.json`

**Interfaces:**
- Produces: `def filterAgencyPaths(paths: string[]): string[]` — keeps only paths ending in `.agency`.

- [ ] **Step 1: Write the failing test** — `tests/agency/agents/filterAgencyPaths.agency`:

```ts
import { filterAgencyPaths } from "../../../lib/agents/agency-agent/subagents/review.agency"

node keepsOnlyAgency(): boolean {
  const got = filterAgencyPaths(["a.agency", "b.py", "sub/c.agency", "d.txt"])
  return got.length == 2 && got[0] == "a.agency" && got[1] == "sub/c.agency"
}

node emptyWhenNone(): boolean {
  return filterAgencyPaths(["x.py", "y.txt"]).length == 0
}
```

> Confirm the relative import path to `review.agency` resolves from `tests/agency/agents/` (adjust the `../` depth if the harness rejects it; alternatively export `filterAgencyPaths` and import via the module path the other agent tests use).

`.test.json` maps both nodes → `"true"` (exact).

- [ ] **Step 2: Run, expect failure** (`filterAgencyPaths` undefined):

Run: `cd packages/agency-lang && pnpm run a test tests/agency/agents/filterAgencyPaths.agency`
Expected: FAIL.

- [ ] **Step 3: Implement** — add to `review.agency` (import `filter` from `std::array`):

```ts
import { filter } from "std::array"

/** Keep only the .agency files from a list of paths. */
export def filterAgencyPaths(paths: string[]): string[] {
  return filter(paths, \p -> p =~ re/\.agency$/)
}
```

- [ ] **Step 4: Build + run** — `make && pnpm run a test tests/agency/agents/filterAgencyPaths.agency` → PASS.

- [ ] **Step 5: Commit** ("Add filterAgencyPaths helper").

---

### Task 2: `changedAgencyFiles` — the changed `.agency` files via `std::git`

**Files:**
- Modify: `lib/agents/agency-agent/subagents/review.agency`

**Interfaces:**
- Produces: `def changedAgencyFiles(): string[]` — the `.agency` files changed in the agent's working directory, or `[]` when the dir is not a git repo / git fails.

- [ ] **Step 1: Confirm the `GitStatus` shape.** `GitStatus` is imported into `stdlib/git.agency` from the runtime types. Find its changed-files field:

Run: `cd packages/agency-lang && pnpm run ast <(printf 'import { gitStatus } from "std::git"\nnode main() { const s = gitStatus(); return s }') 2>&1 | head` — or grep the generated `stdlib/git.d.mts` / runtime types for `GitStatus`. Record the exact field holding changed paths (e.g. `files: { path: string; status: string }[]`, or separate staged/unstaged lists).

- [ ] **Step 2: Implement** using the confirmed shape (illustrative — adjust field access to Step 1):

```ts
import { gitStatus } from "std::git"
import { map } from "std::array"

/** The .agency files changed in the agent working directory, or [] when the
  working dir is not a git repo (fail open so review is a no-op, never a crash). */
export def changedAgencyFiles(): string[] {
  const statusResult = try gitStatus()
  return match (statusResult) {
    failure(_) => []
    success(status) => filterAgencyPaths(map(status.files, \f -> f.path))
  }
}
```

> `gitStatus()` raises `std::git::status`, which the agent's policy approves. `try` converts a non-repo failure into a Result we fold to `[]`.

- [ ] **Step 3: Manual smoke** — in a temp git repo with one changed `foo.agency` and one `bar.py`, a scratch program calling `changedAgencyFiles()` prints `["foo.agency"]`; in a non-git dir it prints `[]`.

Run: build, then run the scratch program in each dir (approve interrupts with `with approve`).
Expected: correct lists, no crash in the non-git case.

- [ ] **Step 4: Commit** ("Add changedAgencyFiles via std::git").

---

### Task 3: `reviewWrittenFiles` — review the changed `.agency` files

**Files:**
- Modify: `lib/agents/agency-agent/subagents/review.agency`

**Interfaces:**
- Consumes: `changedAgencyFiles`, `agencyReview` (`std::agency::review`), `read` (prelude), `mergeFeedback`.
- Produces: `def reviewWrittenFiles(): Result<Feedback[]>` — reviews each changed `.agency` file's contents; `success([])` when none changed.

- [ ] **Step 1: Implement** in `review.agency`:

```ts
export def reviewWrittenFiles(): Result<Feedback[]> {
  let feedback: Result<Feedback[]> = success([])
  for (path in changedAgencyFiles()) {
    const source = read(filename: path, useAgentCwd: true)
    feedback = mergeFeedback(feedback, agencyReview(source))
  }
  return feedback
}
```

> `read` is the prelude file tool (raises `std::read`, approved by policy). `useAgentCwd: true` resolves `path` against the agent working dir, matching where `changedAgencyFiles` found it. No `thread`/LLM here — this is deterministic file review, unlike the old snippet-extraction `review(userMsg)`.

- [ ] **Step 2: ast-check + build** — `pnpm run ast lib/agents/agency-agent/subagents/review.agency` then `make`. Expected: parses, builds, no new typecheck errors (diff `make` output against a pre-change baseline).

- [ ] **Step 3: Commit** ("Add reviewWrittenFiles: review changed .agency files").

---

### Task 4: Switch the code agent to `reviewWrittenFiles()`

**Files:**
- Modify: `lib/agents/agency-agent/subagents/code.agency` (the one call site, ~line 480)

**Interfaces:**
- Consumes: `reviewWrittenFiles` (Task 3). The import line already pulls from `./review.agency`; add `reviewWrittenFiles` to it.

- [ ] **Step 1: Read** `code.agency` around the loop (~454-506) to confirm the single `review(reply)` call site and the import from `./review.agency`.

- [ ] **Step 2: Change the call site.** Add `reviewWrittenFiles` to the `./review.agency` import, then:

```ts
// was: const feedback = review(reply)
const feedback = reviewWrittenFiles()
```

Leave the surrounding `if (feedbackHasErrors(feedback)) { … } else { … verify … }` structure unchanged: for a non-Agency task `reviewWrittenFiles()` returns `success([])`, so `feedbackHasErrors` is false and the loop reaches `verify` — the unblock. For a real Agency task, genuine file errors are surfaced as before.

- [ ] **Step 3: Build** — `make`. Confirm `code.agency` compiles and `reply` is no longer consumed by review (it is still returned to the user; only the review input changed).

- [ ] **Step 4: Commit** ("Code agent reviews written .agency files, not the chat reply").

---

### Task 5: Regression tests (deterministic unit + real-LLM behavior)

**Files:**
- (Task 1 already added the deterministic `filterAgencyPaths` test.)
- Create/extend: `tests/integration/agents/test.mjs` with a `review-no-thrash` case.

- [ ] **Step 1: Real-LLM regression case.** In `tests/integration/agents/test.mjs`, add a case that runs the **code agent** (`agency agent --agent code --policy approve-all -p -- "<task>"`) on a Python output-contract task in a temp **git** repo (so `gitStatus` works), where the previous behavior thrashed. Assert: (a) the deliverable file is correct, and (b) the transcript shows **no** `"The last code had errors"` phantom re-prompts and that `verify` ran (grep the statelog / transcript). This is the regression guard for the whole bug.

- [ ] **Step 2: Run locally with a key** (NOT the full suite): `cd packages/agency-lang && make && node tests/integration/agents/test.mjs` (or the `--only` filter for this case). Save output to a file.
Expected: the case passes; transcript is thrash-free.

- [ ] **Step 3: Commit** ("Add review-crash regression test").

---

## Self-Review

**1. Spec coverage:** Review the `.agency` files not the chat reply ✓ (Tasks 2-4, via `std::git`). Decouple `verify` from `review` ✓ (Task 4 — the review swap alone unblocks the `else` branch; no loop restructure needed). Fail-open on non-git dirs ✓ (Task 2). Preserve `reviewAgent`/`review(userMsg)` ✓ (untouched). `std::git` as the detection mechanism ✓ (Task 2). The spec's optional `agencyReview` fail-safe softening is **not needed** and omitted: reviewing real `.agency` files means the parser only ever sees Agency source, so it cannot crash on non-Agency input; genuine `.agency` syntax errors should still surface. Noted here rather than silently dropped.

**2. Placeholder scan:** No TBD/TODO in requirements. The one confirm-at-implementation item (the exact `GitStatus` field) is an explicit first step of Task 2 with a command to resolve it, not a placeholder. Commit messages via a temp file (apostrophe convention).

**3. Type consistency:** `Result<Feedback[]>` from `reviewWrittenFiles` matches what `feedbackHasErrors`/`renderFeedback` in `code.agency` already consume. `filterAgencyPaths(string[]) -> string[]` and `changedAgencyFiles() -> string[]` compose in `reviewWrittenFiles`. `read(filename, useAgentCwd)` matches the prelude signature used elsewhere in the agent.

**Risks to verify during implementation:** (a) the exact `GitStatus` field (Task 2 Step 1); (b) the relative import path in the deterministic test (Task 1 Step 1 note); (c) `read` raising `std::read` inside `reviewWrittenFiles` is approved by the agent policy in one-shot (it is, under `approve-all`); (d) confirm `code.agency`'s existing import from `./review.agency` so adding `reviewWrittenFiles` doesn't hit the re-export TDZ noted in `review.agency`'s header comment.
