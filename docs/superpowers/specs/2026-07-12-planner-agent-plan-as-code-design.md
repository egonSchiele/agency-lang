# Design (Sub-project A): `plannerAgent` — plan-as-code in `std::agents`

**Date:** 2026-07-12
**Status:** Design (awaiting review → plan)
**Part of:** the plan-as-code initiative (A of A/B/C). Builds on the `std::agents` worker library (PR #534). Independent and testable standalone; the code-agent wiring is sub-project B.

## Motivation

Agency has a capability nothing else does: an agent can generate Agency source and run it in a **handler-sandboxed subprocess** (`writeAgency` + `runCode`), where the parent's handlers and guards govern exactly what the generated code may do. This turns "the plan" into concrete, inspectable, governed code: the agent analyzes a task, writes an agent that solves it, shows the user that agent (plan + source + capabilities), and runs it. *The agent is the plan.*

`plannerAgent` is that primitive. It is the meta-agent deferred from the `std::agents` design (Part 2), now fully specified around four decisions made in brainstorming:

1. **Escalation, not default** — the code agent calls `plannerAgent` only for complex tasks (sub-project B owns the routing). `plannerAgent` itself is always "the complex path."
2. **Explain + approve** — before running, it shows the prose plan, the generated source, and the capability envelope (`getEffects`), and asks for approval.
3. **Recursion allowed, runtime-bounded** — the generated agent may itself call `plannerAgent`; depth and spend are bounded by the runtime's existing `maxDepth` (subprocess nesting) and `maxCost` (propagates into subprocesses).
4. **Composition** — the generated agent composes the worker agents and tools; `plannerAgent` is a plain function, no config framework.

## Prior art (why this shape)

CodeAct (code-as-action beats JSON), ADAS/Meta Agent Search (a meta-agent programs agents in code), Voyager (writes code skills — its worst failure is *unsandboxed* runaway code, which Agency fixes), MAST (multi-agent failure is dominated by spec + verification gaps, so the plan spec and the post-run verify are the load-bearing parts), Agentless (machinery must earn its keep — hence escalation-only).

## Goals

- `plannerAgent(task, ...)`: analyze → generate an agent-as-plan → explain + approve → run → verify → report, with a `codingAgent` fallback so a bad generation never strands the task.
- Reuse shipped primitives: `writeAgency`, `runCode`, `getEffects`, `verify`, the worker agents.
- Bound recursion and spend via the runtime, not a hand-rolled counter.
- Emit the plan as an inspectable artifact (prose + source + effects) through an approval interrupt.

## Non-goals

- Routing / triage / escalate tool (sub-project B).
- Fixing the direct-loop `review()` crash (sub-project C).
- A pre-run effect preview on a *compiled* program — not needed; `getEffects` runs on the **source string** we already have.

## Interface

```
def plannerAgent(task: string, context: string = "", maxCost: number = $50.00, maxTime: number = 30m): string
```

Returns a short summary; the real output is the filesystem side effects of the generated agent (for build/edit tasks) or the reported result. Wrapped in `guard(cost: maxCost, time: maxTime)` like the worker agents, using the capture-and-`match` pattern.

## Flow

```
1. Draft the plan:      planText = llm("analyse the task, outline the steps")   (prose, for the user)
2. Generate the agent:  src = writeAgency(planCodePrompt(task, planText))       (an agent-as-plan)
3. Capability envelope: eff = getEffects(src)                                   (per-export effect lists)
4. Explain + approve:   interrupt plan.approve { plan: planText, source: src, effects: eff }
                        (interactive: prompt the user; one-shot: policy decides — approve-all in the sandbox)
5. Run:                 ran = runCode(src)          (subprocess; handlers gate each effect; maxDepth/maxCost bound the tree)
6. Verify:              verdict = verify(task)       (runs the produced artifact against the task criteria)
7. On gaps + budget:    regenerate with the gaps as context (capped)
8. On repeated failure: fall back to codingAgent(task)   (never strand the task)
```

### The generation prompt (`planCodePrompt`)

Instructs `writeAgency` to emit a program whose `node main` composes the available building blocks to solve the task. The generated agent's import surface (all `std::`, so `runCode`'s sandbox accepts them):

- `std::agents/coding` (`codingAgent`), `std::agents/research` (`researchAgent`), `std::agents/agency` (`agencyCodingAgent`)
- `std::shell`, `std::fs`, `std::http`, etc. (direct tools)
- `std::agents/planner` (`plannerAgent` itself) — enabling recursion (decision 3)

The prompt carries worked examples (a plan-agent that calls `codingAgent` for a build step, one that calls `researchAgent` then `codingAgent`) so the model copies the composition shape.

### The approval interrupt

A new interrupt effect, e.g. `plan.approve`, carrying `{ plan, source, effects }`. It renders for a human (prose plan first, then the source, then the effect list) and is gated like any interrupt: an interactive user approves/rejects; a policy (`approve-all` in the benchmark sandbox) auto-decides. Rejection aborts before `runCode`. This is the governance story made concrete and directly serves "explain what it plans to do."

### Recursion + governance

The generated agent may `import { plannerAgent } from "std::agents/planner"` and decompose further. Each `runCode` is a subprocess, so nesting is bounded by `run`'s `maxDepth` (default 5, hard ceiling 10, ancestor-min-wins), and `maxCost`/`maxTime` guards propagate into subprocesses. No new counter. **Open item:** `runCode` does not currently expose `maxDepth` to its caller (it inherits `run`'s default 5); surface it if we want the planner to set a tighter recursion bound.

### Verification target

`verify(task)` inspects the working directory and runs the produced artifact — correct for build/edit tasks whose deliverable is files (the Terminal-Bench shape). For tasks whose deliverable is `runCode`'s return value, judge that value (as `agencyCodingAgent` does). The plan should pick one default and note the other; `verify(task)` (disk) is the v1 default.

## Files

- Create `stdlib/agents/planner.agency` → `std::agents/planner` (`plannerAgent`).
- Reuse `std::agency` (`writeAgency`, `runCode`, `getEffects`, `verify`) and the worker modules.
- A new interrupt effect for plan approval (define where the agent's other effects live; confirm the cleanest home in the plan).

## Testing

- **Deterministic:** helper-level tests (the generation prompt builder, the fallback selection); a mock-LLM test that a rejected approval aborts before `runCode`.
- **Real-LLM (post-merge, non-blocking):** a genuinely multi-part task (e.g. "set up a git repo with two branches and a tagged commit, then verify with git log") — assert the generated agent runs and `verify` passes; a task requiring one level of recursion; a fallback case where generation fails and `codingAgent` recovers.

## Risks / open questions

- **`getEffects` on generated source**: confirm it returns useful envelopes for a program that imports the worker agents (transitive effects through `codingAgent` etc. may show as broad or `"unknown"` for bare interrupts). If too coarse, show the direct effects and note the transitive caveat.
- **`guard` + `#513`**: the generated program runs inside the planner's `guard`; a nested pause/resume can lose the guard value (known bug). Document and watch; acceptable for v1.
- **Approval fatigue**: in interactive use, every escalation prompts. Consider a policy to remember approval for a session (out of scope for v1).
- **Cost of the extra generation step**: the plan+generate is pure overhead on tasks that did not need it — which is exactly why routing (sub-project B) keeps `plannerAgent` off the simple path.
