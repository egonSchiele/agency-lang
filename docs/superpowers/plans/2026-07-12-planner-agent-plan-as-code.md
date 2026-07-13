# `plannerAgent` — Plan-as-Code Primitive — Implementation Plan (Sub-project A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `plannerAgent` in `std::agents/planner`: given a task, draft a plan (or use a seed plan), generate an agent-as-code, explain it (plan + source + effect envelope) and get approval, run it in a handler-sandboxed subprocess, verify, and fall back to `codingAgent` on failure.

**Architecture:** A composable `def` built on shipped primitives — `writeAgency`, `getEffects`, `runCode`, `verify`, the `std::agents` workers, and `std::agents/shared` (`withContext`, and a new `unwrapGuard`). The retry loop mirrors `agencyCodingAgent`'s proven `StepState` shape (no `match` in the stepped loop). Approval is a real interrupt whose **reject halts+fails** (interrupts.md:137), so the gate is `try`-wrapped: a rejected plan never reaches `runCode`.

**Tech Stack:** `std::agency` (`writeAgency`, `runCode`, `getEffects: Result<EffectsByExport>`, `verify`, `WriteFailure`, `EffectsByExport`), `std::agents/coding`|`research`|`agency`|`shared`, `std::thread` (`guard`), a new `std::agents::planApprove` interrupt. **Depends on the `std::agents` PR (#534)** merged; implement off updated `main`.

## Global Constraints

- **Composition, not configuration.** Plain function; the generated agent composes the workers. No config schema.
- **Everything the generated agent imports is `std::`** (`runCode`'s sandbox requires it; the workers live in `std::agents/*`).
- **Explain before running.** Raise `planApprove` with `{plan, source, effects}` *before* `runCode`. **Reject halts+returns failure** — `try`-wrap the gate; a failure means "rejected, do not run."
- **Handle `runCode`'s failure** — a subprocess crash/compile-failure is a `failure` Result; never fall through to `verify` on it (mirror `agencyCodingAgent.judgeRun`).
- **Recursion is runtime-bounded, and that path is now safety-critical.** The generated agent may `import { plannerAgent }`; each `runCode` is a subprocess capped by `run`'s `maxDepth` (5, ceiling 10, ancestor-tightest-wins; enforced in `lib/runtime/ipc.ts`) with `maxCost`/`maxTime` counting subprocess spend. Because the recursing code is LLM-authored, the depth-cap + cost-propagation is the only backstop against a fork-bomb — treat it as safety-critical.
- **DRY the shared shapes.** Use `withContext` (not raw concat) and `unwrapGuard` (the guard-trip→string helper), not inlined copies.
- **`guard` scoping / lambdas / `match`-out-of-stepped-loops / escape `\${` in prompt consts** — per the Part-1 worker plans. Verify snippets with `pnpm run ast`.
- **Defaults:** `maxCost = $100.00`, `maxTime = 60m`. Attempt cap is a named constant `PLANNER_MAX_ATTEMPTS = 2`.
- **Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-12-planner-agent-plan-as-code-design.md`.

## File Structure

- **Modify `packages/agency-lang/stdlib/agents/shared.agency`** — add `unwrapGuard(r: Result<string, GuardFailureData>, label: string): string` (extracted from the workers' inlined trip strings).
- **Create `packages/agency-lang/stdlib/agents/planner.agency`** → `std::agents/planner`: `planApprove` effect, pure `planCodePrompt`/`renderEffects`, `requestApproval`, the `PlanState` retry helpers, and `plannerAgent`.
- **Create deterministic tests** under `packages/agency-lang/tests/agency/agents/`: `plannerHelpers` (pure) and `plannerFlow` (mock-LLM + reject-handler + guard-trip).
- **Extend `packages/agency-lang/tests/integration/agents/test.mjs`** — real-LLM efficacy (multi-part, recursion, fallback smoke).

---

### Task 1: `unwrapGuard` (shared) + retrofit the workers

**Files:** Modify `stdlib/agents/shared.agency`; optionally the three workers; test `tests/agency/agents/unwrapGuard.agency`.

**Interfaces:** `def unwrapGuard(r: Result<string, GuardFailureData>, label: string): string` — `success(v) => v`; `failure(e) => "${label} stopped before completing: ${e.type} cap reached."`.

- [ ] **Step 1: Failing test** — assert `unwrapGuard(success("ok"), "X") == "ok"` and `unwrapGuard(failure({type:"timeoutFailure", ...}), "X") =~ re/X stopped/`. (Import `GuardFailureData` from `std::thread`; if it is not exported, define the minimal shape or accept `any`.)
- [ ] **Step 2: Implement** in `shared.agency`. `GuardFailureData` = `{ type, maxCost?, actualCost?, maxTime?, actualTime? }` (guards.md).
- [ ] **Step 3: Retrofit** `codingAgent`/`researchAgent` to `return unwrapGuard(captured, "Coding"|"Research")` in place of their inlined `failure(e) => "…"` arms (DRY; `agencyCodingAgent` keeps its `Result` return). Build; run the existing worker wiring tests.
- [ ] **Step 4: Commit** ("Add unwrapGuard helper; DRY worker guard-trip strings").

---

### Task 2: Pure helpers — `planCodePrompt` and `renderEffects`

**Files:** Create `stdlib/agents/planner.agency` (helpers only); test `tests/agency/agents/plannerHelpers.agency` + `.test.json`.

**Interfaces:** `def planCodePrompt(task, planText): string`; `def renderEffects(effects: Result<EffectsByExport>): string`.

- [ ] **Step 1: Failing tests** — these must **vary their inputs** and exercise the **failure/`unknown`** branches (per review T1/T2/T6). Import `EffectsByExport` from `std::agency`:

```ts
import { planCodePrompt, renderEffects } from "std::agents/planner"
import { EffectsByExport } from "std::agency"

node weavesTaskAndPlan(): boolean {
  const p = planCodePrompt("BUILD_XYZ", "STEP_ABC")
  return p =~ re/BUILD_XYZ/ && p =~ re/STEP_ABC/
}
node listsAllWorkers(): boolean {
  const p = planCodePrompt("t", "s")
  return p =~ re/std::agents\/coding/ && p =~ re/std::agents\/research/ && p =~ re/std::agents\/agency/ && p =~ re/std::agents\/planner/
}
node renderEffectsListsExports(): boolean {
  const eff: Result<EffectsByExport> = success({ main: ["std::read", "std::run"] })
  return renderEffects(eff) =~ re/main/ && renderEffects(eff) =~ re/std::run/
}
node renderEffectsKeepsUnknown(): boolean {
  const eff: Result<EffectsByExport> = success({ main: ["unknown"] })
  return renderEffects(eff) =~ re/unknown/
}
node renderEffectsFailureIsHonest(): boolean {
  const eff: Result<EffectsByExport> = failure("boom")
  return renderEffects(eff) =~ re/could not/
}
```

`.test.json` → all `"true"`.

- [ ] **Step 2: Run, expect failure** → FAIL.

- [ ] **Step 3: Implement.** `planCodePrompt` interpolates `task` and `planText` into the `writeAgency` instruction, lists the importable surface (`std::agents/coding`, `/research`, `/agency`, **`/planner`** — the recursion seam), and embeds worked composition examples. `renderEffects`: `success` → lines per export (preserving `"unknown"`); `failure` → `"(capabilities could not be computed)"`. **Escape literal `\${` in embedded example code.**

- [ ] **Step 4: Build + run** → PASS. **Step 5: Commit** ("Add planCodePrompt and renderEffects helpers").

---

### Task 3: The `planApprove` interrupt + `requestApproval`

**Files:** Modify `stdlib/agents/planner.agency`.

**Interfaces:** `effect std::agents::planApprove { plan: string; source: string; effects: string }`; `def requestApproval(plan, source, effects)` — raises it. **On reject it halts+fails; callers `try` it.**

- [ ] **Step 1: Implement** (field separator `;` matches multi-line `std::run`; `pnpm run ast` settles it):

```ts
effect std::agents::planApprove {
  plan: string;
  source: string;
  effects: string
}

/** Show the plan, generated source, and capability envelope, and pause for
  approval. Interactive: prompts. One-shot: the CLI policy decides (approve-all
  in the sandbox). REJECT halts execution and returns a failure (interrupts.md),
  so the caller `try`s this and treats a failure as "not approved". */
def requestApproval(plan: string, source: string, effects: string) {
  interrupt std::agents::planApprove(
    "Approve this plan before running it?",
    { plan: plan, source: source, effects: effects },
  )
}
```

> Confirm the default interactive handler renders `plan`, then `source`, then `effects` legibly; if not, `print` them before the interrupt.

- [ ] **Step 2: Build** — `make`. **Step 3: Commit** ("Add plan-approval interrupt").

---

### Task 4: `plannerAgent` — the flow (StepState shape, `try`-gated, runCode-handled)

**Files:** Modify `stdlib/agents/planner.agency`.

**Interfaces:** `def plannerAgent(task: string, context: string = "", plan: string = "", maxCost: number = $100.00, maxTime: number = 60m): string`. The new `plan` param is a **seed**: when non-empty, skip the analysis `llm` and use it (so sub-project B's triage plan is not re-derived — review B/D1).

- [ ] **Step 1: Implement** with helper `def`s so no binder-`match` sits in the stepped loop (mirror `agencyCodingAgent`'s `StepState`/`stepOnce`). Concrete shape:

```ts
static const PLANNER_MAX_ATTEMPTS = 2

type PlanState = { summary: string; done: boolean; extra: string }

// One attempt: generate -> approve -> run -> verify. `match` confined here.
def planStep(task: string, planText: string, state: PlanState): PlanState {
  const gen = writeAgency(planCodePrompt(task, planText), state.extra)
  return match (gen) {
    failure(_) => fallbackState(task, state)          // generation failed -> fall back
    success(src) => runApproved(task, src, state)
  }
}

def runApproved(task: string, src: string, state: PlanState): PlanState {
  const eff = getEffects(src)
  const gate = try requestApproval("(plan)", src, renderEffects(eff))
  return match (gate) {
    failure(_) => { summary: "Plan rejected; nothing was run.", done: true, extra: state.extra }
    success(_) => afterRun(task, src, state)
  }
}

def afterRun(task: string, src: string, state: PlanState): PlanState {
  return match (runCode(src)) {                        // review C1: handle run failure
    failure(err) => regenState(state, "The generated agent failed to run: ${err}")
    success(_) => judgeAfterRun(task, state)
  }
}

def judgeAfterRun(task: string, state: PlanState): PlanState {
  const fb = verify(task)
  return if feedbackHasErrors(fb) then regenState(state, renderFeedback(fb)) else { summary: "Done.", done: true, extra: state.extra }
}
```

(`fallbackState` runs `codingAgent(task)` and marks done; `regenState` folds the gap text into `extra` and leaves `done=false`.) `plannerAgent` then:

```ts
export def plannerAgent(task, context = "", plan = "", maxCost = $100.00, maxTime = 60m): string {
  const captured = guard(cost: maxCost, time: maxTime) as {
    const planText = if plan == "" then llm("Analyse and outline the steps:\n${withContext(task, context)}") else plan
    let state: PlanState = { summary: "", done: false, extra: withContext(task, context) }
    let attemptsLeft = PLANNER_MAX_ATTEMPTS
    while (!state.done && attemptsLeft > 0) {
      state = planStep(task, planText, state)
      attemptsLeft = attemptsLeft - 1
    }
    return state.summary
  }
  return unwrapGuard(captured, "Planner")
}
```

- [ ] **Step 2: cwd + cost notes (review C2).** The generated agent runs in a subprocess; `verify(task)` inspects the **parent** cwd. Confirm `runCode` runs the child in the parent cwd (fork inherits cwd — verify against `run`'s `cwd` default) so both `verify` and the Task-5 git assertions see the child's writes; thread `cwd` through if not. Cost: the outer `guard(cost:)` already counts subprocess spend, so the tree is bounded without passing `maxCost` to `runCode` — the "propagates" wording is now "the outer guard bounds the whole tree." (Passing a remaining-budget `maxCost` to `runCode` is optional defense-in-depth.)

- [ ] **Step 3: ast-check + build** — `pnpm run ast stdlib/agents/planner.agency`, then `make`. Diff errors vs baseline. Watch the guard-block-returns-matchable-`Result`, `try`-gate, and binder-`match`-in-helpers-not-loop shapes.

- [ ] **Step 4: Commit** ("Add plannerAgent flow: try-gated approval, runCode-handled, StepState retry").

---

### Task 5: Deterministic flow tests (the safety invariants)

**Files:** Create `tests/agency/agents/plannerFlow.agency` + `.test.json`.

These pin the invariants that must not rely on a paid/flaky LLM (review T3/T4/T5). Use the deterministic test LLM provider (`AGENCY_USE_TEST_LLM_PROVIDER`, canned completions) so `writeAgency`/the analysis `llm` return a fixed trivial program, plus explicit interrupt handlers, observing via statelog.

- [ ] **Step 1: Reject blocks the run.** Drive `plannerAgent` under a handler that **rejects** `planApprove`; assert (statelog) that **no `std::run` effect fired** and the return contains "rejected". This is the untested safety path *and* pins the C4 reject semantics.
- [ ] **Step 2: Approval precedes run.** Under a handler that approves, assert the `planApprove` event appears **before** the `std::run` event in the statelog.
- [ ] **Step 3: Guard trip.** Call with a tiny `maxCost` (as `tests/agency/guards`/`subprocess/*` do); assert the return is the `unwrapGuard` trip string, not a throw.
- [ ] **Step 4: Build + run** → PASS. **Step 5: Commit** ("Add deterministic plannerAgent flow tests").

---

### Task 6: Real-LLM efficacy (multi-part, recursion, fallback)

**Files:** Extend `tests/integration/agents/test.mjs`.

- [ ] **Step 1: Multi-part** — the git-repo task (`with approve`, small caps); assert (statelog) `planApprove` precedes `std::run`, `verify` ran, and the on-disk git state is correct.
- [ ] **Step 2: Recursion (spec case)** — a task that forces one `plannerAgent`-inside-generated-agent level; assert two nested `std::run` effects (depth 2) via statelog. (Review T2 — the spec asks for this and it is the headline risk A1.)
- [ ] **Step 3: Confirm the gate-effect label (review T3)** — verify the statelog event name `runCode`/`run` actually raises (`std::run`) so Steps 1-2 and the Task-5 assertions target the real label.
- [ ] **Step 4: Fallback** — real-LLM smoke only; the *assertion* of the fallback path lives in a deterministic Task-5-style test (force two `verify` failures via the test provider), not this coin-flip.
- [ ] **Step 5: Run locally with a key** (NOT the full suite); save output. **Step 6: Commit** ("Add plannerAgent efficacy tests").

---

## Self-Review

**1. Spec coverage:** analyze/seed → generate → explain+approve → run → verify → fallback ✓ (Tasks 2-4). Approval shows plan+source+effects, **reject blocks the run** ✓ (Tasks 3-5, C4 pinned). `runCode` failure handled ✓ (Task 4, C1). Recursion runtime-bounded, **flagged safety-critical**, with the `runCode`-`maxDepth`-exposure follow-up filed and a live recursion test (Task 6, A1/T2). Composition + `withContext` + `unwrapGuard` reuse ✓ (Tasks 1,4). `getEffects` on the source string ✓. Deterministic safety-invariant tests ✓ (Task 5).

**2. Placeholder scan:** No requirement placeholders. Confirm-at-implementation items, each with a fallback: interactive render of the approval data (Task 3); `runCode` child cwd vs parent (Task 4 Step 2 — **now listed**, per review minor); the effect-field separator (Task 3, `ast` settles); `GuardFailureData` export (Task 1).

**3. Type consistency:** `getEffects → Result<EffectsByExport>` → `renderEffects`; `writeAgency → Result<string, WriteFailure>` (`success(src)`, `src` is the source string) → `getEffects`/`runCode`; `plannerAgent → string` (trip via `unwrapGuard`). `PlanState { summary, done, extra }` used only in the helper family. New `plan` seed param is `string` (default `""`).

**Owner decision to confirm (review A1):** this plan lets generated agents recurse (Part-2 spec decision 3), reversing Part-1's *structural* one-level bound in favor of the runtime `maxDepth`. That was a conscious brainstorming choice (recursion wanted, runtime-bounded — your `maxDepth` point), and Task 6 Step 2 exercises it; flagging it here so the reversal is explicit, not silent.
