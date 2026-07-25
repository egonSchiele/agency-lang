# Agent benchmarking: findings + CI tracking idea

Working notes from a 2026-07-12 session. Two connected threads:
1. Why the agency agent fails general (non-Agency) coding tasks on Terminal-Bench — a root-caused **harness bug**, plus a comparison against three other coding-agent harnesses.
2. A proposal to track agent task-solving performance over time in CI (non-blocking, graphed).

Related doc: `docs/dev/terminal-bench.md` (how we run the benchmark today).

---

## 1. Smoke-test that kicked this off

5-task smoke test, `agency-lang@0.8.0`, `anthropic/claude-sonnet-4-5`, k=1 (Daytona).
Job: `~/bench-agency/jobs/2026-07-12__14-33-43`. Result: **1/5 (mean 0.2)**.

| Task | Reward | What happened |
|---|---|---|
| `pytorch-model-recovery` | ✅ 1 | Ran clean, 15 tool calls. Arg-parse crash bug is **fixed** in 0.8.0. |
| `protein-assembly` | ❌ 0 | **Empty/0-tool-call bug — still present in 0.8.0.** Model emitted an empty response, 0 tool calls. The maxTokens fix did NOT recover it. |
| `dna-insert` | ❌ 0 | Agent ran 64 tool calls, wrote `/app/primers.fasta`, self-verified, exited clean. |
| `extract-elf` | ❌ 0 | Agent ran 66 tool calls, self-tested. |
| `filter-js-from-html` | ❌ 0 | Agent ran 106 tool calls (heavy thrash — repeatedly deleted/rewrote `filter.py`). |

k=1 over 5 tasks is anecdotal — don't read 0.2 as a score. The value was diagnostic.

---

## 2. Root cause of the three "genuine" failures: `review()` crash-loop shadows `verify`

**This is a real harness bug, not model capability.** (Corrects an earlier wrong call that these were "genuine task failures, not harness issues.")

The `--agent code` one-shot loop (`lib/agents/agency-agent/subagents/code.agency:456-500`):

```
reply = llm(userMsg, {tools})          # agent does the real task here
feedback = review(reply)               # <-- the problem
if (feedbackHasErrors(feedback)) {
    userMsg = "The last code had errors: ...Please fix them."   # loop again
    hasErrors = true
} else {
    ...
    if (_oneShot && verifyRounds < 2) { verify(originalUserMsg) }  # <-- verify lives HERE
}
```

What `review()` does (`lib/agents/agency-agent/subagents/review.agency:53-68`): asks an LLM to
"Extract any Agency code snippets from the following message," then feeds each snippet to
`agencyReview()`, which **parses + typechecks it as Agency code**.

On a Terminal-Bench task the reply is **Python/shell**, so `agencyReview` chokes and the failure
surfaces as (from the real transcripts):

```
Error: Parse error: Cannot read properties of undefined (reading 'replace')
Error: Typecheck failed: The "data" argument must be of type string ... Received undefined
```

Those are **internal crashes in review()/typecheck**, not real findings about the agent's code.
`feedbackHasErrors` treats the crash output as "your code has errors," so the agent is told to
"fix" errors that don't exist → it thrashes (filter-js: 152 tool-call churns rewriting a correct file).

**The kicker:** the fresh-eyes `verify` subagent — the one mechanism designed to catch subtly-wrong
output — lives in the `else` branch that only runs when `review()` finds NO errors. Since `review()`
crashes on every non-Agency reply, that branch is never reached.

Confirmed empirically across the 3 failing trials:
- "The last code had errors" re-prompts: **76 / 70 / 152**
- "work isn't complete yet" (verify's gap re-prompt): **0 / 0 / 0**  → verify never ran.

`_oneShot` IS true in the benchmark (`agent.agency:1947,1980`), so the gate isn't the issue — the
review crash upstream is.

### Supporting facts about our agent
- The `code` agent's system prompt (`lib/agents/agency-agent/code.js:180-328`) is **Agency-language-
  specialized** (typecheck Agency files, Agency syntax rules, "read basic-syntax.md"). Most of it is
  irrelevant baggage for Python/C/JS tasks.
- The doc's claimed hard rules **#13 (deliverable = run-and-verified artifact)** and **#14 (exact
  output contract)** are **NOT in shipped 0.8.0** — grep found nothing.
- `verify` (`subagents/verify.agency`) is well-designed in principle (reconstruct the success check
  from the task text, RUN the artifact, check the output contract literally) BUT it **fails open** and
  is told "when genuinely unsure, lean toward `satisfied` rather than blocking."
- Temperature is left unset (→ provider default), same as all three peers. Not a differentiator.

---

## 3. Comparison: opencode / pi / hermes

Sources cloned locally: `~/opencode` (TS/Bun), `~/pi` (TS monorepo), `~/hermes-agent` (Python).

Blunt summary: **the other harnesses do *less*, and they don't sabotage themselves.** None of them
parses the model's reply as its own language, so none can crash on Python and inject phantom errors.
Our agent is the only one of the four that actively corrupts general (non-Agency) coding tasks.

| | **Agency (ours)** | **opencode** | **pi** | **hermes** |
|---|---|---|---|---|
| Parses reply as its own DSL & typechecks it | **YES — crashes on non-Agency, injects phantom errors** | No | No | No |
| Out-of-loop verifier / critic | Has one (`verify`) **but shadowed → never runs** | None | None | None (bg review = memory only; MoA opt-in) |
| Loop exit | after review "passes" (never does) | model stops calling tools | model stops calling tools | model stops calling tools |
| Format-preserving edits (CRLF/LF + BOM) | not explicit | yes, exact-string + 9 fuzzy strategies, read-before-edit | yes, exact-string, raw-byte reads | yes, fuzzy patch + post-edit syntax check |
| "Deliverable = run & verified real artifact" prompt rule | **absent** | in beast/default/gemini; **weak for Claude** | absent (minimal prompt) | **universal**, incl. Claude |
| "Match exact output format/schema" prompt rule | absent | absent (except structured-output) | absent | only GPT/Codex/Grok (**off for Claude**) |
| Temperature / thinking | provider default | provider default | provider default, thinking=medium | provider default, thinking=medium |

### Notable per-harness details
- **opencode** (`packages/opencode/src/session/`): per-model-family prompts. `beast.txt` (GPT):
  *"Failing to test your code sufficiently rigorously is the NUMBER ONE failure mode... remember there
  are hidden tests that must also pass before the solution is truly complete."* Its **Claude prompt
  (`anthropic.txt`) is the weakest on verification** (no run-tests instruction). No verifier phase;
  loop exits at finish-reason (`prompt.ts:1111-1130`). 9-strategy fuzzy edit replacer, BOM/line-ending
  preserved (`edit.ts`).
- **pi** (`packages/coding-agent/src/core/`): minimal system prompt (`system-prompt.ts:130-147`) — only
  always-on guidelines are "Be concise" and "Show file paths clearly." No verify text, no critic, no
  correctness-retry. Defense is purely mechanical: byte-faithful `edit` (BOM + CRLF/LF preserved) and
  `read` that returns **raw bytes with no line-number injection**. Fails (doesn't execute) tool calls
  from token-truncated turns. Thinking=medium default.
- **hermes** (`agent/prompt_builder.py`, `conversation_loop.py`): ships a **universal**
  `TASK_COMPLETION_GUIDANCE` to every model incl. Claude — *"the deliverable is a working artifact
  backed by real tool output, not a description of one... keep working until you have actually
  exercised the code... NEVER substitute plausible-looking fabricated output."* A `<verification>`
  checklist ("does the output match the requested format or schema?") exists but is **gated to
  GPT/Codex/Grok only** — off for Claude. No out-of-loop verifier. Fuzzy `patch` + post-edit syntax
  check; explicit CRLF/LF/BOM preservation (`file_operations.py:76-146`); stale-view guards.

### Structural lesson
None of the three peers solves the "off-by-a-bit numeric" failure structurally — they rely on prompt
guidance + clean tooling. Our `verify` subagent is actually a *better* mechanism in principle (it
reconstructs the success check and runs the artifact). The fix is not to copy them; it's to **stop
blocking our own verify step.**

---

## 4. Recommended agent fixes (priority order)

1. **Stop `review()` poisoning non-Agency tasks (highest impact, small fix).** Either (a) only run
   `review()` when the agent actually wrote/modified `.agency` files this turn, or (b) make
   `agencyReview` fail-*safe*: if parse/typecheck throws, return "no findings" — never surface an
   internal crash as a user-code error. `feedbackHasErrors` must not treat a crash as "code is broken."
2. **Decouple `verify` from `review()` passing.** Move the `verify` call out of the review `else`
   branch so it runs on every one-shot completion (still capped at 2 rounds). This is the mechanism the
   peers lack; unblocking it is our potential edge.
3. **Add a general deliverable/output-contract rule to the `code` prompt** (the phantom #13/#14).
   Mirror hermes' `TASK_COMPLETION_GUIDANCE` + a `<verification>` "match the exact output format/
   schema?" checklist — and apply it to Claude (every peer gates this OFF for Claude).
4. **Make `verify` strict on output contracts.** It's told to "lean toward satisfied when unsure."
   Exact filename, JSON keys, units, trailing newline are cheap deterministic checks and a dominant
   failure cluster — block on those, don't fail open.
5. (Lower) Confirm our `write`/`edit` preserve byte formatting (CRLF/LF/BOM) like all three peers.
   Not the direct cause of these 3 (filter-js reformatted HTML via its own Python parser), but a
   general robustness item.

Fastest way to confirm the causal story: implement #1 + #2 on a branch and re-run the same 5 tasks.

---

## 5. Idea: track agent task-solving performance over time in CI

Goal: on every push to main, run a Terminal-Bench-like suite, **track results over time and graph
them, without failing CI**. Feasible — 3 of 4 building blocks already exist.

### What integration tests exist today
- **19 `.agency` wiring tests** in `lib/agents/agency-agent/tests/` (`agentTurn`, `capabilities`,
  `execPolicy`/`gitPolicy`, `mcpGating`, `memoryWiring`, `oneShotRounds`, `models`, ...). Run via
  `pnpm run test:agents` (`agency test lib/agents`). These test **wiring/control-flow, NOT task-solving
  performance** — the agent could get much worse at solving tasks and all of these still pass. (This is
  why the `review()` crash slipped through — nothing measures end-to-end task success.)
- **`test-with-llm.yml`** (`.github/workflows/`) — already runs the agent tests against the **real
  OpenAI API on push to main** (post-merge), plus `test:optimize-efficacy`. This is the hook point.
- **`test:optimize-efficacy`** (`tests/integration/optimize-efficacy/test.mjs`) — the one existing
  *quality-score* test: runs `agency eval optimize`, reads a `summary.json` of objective scores,
  asserts improvement. But it's a hard **pass/fail gate**, not tracked over time.
- **`lib/eval`** — a full grading harness (`agency eval`) with judges, task inputs, machine-readable
  `summary.json` output. The in-repo mechanism to build a graded task suite on.
- **No Terminal-Bench-style benchmark runs in CI.** TB is entirely external (`~/bench-agency`,
  harbor + Daytona).

### Pieces that already exist (why this is cheap)
1. ✅ Post-merge-to-main workflow with API secrets wired (`test-with-llm.yml`).
2. ✅ Grading harness that emits scores (`agency eval` → `summary.json`).
3. ✅ Precedent for real-LLM quality measurement in CI (`optimize-efficacy`).
Missing: a curated task set, non-blocking result capture, over-time storage + a graph.

### The one real design decision: what runs the tasks?
- **Path A — graded tasks *inside* the GitHub runner (recommended for per-push).** Curate ~10–20 small
  tasks the agent solves directly in the CI container (Python/shell, no Daytona), graded by `agency
  eval` judges or deterministic checks. Cheap (minutes, one API run), no external infra, tests the
  **actual merge commit**.
- **Path B — a real Terminal-Bench subset via Daytona from CI.** Most faithful, but adds Daytona cost
  per push, ~30–60 min, more flakiness — and a real gotcha: the current adapter does
  `npm i -g agency-lang`, so it tests the **published** version, not the merge commit. Per-push
  tracking would require rebuilding the adapter to install from source.

### Graph / over-time storage
- `benchmark-action/github-action-benchmark` is basically purpose-built for this: feed it
  `{name, value}` JSON, it commits to a `gh-pages` branch, auto-renders a time-series chart, and can be
  configured to **never fail the build** (alert/comment-only). Non-blocking = that config +
  `continue-on-error` on the job.
- Alternatives: append to a CSV/JSON on an orphan `bench-results` branch + a static page; or push to an
  external store. github-action-benchmark is the least work.

### Effort estimate
| | Path A (in-CI graded) | Path B (Daytona subset) |
|---|---|---|
| Task set + graders | ~1–2 days (the real work: good tasks + reliable grading) | reuse TB tasks; adapter rebuild ~0.5–1 day |
| Runner → single scores JSON | ~0.5 day (`agency eval` does most) | ~1 day (extract from harbor `result.json`) |
| CI job + benchmark-action + gh-pages graph | ~0.5 day | ~0.5 day |
| **Total v1** | **~2–3 days** | **~2.5–3 days + $/push + flakiness** |

**Recommendation:** start with **Path A on every push** (fast, cheap, tests the real commit), and
optionally add **Path B on a nightly/weekly cron** for fidelity.

### Caveats to design around
- **Noise.** A k=1 real-LLM score over 10–15 tasks wobbles run-to-run; a graph of a noisy number
  invites false trend-reading. Mitigate with k=3-and-average, a *fixed* task set, and tracking per-task
  pass-rate alongside the aggregate.
- **Cost cadence.** Runs on every merge. Gate with a `paths:` filter (only when `lib/agents/**` or
  stdlib changes) to avoid spending tokens on unrelated merges.

---

## Open next steps
- [ ] Implement fixes #1 + #2, re-run the 5 tasks to confirm the causal story.
- [ ] File an issue for the `review()` crash + verify-shadowing.
- [ ] Reconfirm `protein-assembly` empty/0-tool-call bug persists in 0.8.0 (it does) — reopen/track.
- [ ] Decide Path A vs A+B for CI tracking; brainstorm the task set + grading before building.
