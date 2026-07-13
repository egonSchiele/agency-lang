# Design (Sub-project C): Fix the `review()` crash and unblock `verify` in the code agent

**Date:** 2026-07-12
**Status:** Design (awaiting review → plan)
**Part of:** the plan-as-code initiative (C of A/B/C). Independent and shippable on its own; should land first because it is a live regression.

## Motivation

The main `agency agent` (`--agent code`) fails most *non-Agency* coding tasks (Python/C/shell) because of a harness bug, not model capability. Root-caused from Terminal-Bench transcripts (see the terminal-bench benchmarking notes):

1. The one-shot loop (`lib/agents/agency-agent/subagents/code.agency:480`) calls `review(reply)` on the model's chat reply each iteration.
2. `review()` (`subagents/review.agency`) asks an LLM to "extract any Agency code snippets" from the reply, then feeds each to `agencyReview()` (`std::agency::review`), which parses and typechecks the snippet **as Agency**.
3. On a Python/shell reply, that parse/typecheck **crashes internally** and surfaces as `Error: Parse error: Cannot read properties of undefined (reading 'replace')` and `Typecheck failed: … Received undefined`. `feedbackHasErrors` treats the crash output as "your code has errors."
4. The agent, which wrote correct Python, is told to "fix" errors that do not exist and **thrashes** (observed: 152 tool-call churns rewriting a correct file).
5. **The fresh-eyes `verify` step lives in the `else` branch that only runs when `review()` finds no errors** (`code.agency:485-505`). Because `review()` crash-flags every non-Agency reply, that branch is never reached, so `verify` runs **0 times** on non-Agency tasks — the one mechanism that would catch subtly-wrong output is disabled.

Confirmed empirically across three failing tasks: 76/70/152 phantom-error re-prompts, 0 verify runs.

## Goals

- `review()` never mis-fires on non-Agency work (no phantom errors, no thrash).
- `verify` runs on one-shot completion regardless of whether `review()` ran or found anything.
- Preserve `review()`'s real value: catching genuine errors in *Agency* code the agent writes.
- No behavior change for interactive Agency-authoring sessions beyond the two fixes above.

## Non-goals

- Triage / escalation / plan-as-code (sub-projects A and B).
- Re-tuning prompts beyond what these fixes require.

## Root fix: review the `.agency` files, not the chat reply

The crash comes from treating the model's prose reply as Agency source. The fix is to **review the actual `.agency` files the agent produced on disk**, never the chat text.

- After the model turn, discover the `.agency` files in the agent's working directory (`glob("**/*.agency")` under `getAgentCwd()`), restricted to files created or modified this session.
- Run `std::agency::review(source)` on each such file's contents.
- If the agent wrote no `.agency` files (the common case for Python/C/shell tasks), `review()` is a **no-op** — there is nothing Agency to review, so nothing can crash.

This removes the unreliable "extract Agency snippets from a chat message" step entirely. Non-Agency replies can no longer reach the Agency parser.

Belt-and-suspenders: make `agencyReview` fail *safe* as well — if `_parseAST`/`_typecheck` throw for a genuinely malformed input, return **no findings** rather than an `error:true` finding, so an internal crash is never reported as user-code errors. (`parseFeedback`/`typecheckFeedback` in `std::agency` currently return `error:true` on a thrown error; scope this softening to the agent's review path so `writeAgency`'s own repair loop still sees real diagnostics.)

## Decouple `verify` from `review`

`verify` (run-the-artifact) is task-agnostic and is the general correctness check. It must not be gated behind an Agency-specific step.

Restructure the one-shot completion so, per iteration:

```
reply = llm(userMsg, {tools})
agencyErrors = review(.agency files the agent wrote)     # no-op if none
if (feedbackHasErrors(agencyErrors)) {
    userMsg = "The Agency code you wrote has errors: …"   # only for real Agency errors
    hasErrors = true
} else {
    hasErrors = false
    if (_oneShot && verifyRounds < 2) {
        verdict = unwrapVerdict(try verify(originalUserMsg))   # ALWAYS runs on clean/no-Agency
        if (!verdict.satisfied) { re-prompt with gaps; verifyRounds += 1 }
    }
}
```

The key change from today: `review()` returning "no findings" (because there were no `.agency` files) now **falls through to `verify`**, which is exactly what should happen for a Python/shell task. `verify` already delegates to the lifted, fail-open `std::agency::verify` (shipped in the std::agents PR).

## Files

- `lib/agents/agency-agent/subagents/review.agency` — replace the extract-snippets-from-reply flow with review-the-written-`.agency`-files flow. Keep the `Feedback`/`renderFeedback`/`feedbackHasErrors` surface.
- `lib/agents/agency-agent/subagents/code.agency` — pass the written-files context to `review()` (or have `review()` discover them); the loop structure already has the `if/else` shape above, so the change is what `review()` inspects, not the control flow.
- Possibly `std::agency` — a fail-safe variant or flag for `agencyReview` so a thrown parse/typecheck yields no findings on the agent path.

## Testing

- **Deterministic (PR tier):** a unit test that `review()` over a directory with **no** `.agency` files returns no findings (so the loop reaches `verify`); and that `review()` over a directory with a genuinely broken `.agency` file returns an error finding.
- **Real-LLM (post-merge):** a Python task (write an exact-format file) that previously thrashed — assert the agent completes without phantom-error re-prompts and that `verify` runs (observable via statelog). This is the regression guard for the whole bug.

## Risks / open questions

- **Detecting "files written this session"**: simplest is to snapshot the `.agency` files (path + mtime/hash) at task start and diff at review time, or to have the write/edit tools record touched paths. Decide the mechanism in the plan.
- **Interactive Agency authoring**: when a user is iterating on Agency code in a REPL, `review()` should still fire on their `.agency` files — the file-based approach preserves this (it reviews the files, which is what they are editing).
- **`agencyReview` softening scope**: must not weaken `writeAgency`'s repair loop, which relies on real parse/typecheck diagnostics. Keep the softening on the agent's review path only.
