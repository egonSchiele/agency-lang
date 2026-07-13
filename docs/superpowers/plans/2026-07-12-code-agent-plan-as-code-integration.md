# Code Agent → Plan-as-Code (Triage + Escalate) — Implementation Plan (Sub-project B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `--agent code` agent route by complexity: simple tasks keep the direct tool-loop; complex tasks delegate to `plannerAgent` (seeded with the triage plan); and a task that looks simple but turns out hard can escalate mid-flight via an `escalate` tool.

**Architecture:** Two additions to `codeAgent` in `subagents/code.agency` — an upfront `triage` classifier with a **pure `routeFor` decision** (deterministically testable), and an `escalate` tool (partial-applied with the task, like `oracleAgent.partial(...)`). Both the complex route and `escalate` pass a **bounded** budget to `plannerAgent` so one escalation can't authorize its full $100 default.

**Tech Stack:** `std::agents/planner` (`plannerAgent`, now with a `plan` seed param — sub-project A), the existing `codeAgent` structure (`code.agency:332` `codeTools`, `:370` `oracleAgent.partial`, `:420` `codeAgent`, `:431` `tools = [...codeTools]`, `:434` `tools.push(handoff.partial(...))`). **Depends on A** (`plannerAgent`) **and C** (fixed direct loop). Land after both, off a `main` that has them.

## Global Constraints

- **Escalation by complexity, hybrid** — triage up front + escalate tool as fallback. Direct loop stays the default; do not make plan-as-code primary.
- **Reuse the `.partial` pattern** — `escalate.partial(task: userMsg)` (mirrors `oracleAgent.partial`).
- **Bound the escalation budget** — the complex route and `escalate` pass explicit caps (`ESCALATE_MAX_COST = $20.00`, `ESCALATE_MAX_TIME = 15m`), not `plannerAgent`'s $100/60m defaults, so a single escalation can't blow the enclosing run's budget.
- **Seed the plan, don't re-derive it** — pass `decision.plan` to `plannerAgent(..., plan: decision.plan)` (A's seed param), so the complex path does not pay for two planning passes.
- **Delegate-and-continue, not switch** — `escalate` is an ordinary tool that returns `plannerAgent`'s result; the direct loop keeps going after it. The tool docstring must tell the model: after escalating, **report the result — do not redo the work** the sub-agent already did.
- **`path` is a union**, `"simple" | "complex"` — constrains the structured-output schema and makes routing total.
- **Agency syntax / structured-output-by-annotation** per the prior plans. Verify snippets with `pnpm run ast`.
- **Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-12-code-agent-plan-as-code-integration-design.md`.

## File Structure

- **Modify `packages/agency-lang/lib/agents/agency-agent/subagents/code.agency`** — add `TriageResult` (union `path`), `triage`, pure `routeFor`, the `escalate` tool + caps, the routing at `codeAgent` entry, and a `codeSysPrompt` note.
- **Create `tests/agency/agents/routing.agency` + `.test.json`** — deterministic `routeFor` tests.
- **Extend `tests/integration/agents/test.mjs`** — real-LLM routing (tracked as metrics, not hard gates).

---

### Task 1: `TriageResult` (union) + `triage` + pure `routeFor`

**Files:** Modify `code.agency`; test `tests/agency/agents/routing.agency` + `.test.json`.

**Interfaces:** `type TriageResult = { path: "simple" | "complex"; plan: string }`; `def triage(task: string): TriageResult` (llm); `def routeFor(decision: TriageResult): string` (pure: `"planner"` or `"direct"`).

- [ ] **Step 1: Failing test** for the **pure** router (routing logic tested without the classifier — review T1):

```ts
import { routeFor } from "../../../lib/agents/agency-agent/subagents/code.agency"

node complexRoutesToPlanner(): boolean {
  return routeFor({ path: "complex", plan: "x" }) == "planner"
}
node simpleRoutesToDirect(): boolean {
  return routeFor({ path: "simple", plan: "" }) == "direct"
}
```

`.test.json` → both `"true"`. (Confirm the `../` import depth; the type must be exported for the test to construct it.)

- [ ] **Step 2: Run, expect failure** → FAIL.

- [ ] **Step 3: Implement** in `code.agency` — union `path`, structured-output triage, pure router:

```ts
type TriageResult = {
  path: "simple" | "complex";
  plan: string
}

static const triagePrompt = """Classify this coding task. If it is a single, straightforward change, set path to "simple" and leave plan empty. If it is multi-part or needs decomposition, set path to "complex" and outline the plan in 2-4 short bullets."""

def triage(task: string): TriageResult {
  const result: TriageResult = llm("${triagePrompt}\n\nTask:\n${task}")
  return result
}

/** Pure routing decision, testable without the classifier. */
export def routeFor(decision: TriageResult): string {
  return if decision.path == "complex" then "planner" else "direct"
}
```

> The union `path` both constrains the schema (the model can't return `"medium"`) and makes `routeFor` total. Keep `triagePrompt` tiny — it taxes every task (review D4).

- [ ] **Step 4: Build + run** → PASS. **Step 5: Commit** ("Add triage classifier with union path + pure routeFor").

---

### Task 2: `escalate` tool (bounded budget)

**Files:** Modify `code.agency`.

**Interfaces:** `def escalate(task: string, reason: string, plan: string): string` — calls `plannerAgent` with the escalation caps and the model's plan as seed.

- [ ] **Step 1: Import** `plannerAgent` from `std::agents/planner`; add the caps:

```ts
static const ESCALATE_MAX_COST = $20.00
static const ESCALATE_MAX_TIME = 15m
```

- [ ] **Step 2: Implement**:

```ts
def escalate(task: string, reason: string, plan: string): string {
  """
  Switch this task to plan-as-code: writes and runs a purpose-built agent for a
  multi-step task, showing you the plan first. Reach for this ONLY when the task
  genuinely needs a multi-step plan you cannot finish in a few direct edits. Do
  NOT use it for ordinary follow-ups. After it returns, REPORT its result — do
  not redo the work it already did.

  @param reason - why this task needs a multi-step plan.
  @param plan - your outline of the steps.
  """
  return plannerAgent(task, context: reason, plan: plan, maxCost: ESCALATE_MAX_COST, maxTime: ESCALATE_MAX_TIME)
}
```

> `task` is bound by `.partial` at wiring time (Task 3); the model schema shows only `reason`, `plan`. `plan` is passed as `plannerAgent`'s **seed** so it isn't re-analysed. The docstring's "report, don't redo" line addresses the delegate-and-continue semantics (review D3): the loop continues after `escalate` returns.

- [ ] **Step 3: Build** — `make`. **Step 4: Commit** ("Add escalate tool with bounded budget").

---

### Task 3: Route in `codeAgent`

**Files:** Modify `code.agency` (`codeAgent` ~420-431; `codeSysPrompt` ~75).

- [ ] **Step 1: Route at entry** — triage, then the pure decision, delegating with a bounded budget and the seed plan:

```ts
const decision = triage(userMsg)
if (routeFor(decision) == "planner") {
  return plannerAgent(userMsg, context: "", plan: decision.plan, maxCost: ESCALATE_MAX_COST, maxTime: ESCALATE_MAX_TIME)
}
```

> `triage`'s `llm()` runs before the `thread(label: "code")` block, i.e. outside the code thread (review C3) — fine for a stateless classify, and it keeps triage out of the code thread's history; confirm token attribution against `tests/agency/threads/no-thread.agency`. The early `return` bypasses the direct loop's `formatPrompt` response-shaping (review C2) — confirm `plannerAgent`'s summary is already caller-ready, or run it through the same formatting for route parity.

- [ ] **Step 2: Add `escalate` to the simple path** where `tools = [...codeTools]` (~431):

```ts
tools.push(escalate.partial(task: userMsg))
```

- [ ] **Step 3: Prompt note** — add a short `codeSysPrompt` paragraph: most tasks run directly; genuinely multi-step tasks are planned (via triage or by calling `escalate`), a plan is shown before it runs, and after an `escalate` the model should report the result rather than redo it.

- [ ] **Step 4: Build** — `make`. Confirm the direct loop is unchanged for `"simple"`; confirm adding the `std::agents/planner` import doesn't trip the re-export TDZ.

- [ ] **Step 5: Commit** ("Route the code agent by complexity: triage + escalate").

---

### Task 4: Real-LLM routing metrics + escalate-schema check

**Files:** Extend `tests/integration/agents/test.mjs`.

Routing accuracy is a **tunable, tracked as metrics — not a hard gate** (review T3): a single mis-classification must not red the build. Log mis-routes so the triage threshold / docstring can be tuned from the Terminal-Bench feed.

- [ ] **Step 1: Simple stays direct** (metric) — a clearly single-step task; record whether any `plannerAgent`/`planApprove` event fired (expect none).
- [ ] **Step 2: Complex escalates** (metric) — a multi-part task; record whether `planApprove` fired and the deliverable is correct.
- [ ] **Step 3: Mid-task escalate** (metric) — a task phrased to look simple but needing coordination; record whether the `escalate` tool was called.
- [ ] **Step 4: Escalate schema (deterministic, review T2)** — assert the registered `escalate` tool's parameters are exactly `reason` + `plan` (task bound away by `.partial`). This is the headline wiring and silently breaks; a small deterministic check guards it.
- [ ] **Step 5: Measurement wiring** — note (and wire, if the over-time graph exists) that these routing metrics feed the Terminal-Bench tracking so triage-on vs escalate-only (review D4) can be compared from data.
- [ ] **Step 6: Run locally with a key** (NOT the full suite); save output. **Step 7: Commit** ("Add code-agent routing metrics + escalate-schema check").

---

## Self-Review

**1. Spec coverage:** Triage routing (`routeFor`) ✓ (Tasks 1,3). Escalate as mid-flight fallback, delegate-and-continue with "report don't redo" guidance ✓ (Tasks 2,3; review D3). Both modes ✓. Direct loop unchanged for simple ✓ (Task 3). **Triage plan actually reused** via A's `plan` seed param ✓ (Tasks 2,3; review D1 fixed — no longer a hollow claim). **Escalation budget bounded** ✓ (caps; review C1). `path` union ✓ (Task 1; review D2). Deterministic routing-logic + escalate-schema tests ✓ (Tasks 1,4; review T1/T2). Routing accuracy tracked, not gated ✓ (Task 4; review T3).

**2. Placeholder scan:** No requirement placeholders. Confirm-at-implementation items, each noted with intent: `triage` `llm` outside the code thread (Task 3 Step 1); complex-route formatting parity (Task 3 Step 1); `../` import depth + `TriageResult` export for the test (Task 1); re-export TDZ on the new import (Task 3 Step 4).

**3. Type consistency:** `triage(task) -> TriageResult { path: "simple"|"complex", plan }`; `routeFor(TriageResult) -> string` branched on. `escalate(task, reason, plan) -> string`; `.partial(task: userMsg)` leaves `(reason, plan)`. `plannerAgent(task, context, plan, maxCost, maxTime) -> string` matches both the complex-route and escalate calls, with the seed `plan` and bounded caps.

**Cross-plan dependency made explicit:** this plan requires sub-project A's `plannerAgent` to accept the `plan` seed param (A Task 4) and the `ESCALATE_MAX_COST/TIME` caps to take effect (A honors `maxCost`/`maxTime`). If A ships without the seed param, fall back to `context: decision.plan` and drop the "avoids double analysis" claim (review D1 option b).
