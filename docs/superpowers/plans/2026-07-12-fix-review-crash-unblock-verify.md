# Fix `review()` Crash and Unblock `verify` — Implementation Plan (Sub-project C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the code agent's `review()` step from crashing on non-Agency replies and unblock the shadowed `verify`, by reviewing the `.agency` files the agent changed **this turn** (git-dirty now minus a task-start baseline) instead of extracting snippets from the chat reply.

**Architecture:** Split into a **pure review core** (`reviewSources`, deterministic parse+typecheck, no LLM, no IO) and a thin **IO glue** (`currentDirtyAgencyFiles` via `std::git`, `readAll` via the file tool). For a Python/C/shell task the agent changes no `.agency` files, so review returns `success([])`, `feedbackHasErrors` is false, and the loop reaches `verify` — the unblock. Turn-scoping (baseline set-difference) prevents re-reviewing pre-existing dirty files, which would re-trigger the thrash. The pure/IO split makes the spec's deterministic tests real without any mocking construct (`provide{}` is not shipped).

**Tech Stack:** `std::git` (`gitStatus` → `GitStatus.entries: FileStatus[]`, each `.path`), `std::agency` (`review`, `mergeFeedback`), prelude `read`/`filter`/`map`, `std::statelog` for fail-open breadcrumbs, the `agency test` harness. Builds on the `std::agents` PR (#534): `verify` lifted to `std::agency`, `verify.agency` delegates. Implement **after #534 merges**, off updated `main`.

## Global Constraints

- **Do not change `reviewAgent` / `review(userMsg)`** — the `--agent review` specialist legitimately reviews pasted snippets. Add new functions for the code agent's auto-check.
- **Reviewing files, not chat text.** The code agent's auto-review only ever sees `.agency` file *contents*, never the model's prose reply.
- **Turn-scoped.** Review only `.agency` files that became dirty *during* the turn (`current git-dirty − task-start baseline`), never pre-existing dirty files.
- **Fail open with a breadcrumb.** Non-git dir / `gitStatus` failure → `[]`; unreadable/deleted path → skip. In every fail-open arm, emit a `std::statelog` debug event so a silently-disabled review is diagnosable.
- **`read` returns `Result`** — always `match`/unwrap; never `!`. `GitStatus` exposes `entries` (not `files`), each `FileStatus` has `.path`.
- **Agency syntax:** `{ }` blocks; parens+braces on control flow; `for (x in xs)`. **Lambdas via blocks are supported**: inline `\name -> expr` or trailing `f() as name { }`. Prefer `match` over nested `if`. `try expr` yields a `Result`; `expr catch default` unwraps with a default. `filter`/`map` are prelude — do NOT import them from `std::array`. Verify snippets with `pnpm run ast <file>`.
- **Build:** `make` after editing agent/stdlib `.agency`. Save test output to a file; do NOT run the full agency suite locally.
- **Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-12-fix-review-crash-unblock-verify-design.md`.

## File Structure

- **Modify `packages/agency-lang/lib/agents/agency-agent/subagents/review.agency`** — add `filterAgencyPaths`, `subtractBaseline` (pure), `reviewSources` (pure), `currentDirtyAgencyFiles` + `readAll` (IO), and `reviewWrittenFiles(baseline)`. Keep `review(userMsg)`, `reviewAgent`, and the `Feedback`/render/haserrors surface unchanged.
- **Modify `packages/agency-lang/lib/agents/agency-agent/subagents/code.agency`** — capture `baseline = currentDirtyAgencyFiles()` once at `codeAgent` entry; change the call site from `review(reply)` to `reviewWrittenFiles(baseline)`.
- **Create deterministic tests** under `packages/agency-lang/tests/agency/agents/`: `filterAgencyPaths`, `subtractBaseline`, `reviewSources` (the two spec cases + a valid case).
- **Extend `packages/agency-lang/tests/integration/agents/test.mjs`** — real-LLM regression, asserted on statelog events (not substring absence).

---

### Task 1: Pure helpers — `filterAgencyPaths` + `subtractBaseline`

**Files:** Modify `review.agency`; test `tests/agency/agents/pathHelpers.agency` + `.test.json`.

**Interfaces:** `def filterAgencyPaths(paths: string[]): string[]` (keeps `*.agency`); `def subtractBaseline(current: string[], baseline: string[]): string[]` (items in `current` not in `baseline`).

- [ ] **Step 1: Failing tests** — `tests/agency/agents/pathHelpers.agency`:

```ts
import { filterAgencyPaths, subtractBaseline } from "../../../lib/agents/agency-agent/subagents/review.agency"

node keepsOnlyAgency(): boolean {
  const got = filterAgencyPaths(["a.agency", "b.py", "sub/c.agency", "d.txt", "e.agency.txt"])
  return got.length == 2 && got[0] == "a.agency" && got[1] == "sub/c.agency"
}
node emptyInput(): boolean {
  return filterAgencyPaths([]).length == 0
}
node baselineRemovesPreexisting(): boolean {
  const got = subtractBaseline(["new.agency", "old.agency"], ["old.agency"])
  return got.length == 1 && got[0] == "new.agency"
}
```

> `e.agency.txt` must NOT match (ends in `.txt`). Confirm the `../../../` import depth resolves from `tests/agency/agents/` to `packages/agency-lang/`; adjust if the harness rejects it.

`.test.json` maps the three nodes → `"true"` (exact).

- [ ] **Step 2: Run, expect failure** — `cd packages/agency-lang && pnpm run a test tests/agency/agents/pathHelpers.agency` → FAIL.

- [ ] **Step 3: Implement** in `review.agency` (prelude `filter`/`map`; `endsWith`, not regex; descriptive params):

```ts
/** Keep only the .agency files from a list of paths. */
export def filterAgencyPaths(paths: string[]): string[] {
  return filter(paths, \path -> path.endsWith(".agency"))
}

/** Items in `current` that are not in `baseline` (turn-scoping). */
export def subtractBaseline(current: string[], baseline: string[]): string[] {
  return filter(current, \path -> !baseline.includes(path))
}
```

> Confirm `.endsWith` and `.includes` are available on Agency strings/arrays (used across stdlib, e.g. `stdlib/skills.agency`); if `includes` is not a method, use `filter(current, \path -> indexOf(baseline, path) == -1)` or an equivalent prelude helper.

- [ ] **Step 4: Build + run** — `make && pnpm run a test tests/agency/agents/pathHelpers.agency` → PASS.

- [ ] **Step 5: Commit** ("Add filterAgencyPaths and subtractBaseline helpers").

---

### Task 2: `reviewSources` — the pure, deterministic review core

**Files:** Modify `review.agency`; test `tests/agency/agents/reviewSources.agency` + `.test.json`.

**Interfaces:** `def reviewSources(sources: string[]): Result<Feedback[]>` — parse+typecheck each source via `agencyReview` (no `task`, so no LLM), folded with `mergeFeedback`. `success([])` for an empty list.

- [ ] **Step 1: Failing tests** (these are the two the spec asks for, plus a valid case; all deterministic — no LLM) — `tests/agency/agents/reviewSources.agency`:

```ts
import { reviewSources, feedbackHasErrors } from "../../../lib/agents/agency-agent/subagents/review.agency"

node emptyIsClean(): boolean {
  return !feedbackHasErrors(reviewSources([]))
}
node brokenSurfacesError(): boolean {
  return feedbackHasErrors(reviewSources(["node main() { for (let i = 0; i < 3; i = i + 1) { } }"]))
}
node validIsClean(): boolean {
  return !feedbackHasErrors(reviewSources(["node main(): number { return 5 }"]))
}
```

`.test.json` maps the three → `"true"`. **These are the PR-tier guard for the fix**: `emptyIsClean` proves the no-Agency path reaches `verify`; `brokenSurfacesError` proves the swap did not neuter review; `validIsClean` guards against false positives that would re-trigger thrash.

- [ ] **Step 2: Run, expect failure** → FAIL.

- [ ] **Step 3: Implement** in `review.agency` (fold matches the established `std::agency::review` idiom — keep it, do not "declarative-ify"):

```ts
/** Parse+typecheck each source (no LLM: `task` omitted) and merge the findings.
  Deterministic and IO-free — the git/read glue lives in reviewWrittenFiles. */
export def reviewSources(sources: string[]): Result<Feedback[]> {
  let feedback: Result<Feedback[]> = success([])
  for (source in sources) {
    feedback = mergeFeedback(feedback, agencyReview(source))
  }
  return feedback
}
```

> Deliberate: no `task` arg to `agencyReview`, so `std::agency::review` runs only parse+typecheck (no `llmFeedback`). This is what makes `reviewSources` deterministic and crash-free on real `.agency` source.

- [ ] **Step 4: Build + run** → PASS (3/3).

- [ ] **Step 5: Commit** ("Add reviewSources: deterministic parse+typecheck review core").

---

### Task 3: IO glue — `currentDirtyAgencyFiles` + `readAll`

**Files:** Modify `review.agency`.

**Interfaces:** `def currentDirtyAgencyFiles(): string[]` (git-dirty `.agency` paths, `[]` on non-git/failure); `def readAll(paths: string[]): string[]` (contents of readable paths; skips deleted/unreadable).

- [ ] **Step 1: Implement** in `review.agency` (import `gitStatus` from `std::git`; a statelog breadcrumb helper — confirm the exact `std::statelog` emit function):

```ts
import { gitStatus } from "std::git"

/** The .agency files dirty in the working tree right now, or [] when the dir is
  not a git repo / git fails (fail open — review becomes a no-op, never a crash).
  Turn-scoping (excluding pre-existing dirty files) is applied by the caller. */
export def currentDirtyAgencyFiles(): string[] {
  return match (try gitStatus()) {
    success(status) => filterAgencyPaths(map(status.entries, \entry -> entry.path))
    failure(err) => onGitUnavailable(err)
  }
}

def onGitUnavailable(err: any): string[] {
  logDebug("review: gitStatus unavailable, skipping .agency review: ${err}")
  return []
}

/** Read each path; skip (with a breadcrumb) any that cannot be read, e.g. a
  deleted (`D`) entry whose path no longer exists on disk. */
def readAll(paths: string[]): string[] {
  let sources: string[] = []
  for (path in paths) {
    match (read(filename: path, useAgentCwd: true)) {
      success(text) => { sources.push(text) }
      failure(err) => { logDebug("review: could not read ${path}, skipping: ${err}") }
    }
  }
  return sources
}
```

> `status.entries` (NOT `.files`) — `GitStatus = { branch, upstream, ahead, behind, entries: FileStatus[] }`, `FileStatus = { path, index, worktree, renamedFrom? }` (`lib/stdlib/gitCore.ts`). `entries` includes untracked (`?`, good — new agent files are caught) and deleted (`D`) files; the `readAll` `failure` arm fails those open. `logDebug` = a thin wrapper over the `std::statelog` debug emit; confirm the function name and add the wrapper.

- [ ] **Step 2: ast-check + build** — `pnpm run ast lib/agents/agency-agent/subagents/review.agency`, then `make`. Diff `make` errors against a pre-change baseline; expect none new.

- [ ] **Step 3: Manual smoke** (IO can't be unit-tested without a repo): in a temp git repo with a changed `foo.agency`, a deleted `gone.agency`, and a `bar.py`, a scratch program calling `currentDirtyAgencyFiles()` prints `["foo.agency", "gone.agency"]` and `readAll(...)` returns only `foo.agency`'s contents; in a non-git dir `currentDirtyAgencyFiles()` prints `[]`. (Approve interrupts with `with approve`.) Save output to a file.

- [ ] **Step 4: Commit** ("Add currentDirtyAgencyFiles and readAll IO glue").

---

### Task 4: `reviewWrittenFiles(baseline)` — compose glue + core

**Files:** Modify `review.agency`.

**Interfaces:** `def reviewWrittenFiles(baseline: string[]): Result<Feedback[]>` — review the `.agency` files that became dirty since `baseline`.

- [ ] **Step 1: Implement** in `review.agency`:

```ts
export def reviewWrittenFiles(baseline: string[]): Result<Feedback[]> {
  const changed = subtractBaseline(currentDirtyAgencyFiles(), baseline)
  return reviewSources(readAll(changed))
}
```

> All four pieces are already tested or smoke-verified. The composition is the "declarative what" the call site sees; the git/read "how" is encapsulated.

- [ ] **Step 2: Build** — `make`. Expect clean.

- [ ] **Step 3: Commit** ("Add reviewWrittenFiles composing turn-scoped file review").

---

### Task 5: Wire the code agent — baseline capture + call-site swap

**Files:** Modify `lib/agents/agency-agent/subagents/code.agency`.

- [ ] **Step 1: Read** `code.agency` `codeAgent` (~420-506): confirm the entry point (before the `thread`/`while`), the single `review(reply)` call site (~480), and the `./review.agency` import.

- [ ] **Step 2: Capture the baseline once at entry.** Near the top of `codeAgent`, before the loop:

```ts
const agencyBaseline = currentDirtyAgencyFiles()
```

- [ ] **Step 3: Swap the call site.** Add `reviewWrittenFiles`, `currentDirtyAgencyFiles` to the `./review.agency` import, then:

```ts
// was: const feedback = review(reply)
const feedback = reviewWrittenFiles(agencyBaseline)
```

Leave the `if (feedbackHasErrors(feedback)) { … } else { … verify … }` structure intact: non-Agency turn → `success([])` → `else` → `verify` runs (the unblock); real Agency errors in files the agent wrote this turn still surface.

- [ ] **Step 4: Build** — `make`. Confirm `code.agency` compiles; `reply` is still returned to the user, only the review input changed. Confirm no re-export TDZ from adding imports (see `review.agency`'s header comment).

- [ ] **Step 5: Commit** ("Code agent reviews the .agency files it wrote this turn, not the chat reply").

---

### Task 6: Real-LLM regression (statelog-asserted)

**Files:** Extend `tests/integration/agents/test.mjs`.

- [ ] **Step 1: Add a `review-no-thrash` case.** Run the code agent (`agency agent --agent code --policy approve-all -p -- "<python output-contract task>"`) in a temp **git** repo (so `gitStatus` works). Pass `--log-file <statelog.jsonl>`. Assert on **statelog events**, not substrings:
  - the deliverable file matches the contract byte-for-byte;
  - review produced **0 error findings** (no `feedbackHasErrors`-true iteration);
  - `verify` was invoked **≥ 1** time (a `promptStart`/thread event for the `verify` session).

  This guards the end-to-end behavior and cannot rot the way an "absence of `The last code had errors`" substring check would.

- [ ] **Step 2: Run locally with a key** (NOT the full suite): `cd packages/agency-lang && make && node tests/integration/agents/test.mjs` (or an `--only` filter). Save output to a file.

- [ ] **Step 3: Commit** ("Add statelog-asserted review-crash regression test").

---

## Self-Review

**1. Spec coverage:** Review `.agency` files not the chat reply ✓ (Tasks 2-5). **Turn-scoped** via `current − baseline` ✓ (Tasks 1,3-5) — the altitude bug the prior draft stamped "✓" is now actually handled, and the spec's turn-scoping language is honored. Decouple `verify` from `review` ✓ (Task 5, the swap alone unblocks the `else`). Fail-open on non-git dirs / deleted files, **with breadcrumbs** ✓ (Task 3). Preserve `reviewAgent`/`review(userMsg)` ✓. `std::git` mechanism ✓. Deliberate `task=""` (no LLM) ✓ (Task 2, explicit).

**2. Placeholder scan:** No requirement placeholders. Explicit confirm-at-implementation items: the `GitStatus` field is now **stated** (`entries`, not guessed), the `std::statelog` emit name (Task 3), and `.endsWith`/`.includes` method availability (Task 1) — each with a fallback. Commit messages via a temp file.

**3. Type consistency:** `read` returns `Result` → unwrapped via `match` in `readAll` (fixes the prior type bug). `GitStatus.entries[].path` used (fixes the prior `.files` bug). `reviewSources(string[]) -> Result<Feedback[]>` matches `feedbackHasErrors`/`mergeFeedback`. `reviewWrittenFiles(baseline: string[]) -> Result<Feedback[]>` matches the `code.agency` consumer. `currentDirtyAgencyFiles() -> string[]` feeds both the baseline capture and `subtractBaseline`.

**4. Test pyramid (addressing the prior draft's inverted coverage):** the *fix itself* is now guarded by **deterministic PR-tier tests** — `reviewSources` (empty→clean, broken→error, valid→clean) is the heart of the fix and runs without an LLM; `filterAgencyPaths`/`subtractBaseline` cover the set logic and edge cases (`.agency.txt`, empty, pre-existing baseline). The real-LLM test is a hardened, statelog-asserted end-to-end belt-and-suspenders, not the sole guard. IO-only functions (`currentDirtyAgencyFiles`, `readAll`) are smoke-verified (Task 3) because they need a real git repo; their pure inputs/outputs are covered by the composed helpers.

**Anti-pattern note:** the `reviewSources`/`readAll` mutable-accumulator folds are kept deliberately — they match the established `std::agency::review` idiom; rewriting as `reduce` would violate "inconsistent patterns" to satisfy "imperative code." Lambda params are descriptive (`\path`, `\entry`), and every fail-open arm leaves a `std::statelog` breadcrumb so a silently-disabled review is diagnosable.
