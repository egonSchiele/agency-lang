# Design: `std::agents` — a building-block agent library

**Date:** 2026-07-12
**Status:** Design (awaiting review → implementation plan)
**Revised:** 2026-07-12 after plan review — reuse `Feedback` (not a new `Verdict`); lift `verify` into stdlib; file-per-agent; `guard`-based caps.

## Motivation

Agency has a genuinely rare capability: an agent can generate Agency source
(`std::agency::writeAgency`) and run it in a subprocess (`runCode`) that
**inherits the parent's handlers**, so the user defines exactly what the
generated code may do. This is "code-as-action taken to its conclusion — the
model writes a whole program — plus the governance CodeAct lacks." The
`std::agency` ADAS primitives (`writeAgency`, `runCode`, `getEffects`,
`maxCost`, `review`) shipped in PR #512/#514 are the substrate for this.

Two problems motivate this work:

1. **There are no reusable agent building blocks.** To compose agents today you
   wire prompts + tools + loops by hand every time.
2. **`writeAgency` is unreliable.** Its system prompt *states* the syntax rules
   ("must have a `node main`", "return the value") yet the model still breaks
   them. Stated rules "wash out."

This design ships a small library of **callable, composable, batteries-included
agent primitives** and fixes the reliability problem with two mechanisms proven
in the literature and in a recent LangChain "tune the harness, not the model"
playbook: **worked examples** and **guidance at the point of need**.

### Prior art this builds on

- **CodeAct** (ICML 2024): code-as-action beats JSON tool calls (~+20pp on
  complex tasks, ~30% fewer steps).
- **ADAS / Meta Agent Search** (ICLR 2025): a meta-agent programs new agents in
  code — big gains, but via *offline search with a fitness signal*.
- **Voyager** (2023): agent writes code skills with iterative refinement; its
  worst failure mode is *unsandboxed* runaway code — what Agency's
  handler-sandbox + `runCode` ceilings fix.
- **MAST failure taxonomy** (2025): multi-agent systems fail 41–86.7%; dominant
  modes are specification (42%) and verification gaps (21%) — the "domino" risk
  is real and must be bounded.
- **Agentless** (FSE 2025): a simple pipeline beat complex agents — added
  machinery must earn its keep; route simple tasks straight through.
- **LangChain "Tuning the harness, not the model" (Nemotron 3 Ultra)**: harness
  tuning lifted 0.80 → 0.84 at ~10× lower cost. Key lever: **guidance at the
  point of need** works where the same wording in the system prompt washes out.

## Goals

- Ship `std::agents`: callable, composable, batteries-included agent primitives.
- **Composition, not configuration** (hard constraint): agents are independent
  `def`s combinable in any way. No mandatory base, no config schema, no
  `verifyMode` enum. Shared logic is only ever a plain callable helper.
- Make each primitive reliable out of the box: strong prompt with worked
  examples, curated tools, a built-in verify→fix loop, output-contract
  discipline, and point-of-need guidance injection.
- Improve `writeAgency` itself (worked examples + point-of-need typecheck-error
  guidance) — a strict upgrade that helps every caller.
- Provide the substrate for idea #2 (`plannerAgent`) with the domino risk
  structurally bounded. (Deferred to a Part-2 plan.)

## Non-goals (v1)

- Rewiring the main `agency agent` (`--agent code`), or fixing its shadowed-
  `verify` / crashing-`review()` bug. Separate follow-up.
- Introducing a new result type. We **reuse the existing `Feedback`** type.
- `getEffects` for a compiled `CompiledProgram` (pre-run effect-envelope
  preview). Fast-follow; v1 shows source for approval and relies on handlers.
- Deep agent-writes-agent recursion beyond one level.
- A higher-order `verified(agent, criteria)` combinator (see Architecture).

## Architecture

New module namespace **`std::agents`**, one file per agent (nested stdlib
modules, like `std::ui/layout` and `std::web/search`):

- `stdlib/agents/coding.agency`  → `std::agents/coding`   (`codingAgent`)
- `stdlib/agents/research.agency` → `std::agents/research` (`researchAgent`)
- `stdlib/agents/agency.agency`  → `std::agents/agency`   (`agencyCodingAgent`)

Each agent is imported directly. **No `std::agents` barrel** that re-exports
them — re-exporting types alongside tool-schema'd functions is the TDZ init
crash the ADAS work hit.

### Result type: reuse `Feedback`

We do **not** introduce a `Verdict` type. Both verifiers return the existing
`std::agency` `Feedback`:

```
type Feedback = { error: boolean; feedback: string; data?: any }
```

`error` (per-line) lets a verifier report what the agent did *well* (`error:
false`) as well as what's wrong (`error: true`) — useful signal for the fix
loop. `data` stays as an arbitrary-detail escape hatch. Agents gate their loop
on the existing `feedbackHasErrors(...)` and feed `renderFeedback(...)` back.
Reused as-is: `Feedback`, `feedbackHasErrors`, `renderFeedback`,
`mergeFeedback`.

### Why no `verified()` combinator

An earlier proposal factored verification into a `verified(makeAgent, criteria)`
combinator. Rejected: (1) verification methods genuinely differ per agent, and
(2) Agency can't express it cleanly — no lambdas; one trailing block per call;
blocks can't be assigned or returned; and agent bodies throw interrupts, so
re-invoking one inside a retry loop hits block interrupt-replay fragility (the
`#513` family).

**Instead:** each agent owns its own small verify→fix loop inline, re-prompting
its own `llm()` with `renderFeedback(...)`. Composition for idea #2 is ordinary
sequential code: `writeAgency(subTask) → runCode(source) → verify(subTask)`.

### Verifiers: two, not three

- **`review(source, task)`** (exists in `std::agency`): *static* Agency analysis
  — parse + typecheck + optional LLM code-vs-task judgment. Returns
  `Result<Feedback[]>`. Keep as-is.
- **`verify(task)`**: *dynamic* — reconstruct the task's success criteria and
  **run the artifact** against them. Currently lives in the agent tree
  (`lib/agents/agency-agent/subagents/verify.agency`, returning a bespoke
  `Verdict`). **Lift it into `std::agency`**, change its return to
  `Result<Feedback[]>`, and have the agent's `verify.agency` *delegate* to it —
  exactly how `review.agency` already delegates to `std::agency::review`.

So there are two verification primitives (static `review`, dynamic `verify`),
both returning `Result<Feedback[]>`. No `verifyArtifact`.

## Exports

Signature convention (uniform, so agents compose interchangeably), with the
`guard`-based runaway caps exposed as parameters (a high cap beats an infinite
loop):

```
def codingAgent(task: string, context: string = "",
                maxCost: number = $50.00, maxTime: number = 10m): string
```
- Tools: `read`/`write` (prelude), `edit` (`std::fs`), `ls`/`glob`/`grep`/`bash`
  (`std::shell`).
- Loop: `guard(cost: maxCost, time: maxTime) as { while (!done) { run;
  verify(task); done = !feedbackHasErrors(fb) } }`. The `guard` is the hard cap;
  `done` is the clean exit. No numeric round-counter.
- Verify: `verify(task)` — runs the produced files/programs.
- Returns: a short summary reply; the real output is filesystem side effects.

```
def researchAgent(task: string, context: string = "",
                  maxCost: number = $50.00, maxTime: number = 10m): string
```
- Tools: `search` (`std::web/search`), `fetch`/`fetchMarkdown` (`std::http`),
  `search` (`std::wikipedia`), `read`. Degrades gracefully if web search is off.
- Verify: a grounding/completeness LLM judge returning `Result<Feedback[]>` (NOT
  the artifact-running `verify` — there is no artifact to run).
- Returns: synthesized findings, with sources.

```
def agencyCodingAgent(task: string, context: string = "",
                      maxCost: number = $50.00, maxTime: number = 10m): Result<string, WriteFailure>
```
- The flagship — "`writeAgency` done right."
- Flow: generate (improved `writeAgency`) → typecheck-repair → `runCode` →
  `verify`. Wrapped in `guard(cost:, time:)`.
- Caveat: `runCode` runs *inside* the guard; `guard` + nested pause/resume has
  the `#513` bug, so a paused generated program can lose the guard value.
  Acceptable for v1 (rare in these tasks); documented, watched.
- Returns: source that compiles, typechecks, AND does the task.

### Meta-agent (idea #2) — Part-2 plan

```
def plannerAgent(task: string, context: string = "",
                 maxCost: number = $50.00, maxTime: number = 20m): string
```
Route by complexity first (Agentless); otherwise write the agent-as-plan via
`writeAgency`, gate + `runCode` it, `verify`, patch on failure, and fall back to
`codingAgent`. Recursion is bounded structurally: the generated agent's import
surface includes the worker agents but NOT `plannerAgent`. Deferred to Part 2.

## Reliability recipe

1. **Worked examples where they matter.** Hardest for agents emitting *Agency*
   code: `agencyCodingAgent` / `writeAgency` embed 2–3 complete, typechecked
   Agency programs (imports, `node main`, explicit `return`) as static consts —
   the same consts few-shot `writeAgency`. `codingAgent`/`researchAgent` emit
   Python/shell/prose, so they rely on output-contract discipline + the verify
   loop.
2. **Guidance at the point of need** (the Nemotron lever): rules that wash out in
   the system prompt are *also* delivered as a message when needed —
   typecheck-error → the specific syntax rule; pre-finalize → the output-contract
   reminder; `renderFeedback(...)` gap feedback is already this pattern.
3. **Curated, fixed toolset** — no LLM-chosen tool wiring.
4. **`guard`-capped verify→fix loop** — `guard(cost:, time:)` + boolean exit.
5. **Output-contract discipline** in the prompt (the gap all four surveyed
   harnesses under-do for Claude).

### Principles noted, out of v1 scope

- Plan-then-review injected beats (Nemotron). Later iteration.
- Cost-ladder evaluation (cheap sample first). A testing/CI discipline.

## `writeAgency` improvement

Strict upgrade, independent of the new agents: add 2–3 worked Agency examples to
`writeSysPrompt`, and on a typecheck-repair round inject the specific rule
matched to the error (point-of-need) before the diagnostics.

## Testing

- **PR tier** — deterministic mock-LLM tests assert *wiring* (each agent exports,
  typechecks, caps present). Fast, no secrets.
- **Post-merge tier** — real-LLM tests in `.github/workflows/test-with-llm.yml`
  assert *efficacy* (each agent solves a known task; its `verify`/judge passes),
  non-blocking (`continue-on-error`). Natural feed for the over-time graph.
- **Cost-ladder discipline** — screen on a cheap sample before the full suite.

## Dependencies (all exist)

`std::agency` (`writeAgency`, `runCode`, `review`, `Feedback`,
`feedbackHasErrors`, `renderFeedback`, `mergeFeedback`, `WriteFailure`),
`std::shell` (`ls`/`glob`/`grep`/`exec`/`bash`), `std::fs` (`edit`), `std::http`,
`std::wikipedia`, `std::web/search`, `std::thread` (`systemMessage`), the
`guard` primitive, prelude (`read`/`write`), and `docsSkill` for the Agency
agent.

## Risks / open questions

- **Lifting `verify` to `std::agency`.** Confirm no circular-import or prelude
  issue when a stdlib module hosts a tool-using LLM agent; confirm the agent's
  `verify.agency` can delegate cleanly (mirror `review.agency`).
- **`verify` strictness.** The current `verify.agency` leans "satisfied when
  unsure." For output-contract checks (exact filename, keys, units, trailing
  newline) it should be *strict* — emit `error: true` findings on near-misses.
- **`researchAgent` web-search availability** varies by backend; the grounding
  judge must not hard-fail when search is off (documented skip in CI).
- **`guard` + `#513`** interaction inside `agencyCodingAgent` / `plannerAgent`
  when a generated program pauses.
- **Point-of-need injection mechanics** in Agency's `llm()`/thread model.
