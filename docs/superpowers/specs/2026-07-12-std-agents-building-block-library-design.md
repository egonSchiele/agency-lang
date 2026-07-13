# Design: `std::agents` — a building-block agent library

**Date:** 2026-07-12
**Status:** Design (awaiting review → implementation plan)

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
   them — wrong `for`-loop syntax, missing `main`, printing instead of
   returning. Stated rules "wash out."

This design ships a small library of **callable, batteries-included agent
primitives** (`std::agents`) and fixes the reliability problem with two
mechanisms proven in the literature and in a recent LangChain "tune the harness,
not the model" playbook: **worked examples** and **guidance at the point of
need**.

### Prior art this builds on

- **CodeAct** (ICML 2024): code-as-action beats JSON tool calls (~+20pp on
  complex tasks, ~30% fewer steps). Validates plan/action-as-code.
- **ADAS / Meta Agent Search** (ICLR 2025): a meta-agent programs new agents in
  code; large gains, but via *offline search with a fitness signal*, not
  zero-shot generation.
- **Voyager** (2023): agent writes code skills into a retrievable library with
  iterative refinement; its worst failure mode is *unsandboxed* runaway code —
  exactly what Agency's handler-sandbox + `runCode` ceilings fix.
- **MAST failure taxonomy** (2025): multi-agent systems fail 41–86.7%; dominant
  modes are specification (42%) and verification gaps (21%) — i.e. the "domino"
  risk of agents-writing-agents is real and must be bounded.
- **Agentless** (FSE 2025): a simple pipeline beat complex agents on SWE-bench —
  added machinery must earn its keep; route simple tasks straight through.
- **LangChain "Tuning the harness, not the model" (Nemotron 3 Ultra)**: pure
  harness tuning lifted 0.80 → 0.84 (0.86 best) at ~10× lower cost than Opus.
  Key lever: **guidance delivered at the point of need** works where the same
  wording in the system prompt washes out.

## Goals

- Ship `std::agents`: callable, batteries-included agent primitives the
  meta-agent (or a human) composes directly.
- Make each primitive reliable out of the box: strong prompt with worked
  examples, curated tools, a built-in verify→fix loop, output-contract
  discipline, and point-of-need guidance injection.
- Improve `writeAgency` itself (worked examples + point-of-need typecheck-error
  guidance) — a strict upgrade that helps every caller.
- Provide the substrate for idea #2 ("the agent writes an agent as its plan")
  via `plannerAgent`, with the domino risk structurally bounded.

## Non-goals (v1)

- Rewiring the main `agency agent` (`--agent code`) to use these primitives, or
  fixing its shadowed-`verify` / crashing-`review()` bug. Separate follow-up.
- `getEffects` support for a compiled `CompiledProgram` (needed for a pre-run
  effect-envelope preview). Fast-follow; v1 shows source for approval and relies
  on runtime handlers for safety.
- Deep agent-writes-agent recursion beyond one level.
- A higher-order `verified(agent, criteria)` combinator (see Architecture).

## Architecture

New module **`std::agents`** (distinct from `std::agency`, which holds the
lower-level `writeAgency` / `runCode` / `getEffects` / `review`).

### Why no `verified()` combinator

An earlier proposal factored verification into a `verified(makeAgent, criteria)`
combinator. Rejected, for two reasons:

1. **Verification methods genuinely differ per agent** — running produced files
   (coding) vs judging grounding/completeness (research) vs typecheck + run
   (Agency). Only the *loop shape* is common.
2. **Agency can't express it cleanly.** No lambdas; only one trailing block per
   call; blocks can't be assigned or returned; and — decisively — agent bodies
   throw interrupts (tool approvals), so re-invoking an agent body inside a
   retry loop hits block interrupt-replay fragility (same family as the `#513`
   nested-pause value loss).

**Instead:** each agent owns its own small verify→fix loop inline (the pattern
`lib/agents/agency-agent/subagents/code.agency` already uses), re-prompting its
*own* `llm()` with the gaps as a plain string. What's shared are **plain
functions**, not a combinator:

- `verifyArtifact(task): Verdict` — reconstruct success criteria from the task,
  run the produced files/programs, check the output contract literally. New in
  `std::agents`, adapted from the agent's `verify.agency`. Used by
  `codingAgent`, `agencyCodingAgent`, and `plannerAgent`.
- `Verdict` type + `renderGaps(gaps)` — new in `std::agents` (the existing
  `verify.agency` versions live in the agent tree, not stdlib).
- `review` / `Feedback` / `renderFeedback` — reused from `std::agency` for the
  Agency-specific typecheck path.

Composition for idea #2 falls out as ordinary sequential code, no combinator:
`writeAgency(subTask) → runCode(source) → verifyArtifact(subTask)`.

## Exports

Minimal signatures on purpose: an LLM caller configures poorly (cf. the
`memory: 512`-bytes unit bug), so caps stay internal; the only optional param is
`context` for extra material passed down.

### Worker agents

```
def codingAgent(task: string, context: string = ""): string
```
- Tools: `read`, `write`, `edit`, `ls`, `glob`, `grep`, and a shell tool
  (`bash`/`exec`). Exact sourcing pinned in the plan (`std::shell` provides
  `ls`/`glob`/`grep`/`exec`).
- Verify: `verifyArtifact(task)` — runs the produced files/programs.
- Returns: a short summary reply; the real output is filesystem side effects.
- Reliability: output-contract discipline in the prompt + point-of-need
  reminder before finalizing (see Reliability).

```
def researchAgent(task: string, context: string = ""): string
```
- Tools: `fetch`/`fetchJSON`/`fetchMarkdown` (`std::http`), `search`
  (`std::wikipedia`), and the LLM's built-in web-search capability where the
  configured backend provides it (degrades gracefully when search is off).
- Verify: a grounding/completeness judge over the answer + its sources (NOT
  `verifyArtifact` — there is no artifact to run).
- Returns: synthesized findings, with sources.

```
def agencyCodingAgent(task: string, context: string = ""): Result<string, WriteFailure>
```
- The flagship — "`writeAgency` done right."
- Flow: generate (improved prompt with worked examples + docs) →
  typecheck-repair (existing `writeAgency` loop) → `runCode` → `verifyArtifact`.
- Returns: source that compiles, typechecks, AND does the task.
- Built on the improved `writeAgency` (below).

### Meta-agent (idea #2)

```
def plannerAgent(task: string, context: string = "", maxCost: number = $2.00): string
```

Control flow, built to bound the domino risk:

1. **Route by complexity first** (Agentless). Straightforward tasks skip
   code-gen and delegate to `codingAgent`/`researchAgent`. Code-gen only for
   genuinely multi-part tasks.
2. **Write the agent-as-plan:** `writeAgency(task, context)` generates a program
   that composes the worker agents + tools. The generated agent *is* the plan.
3. **Gate + run:** surface the generated source for approval, then
   `runCode(source, maxCost: <remaining budget>)`. Handler-sandboxed: every
   effect is gated by the parent's handlers at runtime even if the code drifted.
4. **Verify:** `verifyArtifact(task)`; on gaps with budget left, feed them back
   to `writeAgency` to patch and re-run (capped).
5. **Fallback:** on repeated failure, degrade to `codingAgent(task)`. A drifting
   generation never strands the task.

**Recursion is bounded structurally, not by a counter:** the generated agent's
import surface includes the *worker* agents (non-recursive) but NOT
`plannerAgent` itself. So agent-writes-agent is one level deep by construction.

**Caveat:** a pre-run *effect-envelope* preview wants `getEffects` on a compiled
program, which today works only per-exported-symbol of a static unit. v1 shows
the source for approval; runtime handlers provide the actual safety.

### Shared helper

```
def verifyArtifact(task: string): Verdict
```
Plus `Verdict` and `renderGaps` (new in `std::agents`).

## Reliability recipe (how we guarantee usefulness)

Every agent gets:

1. **Worked examples where they matter.** The "examples beat rules" lesson
   applies hardest to agents that emit *Agency* code:
   - `agencyCodingAgent` / `writeAgency`: prompt embeds 2–3 complete, typechecked
     Agency programs (imports, `node main`, explicit `return`) as static consts.
     One source of truth — the same consts few-shot `writeAgency`.
   - `codingAgent` / `researchAgent`: emit Python/shell/prose, so full Agency
     examples don't apply; reliability comes from output-contract discipline +
     the verify loop.

2. **Guidance at the point of need** (the Nemotron lever). Baseline rules +
   examples live in the system prompt, but the rules that empirically wash out
   are *also* delivered as a message at the moment they are needed:
   - `agencyCodingAgent` / `writeAgency`: when a typecheck error returns, inject
     the *specific* syntax rule next to *that* error (e.g. "Agency has no
     C-style `for`; count with `while`"), not just the up-front rule list.
   - `codingAgent`: inject the output-contract reminder ("report the concrete
     result; match the exact filename/format") as a message right before the
     model finalizes.
   - `verifyArtifact` gap feedback is already this pattern (a message at the
     decision point) — lean into it, don't treat it as a fallback.

3. **Curated, fixed toolset** — no LLM-chosen tool wiring.

4. **Built-in verify→fix loop** — capped by rounds + `maxCost`.

5. **Output-contract discipline** — the gap all four surveyed harnesses
   (opencode / pi / hermes / our own) under-do for Claude.

### Design principles noted but out of v1 scope

- **Plan-then-review injected beats** — a cheap injected "plan first / review
  before finalizing" message could help the worker agents (validated by
  Nemotron). Considered for a later iteration.
- **Cost-ladder evaluation** — screen changes on a cheap sample first, run the
  full suite only when the win holds and regresses nothing. A testing/CI
  discipline (below), not agent behavior.

## `writeAgency` improvement

A strict upgrade to the existing function, independent of the new agents:

- Add 2–3 worked Agency examples to `writeSysPrompt`.
- On a typecheck-repair round, inject the specific rule matched to the error
  (point-of-need), rather than relying on the static rule list.

## Testing

Two tiers, reusing existing infrastructure:

- **PR tier** — deterministic mock-LLM tests in the `test:agents` suite assert
  *wiring* (each agent registers, routes, caps apply). Fast, free, no secrets.
- **Post-merge tier** — real-LLM tests in `.github/workflows/test-with-llm.yml`
  assert *efficacy*: each agent solves a known task and its `verifyArtifact`
  passes. This is also the natural feed for the over-time performance graph
  (separate CI-tracking idea).
- **Cost-ladder discipline** — screen on a cheap sample before the full suite.

## Dependencies (all exist)

`std::agency` (`writeAgency`, `runCode`, `getEffects`, `review`, `Feedback`,
`renderFeedback`, `WriteFailure`), `std::shell` (`ls`/`glob`/`grep`/`exec`),
`std::http`, `std::wikipedia`, `std::thread` (`systemMessage`), and `docsSkill`
for the Agency agent.

## Risks / open questions

- **Point-of-need injection mechanics.** Delivering a rule "next to the data"
  means putting it in the tool result or as an injected message. Confirm the
  cleanest way to do this in Agency's `llm()`/thread model during planning.
- **`verifyArtifact` fail-open vs strict.** The current `verify.agency` leans
  "satisfied when unsure." For output-contract checks (exact filename, keys,
  units, trailing newline) it should be *strict*. Decide the default.
- **`researchAgent` web-search availability** varies by backend; the grounding
  judge must not hard-fail when search is off.
- **`plannerAgent` cost accounting** across `runCode` + verify rounds must stay
  within the single `maxCost` budget (watch the `#513` nested-pause interaction
  if the generated program itself pauses).
