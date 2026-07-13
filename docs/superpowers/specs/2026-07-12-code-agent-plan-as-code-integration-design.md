# Design (Sub-project B): Wire the code agent to plan-as-code (triage + escalate)

**Date:** 2026-07-12
**Status:** Design (awaiting review → plan)
**Part of:** the plan-as-code initiative (B of A/B/C). **Depends on A** (`plannerAgent`) and **C** (the fixed direct loop). Land after both.

## Motivation

Sub-project A builds `plannerAgent` (plan-as-code). This sub-project makes the main `agency agent` (`--agent code`) actually *use* it — but only when a task warrants it. Per the brainstorming decision, the integration is **escalation by complexity, hybrid**: simple tasks keep today's fast, proven direct tool-loop; complex or multi-part tasks go through `plannerAgent`; and a "simple" task that turns out hard can still switch mid-flight.

This directly serves the owner's priority: the agent should analyze a task, decide how much structure it needs, and — when it escalates — explain the plan before acting.

## Goals

- A **triage** step at task start routes simple → direct loop, complex → `plannerAgent`.
- An **`escalate` tool** in the direct loop lets the model switch to `plannerAgent` when it discovers hidden complexity.
- Both paths work in interactive and one-shot/benchmark modes.
- The direct loop is unchanged for simple tasks except for the sub-project-C fixes.

## Non-goals

- Building `plannerAgent` (sub-project A).
- The `review()`/`verify` fix (sub-project C).
- Changing the worker agents.

## Where this lives

The code agent's entry is `codeAgent(userMsg, allowHandoff)` in `lib/agents/agency-agent/subagents/code.agency`. The triage decision and the `escalate` tool are added here, around the existing thread/loop.

## Triage (upfront routing)

Before the direct loop, a cheap classifier decides the path:

```
def triage(task): { path: "simple" | "complex"; plan: string }
```

A single low-cost `llm` call: "Is this a straightforward single-step task, or multi-part / needs decomposition? If multi-part, outline the plan in 2-4 bullets." Returns a structured decision (path + a short plan the planner can reuse).

- `path == "simple"` → run today's direct loop (with the C fixes).
- `path == "complex"` → call `plannerAgent(task, context: plan)` and return its result.

Triage is one extra small call on every task. It replaces guesswork with a deterministic, observable routing point, and it is where the plan first takes shape (the plan then flows into `plannerAgent`, avoiding a second analyze step).

## Escalate tool (mid-flight fallback)

The direct loop's toolset gains one tool:

```
escalate(reason: string, plan: string): string
```

The model calls it when a task it started as "simple" turns out to need decomposition. `escalate` invokes `plannerAgent(originalTask, context: "${reason}\n${plan}")` and returns its result; the direct loop then finishes (the escalation produced the deliverable). The tool's description tells the model to reach for it only when the current task genuinely needs a multi-step plan, not for ordinary follow-ups — mirroring the existing guidance that biases toward staying in the direct loop.

## Control flow

```
codeAgent(task):
  decision = triage(task)
  if (decision.path == "complex") {
    return plannerAgent(task, context: decision.plan)
  }
  # simple path = today's loop (with sub-project C fixes), plus the escalate tool
  thread(...) {
    while (...) {
      reply = llm(task, { tools: [...codeTools, escalate] })
      # if the model called escalate, its result is already the deliverable
      review(.agency files) ; verify(task)   # per sub-project C
    }
  }
  return reply
```

Interactive vs one-shot: triage and the approval interrupt inside `plannerAgent` both work in either mode. One-shot uses the CLI policy (`approve-all` in the benchmark) so escalation and approval do not block; interactive prompts the user.

## Measurement

This is the sub-project whose payoff is measurable on Terminal-Bench. Wire the three worker/planner behaviors into the efficacy tracking (the non-blocking real-LLM CI suite and, separately, the over-time benchmark graph if built) so we can see whether escalation helps, hurts, or is noise on multi-part tasks — and tune the triage threshold from data.

## Files

- `lib/agents/agency-agent/subagents/code.agency` — add `triage`, the `escalate` tool, and the routing at `codeAgent` entry.
- The `escalate` tool definition (and its docstring, which the model reads) — colocated with the code agent's other tools.
- Prompt: a short note in `codeSysPrompt` about when escalation happens (so the model understands the two-path behavior).

## Testing

- **Deterministic:** a mock-LLM test that a "complex" triage verdict routes to `plannerAgent` (observed via statelog) and a "simple" verdict stays in the direct loop; a test that calling `escalate` short-circuits the loop.
- **Real-LLM (post-merge):** a clearly-simple task stays on the direct loop (no plannerAgent overhead); a clearly-multi-part task escalates and completes; a task that looks simple but isn't triggers the escalate tool.

## Risks / open questions

- **Triage accuracy**: misrouting a complex task to the simple loop wastes the direct attempt (mitigated by the escalate fallback); misrouting a simple task to `plannerAgent` wastes a generation (mitigated by `plannerAgent`'s own route-simple check, if we keep one). Tune the classifier from benchmark data.
- **Cost of triage on every task**: one small call per task. Keep it cheap (short prompt, small model tier if available); measure the overhead.
- **Double analysis**: triage drafts a plan and `plannerAgent` also analyzes — the design passes the triage plan into `plannerAgent` as context to avoid re-deriving it. Confirm `plannerAgent` uses provided context instead of re-planning from scratch.
- **Escalate misuse**: the model may over- or under-use `escalate`. The tool docstring and prompt guidance are the levers; measure and adjust.
