# Review: Scheduled Agents Branch Output Plan

Review of `2026-08-13-scheduled-agents-branch-output.md` against the spec, the three live agents, the runtime, and the parser. Every claim below was verified against the code, not assumed.

**Verdict: do not execute as written.** The plan is careful and mostly accurate — file references check out, the pure-helper extraction is right, and the safety reasoning is sound. But two findings are critical: the budget-trip path (a core goal of the whole design) is dead code in CI as planned, and the handler snippet at the center of the `.github/` safety control is not valid Agency syntax.

---

## Critical

### 1. Guard trips are unhandled in CI — the run dies instead of salvaging

The entire "stay in budget, push partial work" design rests on what happens when a guard trips. A trip surfaces as a `std::guard` interrupt that must be adjudicated by a handler or the user (`tests/agency/guards/trip-visibility.agency`). The plan never adjudicates it:

- The Task 4/5 handler explicitly `pass()`es everything that isn't `std::edit`, so `std::guard` propagates to the top.
- `stdlib-docs-links` gets no handler at all.
- The workflow runs the agent via run-agency-action, whose `scripts/run.sh` executes plain `agency run "$AGENCY_FILE"` — no `--policy`, `--approve`, `--reject`, or `--interactive`. I fetched the action source to confirm this.

Without any policy mechanism, a surfaced interrupt goes to `reportUnhandledInterrupts` and the process **exits non-zero** (`lib/runtime/cliInterruptResolution.ts:44-47`; `lib/runtime/interrupts.test.ts:292` — "prints a helpful message and exits non-zero for an unhandled interrupt").

Consequences as planned:

- **docs-review**: a $3.00/25m run that trips loses everything. No salvage, no truncation banner, no push — a red workflow. This is precisely the outcome the spec says the design avoids ("A run that trips its budget still delivers partial, clearly-labeled work").
- **constants-review / stdlib-docs-links**: the planned "Budget tripped … nothing to push" clean-exit branches never execute; the run just dies.

**Fix:** each agent must adjudicate `std::guard` itself, by adding to its handler:

```ts
if (i.effect == "std::guard") {
  return reject()
}
```

`reject()` is the correct verb: for docs-review, a rejected trip runs the salvage pipeline and the guard converts to `success(draft)` — proven by the `draftPreview` node in `trip-visibility.agency` ("a reject still salvages it authoritatively … the guard converts the trip to success(draft)"). For the other two (no draft), rejection converts the trip to the `failure` the plan's `else` branches already expect. `stdlib-docs-links` therefore needs a handler after all — the plan's "No handler is needed" holds only for `std::edit`, not for the guard the same task adds. Note the handler must sit **outside** the guard to be eligible (`insideGuardBlind` in the same test file), which the planned node-body placement satisfies.

This also deserves a test: a guard + `saveDraft` + rejecting handler exercising the exact salvage path the agents rely on. The guards test directory has ready-made patterns to copy.

### 2. `node main() { ... } with (i) { ... }` does not parse

Task 4 Step 5 and Task 5 Step 4 (and the spec's snippet, which the plan inherited) attach the handler as a trailing `with` clause on the node body. Nodes don't support that: `graphNodeParser` (`lib/parsers/parsers.ts:6808`) ends the node at the closing `}` with an optional semicolon — there is no `with` production. Handlers attach to `handle { ... } with` blocks and to call sites only. No test in `tests/agency/` uses a node-level trailing handler; every block handler is a `handle` block.

**Fix:** wrap the node body instead:

```ts
node main() {
  handle {
    // ...entire existing body...
  } with (i) {
    if (i.effect == "std::edit") {
      if (isGithubPath(i.data.dir, i.data.filename)) {
        print("Rejected edit under .github/: ${i.data.dir}/${i.data.filename}")
        return reject()
      }
      return approve()
    }
    if (i.effect == "std::guard") {
      return reject()
    }
    return pass()
  }
}
```

The plan's own "verify it parses" steps would catch the error, but an implementing agent should not have to discover the fix mid-task — this is the load-bearing safety control, per CLAUDE.md's rule that plans must contain verified Agency syntax.

---

## Verified sound (so the implementer doesn't re-litigate)

- **The `.github/` handler survives the call-site `with approve`.** The `llm(...) with approve` inside the loop does not swallow `std::edit` before the outer handler sees it: every handler up the chain executes, and any reject wins (`docs/site/guide/handlers.md`, "Handlers vs try/catch"). The control works as designed once written as a `handle` block.
- **`std::edit` payload shape.** `effect std::edit { dir, filename, edits, before, after }` (`stdlib/fs.agency:35`) — `i.data.dir` / `i.data.filename` are correct.
- **saveDraft semantics.** A trip with a saved draft yields `success(draft)`; without one, the pre-saveDraft failure (`docs/dev/saveDraft.md`, salvage rule 5). The spec's claim is accurate.
- **Guard literals.** `$3.00` (cost unit parser takes decimals), `25m` (`m` is a valid time suffix, normalized to ms), and combined `guard(label:, cost:, time:)` all parse — e.g. `tests/agency/guards/unowned-guard-rejected.agency:35`.
- **A `with approve` inside the guard cannot widen the budget.** A handler registered inside a guard is ineligible to adjudicate that guard's own trip (`insideGuardBlind`).
- **`is success(x)` in node bodies parses.** Used today in all three agents and in guard tests (`turn-budget-partial.agency:58`). The known pattern-guard parse bug (issue #397) concerns `match` guards, which this plan doesn't use.
- **`env` contract.** `export def env(name: string): string | null` (`stdlib/system.agency:101`) — the `== null` check is right.
- **File references.** `pinnedActions.ts:15-18` ✓, makefile tag list ~line 168 ✓, `stdlib-docs-links.agency` skip guard at 137-142 ✓, test file `tests/agency/scheduled-helpers.agency` exists with the described self-checking pattern ✓. One nit: the `uses:` line in the three workflows is line 20, not 21.
- **`isGithubPath` / `shouldForcePush` logic and their tests** are correct as specified, including the traversal case (substring matches `../../.github/…`) and the empty-author-means-new-branch case.

---

## Moderate

### 3. Task 4 doesn't say what happens to the `sections.length == 0` early return — and both options are wrong without more care

`docs-review.agency:84-87` returns early ("none appear out of date. Nothing to do.") when no findings exist. The plan replaces the loop and the report construction but never mentions this block.

- **If it survives:** a guard that trips during doc 1 — before the first `saveDraft` — returns `failure`, the plan's `if (budget is success(result))` has no `else`, so `processed` stays 0 and `sections` stays empty… and the early return prints "Reviewed 60 docs; none appear out of date." A fully truncated run reads as a clean bill of health — the exact failure mode the spec's truncation section exists to prevent.
- **If it's deleted:** `stamp()` now lives in the report header, so the report file differs on every run, `git diff --cached --quiet` always sees a change, and docs-review pushes a fresh branch every week even when it found and fixed nothing.

**Fix:** give Task 4 an explicit rule. Suggested: on `budget is failure`, print that the budget tripped before any doc completed and `exit(1)` (a loud red run, consistent with the module doc's "failures are loud" stance); on success with zero sections **and** `processed == files.length`, keep the early return. Same `else`-branch gap exists in miniature for the missing-else itself: silently proceeding with `processed = 0` should not be a reachable path.

### 4. constants-review stages `lib/` but tells the model to edit "every call site"

Task 5 stages `packages/agency-lang/lib` and `_reports`, but the rubric instructs the model to "update every call site." Call sites outside `lib/` (the rubric only says *concentrate* on `lib/`) would be edited on disk and silently dropped from the commit — producing a branch where the constant moved but some imports didn't, i.e. a branch whose CI fails for a reason invisible in the report. Either widen the staged path to `packages/agency-lang` (the narrow-path rationale is about runner build artifacts, which live elsewhere) or harden the rubric to forbid edits outside `lib/`.

---

## Minor

5. **"Add `edit` to the `std::fs` imports"** — neither `docs-review.agency` nor `constants-review.agency` has a `std::fs` import today (`read`/`write` are builtins; their imports are from `std::shell`/`std::system`). The step should say: add a new line `import { edit } from "std::fs"`.
6. **Stale `branch` declarations.** Task 6 remembers to delete the later `const branch = "${branchPrefix}${stamp()}"` line, but Tasks 4 and 5 don't mention their equivalents (`docs-review.agency:105`, `constants-review.agency:79`). Leaving them is a loud duplicate-declaration error, but the plan aims to be exact — say it.
7. **Task 6 leaves `bulletList` unused.** Deleting `title`/`body` orphans `const bulletList = missing.join("\n- ")` (`stdlib-docs-links.agency:196`); delete it too.
8. **`remoteTipAuthor` conflates "fetch failed" with "branch absent".** A transient network/auth failure on `git fetch` returns `""`, which arms a force-push. The window is small (the push moments later needs the same network working) and the failure requires a human tip to exist simultaneously, so this is acceptable — but worth a comment, and `git ls-remote --heads origin <branch>` distinguishes the two cases cheaply if you'd rather close it.
9. **Spec's handler tests are quietly downgraded.** The spec's Testing section asks that the `.github/` denial be exercised as a *handler* test ("an edit under docs/dev/ is approved; an edit naming .github/workflows/ci.yml is rejected and reported"). The plan tests only the pure predicate; nothing verifies the handler actually consults `isGithubPath` or that `reject()` blocks the write. A deterministic agency test can do this without an LLM: call `edit(...)` directly under a `handle` block with the same handler body and assert the file is unchanged after a `.github/` target and changed after a `docs/`-style target. The plan's "Notes" section owns the untested `processed` counter but not this deviation — either add the test (recommended: it's the top-billed control in the PR body) or record the choice.
10. **Force-push vs CLAUDE.md.** "NEVER force push" is directly contradicted; the spec argues the exception and the plan records it in the module doc, which is the right shape. Flagging only so the decision is visibly the repo owner's, not the implementing agent's.

---

## Summary for the plan author

Fix the two criticals before execution — both have small, well-determined fixes: adjudicate `std::guard` with `reject()` in every agent (including stdlib-docs-links), and express every node-level handler as a `handle { … } with (i) { … }` block. Add the Task 4 trip/empty-run rule (finding 3) while you're in that file. Findings 4–10 are line edits to the plan text. The architecture itself — pure helpers first, `pushBranch` as a thin wiring layer, guard around the LLM phase only, substring `.github/` check — verified out cleanly and needs no rethink.
