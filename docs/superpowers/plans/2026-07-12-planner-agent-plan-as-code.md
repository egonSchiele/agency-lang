# `plannerAgent` — Plan-as-Code Primitive — Implementation Plan (Sub-project A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `plannerAgent` in `std::agents/planner`: given a task, draft a plan, generate an agent-as-code, explain it (plan + source + effect envelope) and get approval, run it in a handler-sandboxed subprocess, verify, and fall back to `codingAgent` on failure.

**Architecture:** A composable `def` built entirely on shipped primitives — `writeAgency`, `getEffects`, `runCode`, `verify`, and the `std::agents` worker agents. The generated agent imports the workers *and* `plannerAgent` (recursion bounded by the runtime's subprocess `maxDepth` + propagated `maxCost`). An approval interrupt renders the plan/source/effects before anything runs. Wrapped in `guard(cost, time)` using the capture-and-`match` pattern from the worker agents.

**Tech Stack:** `std::agency` (`writeAgency`, `runCode`, `getEffects: Result<EffectsByExport>`, `verify`), `std::agents/coding`|`research`|`agency`, `std::thread` (`guard`), a new plan-approval interrupt effect. **Depends on the `std::agents` PR (#534)** being merged. Implement off updated `main`.

## Global Constraints

- **Composition, not configuration.** `plannerAgent` is a plain function; the generated agent composes the worker agents. No config schema.
- **Everything the generated agent can reach is a `std::` import** — `runCode`'s sandbox only accepts standard-library imports, and the workers live in `std::agents/*`, so they qualify.
- **Explain before running.** Raise the approval interrupt with `{plan, source, effects}` *before* `runCode`. Reject → do not run.
- **Recursion is runtime-bounded**, not hand-counted: each `runCode` is a subprocess; nesting is capped by `run`'s `maxDepth` (default 5, ceiling 10, ancestor-min-wins) and `maxCost`/`maxTime` propagate into subprocesses.
- **Never strand the task.** Generation/verification failure within budget → fall back to `codingAgent(task)`.
- **`guard` scoping** (from the worker-agent work): all loop state inside the block, the block `return`s the value, the agent captures and `match`es the `Result`; defined trip behavior.
- **Agency syntax / lambdas / `match`** per the worker-agent plans. Verify snippets with `pnpm run ast`.
- **Defaults:** `maxCost = $100.00`, `maxTime = 60m` (planner fans out into a tree, so higher than the workers' $50/30m).
- **Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-12-planner-agent-plan-as-code-design.md`.

## File Structure

- **Create `packages/agency-lang/stdlib/agents/planner.agency`** → `std::agents/planner` (`plannerAgent`, the plan-approval effect, and pure helpers `planCodePrompt`, `renderEffects`).
- **Create deterministic tests** under `packages/agency-lang/tests/agency/agents/`: `planCodePrompt` (pure builder) and `renderEffects` (pure).
- **Extend `packages/agency-lang/tests/integration/agents/test.mjs`** — real-LLM efficacy: a multi-part task; a fallback case.

---

### Task 1: Pure helpers — `planCodePrompt` and `renderEffects`

**Files:** Create `stdlib/agents/planner.agency` (helpers only for now); test `tests/agency/agents/plannerHelpers.agency` + `.test.json`.

**Interfaces:**
- `def planCodePrompt(task: string, planText: string): string` — the `writeAgency` instruction: emit a program whose `node main` composes the worker agents/tools to accomplish `task`, following `planText`. Carries the list of importable building blocks and 1–2 worked composition examples.
- `def renderEffects(effects: Result<EffectsByExport>): string` — human-readable capability list for the approval prompt (e.g. `main: std::read, std::write, std::run`), or a note when effects can't be computed.

- [ ] **Step 1: Failing tests** — `tests/agency/agents/plannerHelpers.agency`:

```ts
import { planCodePrompt, renderEffects } from "std::agents/planner"

node promptMentionsWorkers(): boolean {
  const p = planCodePrompt("build a thing", "1. do X")
  return p =~ re/std::agents\/coding/ && p =~ re/node main/
}
node renderEffectsListsExports(): boolean {
  const eff: Result<EffectsByExport> = success({ main: ["std::read", "std::run"] })
  const s = renderEffects(eff)
  return s =~ re/main/ && s =~ re/std::run/
}
```

`.test.json` → both `"true"`.

- [ ] **Step 2: Run, expect failure** → FAIL.

- [ ] **Step 3: Implement** the two helpers in `planner.agency`. `planCodePrompt` embeds the importable surface (`std::agents/coding`, `/research`, `/agency`, `/planner`; `std::shell`/`std::fs`/`std::http`) and worked examples (a plan-agent that calls `codingAgent` for a build step; one that calls `researchAgent` then `codingAgent`). `renderEffects` maps the `EffectsByExport` record to lines; on `failure`, returns `"(capabilities could not be computed)"`.

> Escape any literal `${...}` in the embedded example code as `\${` — a triple-quoted prompt const interpolates at module init otherwise (the module-init crash caught in the std::agents work).

- [ ] **Step 4: Build + run** — `make && pnpm run a test tests/agency/agents/plannerHelpers.agency` → PASS.

- [ ] **Step 5: Commit** ("Add planCodePrompt and renderEffects helpers").

---

### Task 2: The plan-approval interrupt

**Files:** Modify `stdlib/agents/planner.agency`.

**Interfaces:** an effect `std::agents::planApprove { plan: string; source: string; effects: string }` and a `def requestApproval(plan, source, effects): boolean` that raises it and returns whether to proceed.

- [ ] **Step 1: Read** the interrupt/effect pattern in `stdlib/git.agency` (`effect std::git::status { … }` + `return interrupt std::git::status("…", { … })`) and `docs/site/guide/interrupts.md` / `handlers.md` for the **approve/reject return semantics** — specifically what a rejected interrupt yields to the caller (return value vs. abort). Record it; the fallback path depends on it.

- [ ] **Step 2: Implement**:

```ts
effect std::agents::planApprove {
  plan: string;
  source: string;
  effects: string
}

/** Show the plan, generated source, and capability envelope, and return whether
  to run it. Interactive: prompts the user. One-shot: the CLI policy decides
  (approve-all in the benchmark sandbox). */
def requestApproval(plan: string, source: string, effects: string): boolean {
  return interrupt std::agents::planApprove(
    "Approve this plan before running it?",
    { plan: plan, source: source, effects: effects },
  )
}
```

> Adjust the return handling to the Step-1 semantics: if rejection aborts rather than returns `false`, wrap in `try` and treat the failure as "not approved." Confirm the default interactive handler renders `plan`, then `source`, then `effects` legibly; if not, `print` them before the interrupt.

- [ ] **Step 3: Build** — `make`; confirm the effect compiles and, under `--policy approve-all`, is auto-approved (smoke in Task 4).

- [ ] **Step 4: Commit** ("Add plan-approval interrupt").

---

### Task 3: `plannerAgent` — the flow

**Files:** Modify `stdlib/agents/planner.agency`.

**Interfaces:** `def plannerAgent(task: string, context: string = "", maxCost: number = $100.00, maxTime: number = 60m): string`.

- [ ] **Step 1: Implement** the flow, wrapped in the guard-capture pattern. Sketch (mirror the worker agents' guard/`match` shape; hoist any binder-`match` out of loops into helper `def`s):

```
plannerAgent(task, context, maxCost, maxTime):
  captured = guard(cost: maxCost, time: maxTime) as:
    planText = llm("Analyse this task and outline the steps: ${task}\n${context}")   # prose plan
    result = generateRunVerify(task, planText, context, maxAttempts=2)               # see below
    return result
  match captured:
    success(v) => v
    failure(e) => "Planner stopped: ${e.type} cap reached."
```

`generateRunVerify` (a helper `def`, keeping `match` out of the stepped loop):

```
1. src = writeAgency(planCodePrompt(task, planText), context)     # agent-as-plan (Result<string,WriteFailure>)
   on failure -> fall back to codingAgent(task, context)
2. eff = getEffects(src.value)
3. if (!requestApproval(planText, src.value, renderEffects(eff))) -> return "Plan rejected by user."
4. ran = runCode(src.value)                                       # subprocess; handlers gate; maxDepth/maxCost bound
5. verdict = verify(task)                                         # runs the produced artifact vs criteria
   satisfied -> return a short summary
   gaps + attempts left -> regenerate: planText/context += gaps ; goto 1
   exhausted -> fall back to codingAgent(task, context)
```

- [ ] **Step 2: ast-check + build** — `pnpm run ast stdlib/agents/planner.agency`, then `make`. Diff errors vs baseline; expect none new. Watch for: `guard`-wrapping-a-block returning a matchable `Result`; `runCode`/`writeAgency` results bound to `const`s before use (interrupt-in-object-value safety); binder-`match` hoisted out of the loop.

- [ ] **Step 3: Commit** ("Add plannerAgent flow").

---

### Task 4: Real-LLM efficacy + recursion-bound note

**Files:** Extend `tests/integration/agents/test.mjs`; a driver fixture.

- [ ] **Step 1: Multi-part efficacy case.** Driver calls `plannerAgent("Initialise a git repo here, create branches feature-a and feature-b, and make one commit on each; then verify with git log", maxCost: $5.00, maxTime: 6m) with approve` in a temp dir. Assert (statelog): the `planApprove` interrupt was raised **before** the `std::run` interrupt (approval precedes execution), and `verify` ran ≥ 1. Assert the git state (two branches, commits) on disk.

- [ ] **Step 2: Fallback case.** A task where generation is likely to fail verification twice; assert the result is non-empty and the transcript shows a `codingAgent` fallback ran (statelog thread label).

- [ ] **Step 3: Recursion bound.** Document in the module doc comment that recursion depth is bounded by `run`'s `maxDepth` (planner does not set it; `runCode` inherits the default 5). **Open follow-up (out of scope here):** expose `maxDepth` on `runCode` so the planner can set a tighter bound; file it, do not build it in this plan.

- [ ] **Step 4: Run locally with a key** (NOT the full suite); save output. **Step 5: Commit** ("Add plannerAgent efficacy tests").

---

## Self-Review

**1. Spec coverage:** analyze → generate → explain+approve → run → verify → fallback ✓ (Tasks 1-3). Approval shows plan + source + effects ✓ (Tasks 1-2). Recursion via runtime `maxDepth`/`maxCost`, no counter ✓ (Task 3-4, with the `runCode`-`maxDepth`-exposure follow-up filed). Composition (generated agent imports workers + planner) ✓ (Task 1 prompt). `guard` capture + trip handling ✓ (Task 3). `getEffects` on the source string (not a compiled program) ✓.

**2. Placeholder scan:** No requirement placeholders. Explicit confirm-at-implementation items: the interrupt approve/reject **return semantics** (Task 2 Step 1 — with a `try` fallback if it aborts), the default interactive **render** of the approval data, and whether `getEffects` over worker-composing source is legible (Task 1 `renderEffects` handles the `failure`/coarse case). Each has a stated fallback.

**3. Type consistency:** `getEffects` → `Result<EffectsByExport>` (`Record<string, string[]>`) consumed by `renderEffects`. `writeAgency` → `Result<string, WriteFailure>` (`.value` is the source string) fed to `getEffects`/`runCode`. `plannerAgent` returns `string` (trip → string; matches the worker agents' shape). The `planApprove` effect fields are all `string` (effects pre-rendered via `renderEffects`).

**Risks flagged for implementation:** interrupt reject semantics (Task 2); `getEffects` legibility over worker-composing source — transitive effects through `codingAgent` may be coarse or `"unknown"` (render best-effort); `guard` + `#513` nested-pause when the generated program pauses (documented, watched); the extra generation step is pure overhead on tasks that didn't need it — which is why sub-project B keeps `plannerAgent` off the simple path.
