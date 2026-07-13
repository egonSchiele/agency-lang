# Code Agent → Plan-as-Code (Triage + Escalate) — Implementation Plan (Sub-project B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `--agent code` agent route by complexity: simple tasks keep today's direct tool-loop; complex/multi-part tasks go through `plannerAgent`; and a task that looks simple but turns out hard can escalate mid-flight via an `escalate` tool.

**Architecture:** Two additions to `codeAgent` in `subagents/code.agency` — an upfront `triage` classifier that routes, and an `escalate` tool (a worker-agent-as-tool, partial-applied with the original task the same way `oracleAgent.partial(...)` already is) that switches the direct loop to `plannerAgent`. No change to the direct loop's mechanics beyond adding the tool.

**Tech Stack:** `std::agents/planner` (`plannerAgent`), the existing `codeAgent` structure (`code.agency:332` `codeTools`, `:420` `codeAgent`, `:431` `tools = [...codeTools]`). **Depends on sub-project A** (`plannerAgent`) **and C** (the fixed direct loop). Land after both, off a `main` that has them.

## Global Constraints

- **Escalation by complexity, hybrid** — triage up front + escalate tool as a mid-task fallback. The direct loop stays the default for simple tasks; do not make plan-as-code the primary path.
- **Reuse the `.partial` tool pattern** — `escalate` is a `def` added to the code agent's `tools` via `.partial(task: userMsg)`, matching `oracleAgent.partial(...)` already in `code.agency`.
- **Bias toward staying in the direct loop** — the `escalate` tool docstring (which the model reads) must say to reach for it only when the task genuinely needs a multi-step plan, mirroring the existing handoff-bias guidance.
- **Both modes** — triage and `plannerAgent`'s approval interrupt work interactive (prompt) and one-shot (policy; `approve-all` in the benchmark).
- **Agency syntax / structured-output** per the prior plans (annotate the `const` that receives `llm(...)` to drive the schema). Verify snippets with `pnpm run ast`.
- **Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-12-code-agent-plan-as-code-integration-design.md`.

## File Structure

- **Modify `packages/agency-lang/lib/agents/agency-agent/subagents/code.agency`** — add `TriageResult`, `triage`, the `escalate` tool, the routing at `codeAgent` entry, and a short escalation note in `codeSysPrompt`.
- **Extend `packages/agency-lang/tests/integration/agents/test.mjs`** — real-LLM routing tests (simple stays, complex escalates, mid-task escalate).

---

### Task 1: `triage` — the upfront classifier

**Files:** Modify `code.agency`.

**Interfaces:** `type TriageResult = { path: string; plan: string }` (`path` is `"simple"` or `"complex"`); `def triage(task: string): TriageResult`.

- [ ] **Step 1: Implement** in `code.agency` (structured output via the `const` annotation):

```ts
type TriageResult = {
  path: string;
  plan: string
}

static const triagePrompt = """Classify this coding task. If it is a single, straightforward change, set path to "simple" and leave plan empty. If it is multi-part or needs decomposition, set path to "complex" and outline the plan in 2-4 short bullets."""

def triage(task: string): TriageResult {
  const result: TriageResult = llm("${triagePrompt}\n\nTask:\n${task}")
  return result
}
```

> One cheap classify call per task. Keep the prompt short; it is pure overhead on every task, so it must stay small.

- [ ] **Step 2: ast-check + build** — `pnpm run ast lib/agents/agency-agent/subagents/code.agency`, then `make`. Expect no new errors.

- [ ] **Step 3: Commit** ("Add triage classifier to the code agent").

---

### Task 2: `escalate` tool

**Files:** Modify `code.agency`.

**Interfaces:** `def escalate(task: string, reason: string, plan: string): string` — invokes `plannerAgent`. Added to the agent's tools partial-applied with the original task, so the model supplies only `reason` + `plan`.

- [ ] **Step 1: Import** `plannerAgent` from `std::agents/planner` at the top of `code.agency`.

- [ ] **Step 2: Implement** the tool:

```ts
def escalate(task: string, reason: string, plan: string): string {
  """
  Switch this task to plan-as-code: writes and runs a purpose-built agent for a
  multi-step task, showing you the plan first. Reach for this ONLY when the
  current task genuinely needs a multi-step plan you cannot finish in a few
  direct edits. Do NOT use it for ordinary follow-ups.

  @param reason - why this task needs a multi-step plan.
  @param plan - your outline of the steps.
  """
  return plannerAgent(task, context: "${reason}\n${plan}")
}
```

> `task` is bound by `.partial` at wiring time (Task 3), so the model-facing schema shows only `reason` and `plan`. This mirrors `oracleAgent.partial(allowHandoff: false)` already in `code.agency`.

- [ ] **Step 3: Build** — `make`. Confirm `escalate` compiles and `plannerAgent` resolves.

- [ ] **Step 4: Commit** ("Add escalate tool wrapping plannerAgent").

---

### Task 3: Route in `codeAgent` — triage entry + escalate wiring

**Files:** Modify `code.agency` (`codeAgent` ~420-431; `codeSysPrompt` ~75).

- [ ] **Step 1: Route at entry.** At the top of `codeAgent`, before the direct-loop `thread`:

```ts
const decision = triage(userMsg)
if (decision.path == "complex") {
  return plannerAgent(userMsg, context: decision.plan)
}
```

Passing `decision.plan` as context means `plannerAgent` reuses the triage plan instead of re-analysing from scratch (confirm `plannerAgent` uses provided context as its plan seed; if it re-plans regardless, that is a follow-up on A).

- [ ] **Step 2: Add `escalate` to the simple path's tools.** Where `tools = [...codeTools]` is built (~431):

```ts
tools.push(escalate.partial(task: userMsg))
```

So a task triaged "simple" that turns out hard can still switch via the tool.

- [ ] **Step 3: Prompt note.** Add a short paragraph to `codeSysPrompt` explaining the two-path behavior: most tasks run directly; genuinely multi-step tasks are planned (either by triage or by calling `escalate`), and a plan is shown before it runs. This keeps the model's mental model consistent with what the harness does.

- [ ] **Step 4: Build** — `make`. Confirm the routing compiles and the direct loop is unchanged for the `"simple"` path.

- [ ] **Step 5: Commit** ("Route the code agent by complexity: triage + escalate").

---

### Task 4: Real-LLM routing tests + measurement hook

**Files:** Extend `tests/integration/agents/test.mjs`.

- [ ] **Step 1: Simple stays direct.** A clearly single-step task (`"append a line to notes.txt"`) run via `--agent code`; assert (statelog) that **no** `plannerAgent`/`planApprove` events occurred — it stayed on the direct loop.

- [ ] **Step 2: Complex escalates.** A clearly multi-part task; assert the `planApprove` interrupt was raised (triage routed to `plannerAgent`) and the deliverable is correct.

- [ ] **Step 3: Mid-task escalate.** A task phrased to look simple but requiring several coordinated steps; assert the `escalate` tool was called (statelog tool-call event) and the task completed.

- [ ] **Step 4: Measurement.** Note in the test file (and wire, if the over-time graph exists) that these routing behaviors feed the Terminal-Bench efficacy tracking, so the triage threshold and escalate-tool usage can be tuned from data.

- [ ] **Step 5: Run locally with a key** (NOT the full suite); save output. **Step 6: Commit** ("Add code-agent routing tests").

---

## Self-Review

**1. Spec coverage:** Triage routing (simple→direct, complex→`plannerAgent`) ✓ (Tasks 1,3). Escalate tool as mid-flight fallback ✓ (Tasks 2,3). Both modes ✓ (approval handled by `plannerAgent`; policy in one-shot). Direct loop unchanged for simple tasks ✓ (Task 3 only adds the tool). Triage plan reused as `plannerAgent` context to avoid double analysis ✓ (Task 3 Step 1, with the A-side confirm noted). Measurement hook ✓ (Task 4).

**2. Placeholder scan:** No requirement placeholders. Confirm-at-implementation items: that `plannerAgent` consumes provided context as its plan seed (Task 3 Step 1); the exact `codeTools`/`tools` build site line (Task 3 Step 2 — grounded at `code.agency:431`). 

**3. Type consistency:** `triage(task) -> TriageResult { path, plan }`, branched on `decision.path`. `escalate(task, reason, plan) -> string`; `.partial(task: userMsg)` leaves `(reason, plan)` in the model schema. `plannerAgent(task, context) -> string` matches both the complex-route call and the escalate call.

**Risks flagged for implementation:** triage accuracy (mis-route mitigated by the escalate fallback one way and by `plannerAgent`'s own overhead-only cost the other); triage cost on every task (keep the prompt tiny; measure); escalate over/under-use (tune via the docstring + prompt from benchmark data); confirm adding the `std::agents/planner` import to `code.agency` doesn't trip the re-export TDZ noted in that subtree.
