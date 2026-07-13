# std::agents Worker Agents — Implementation Plan (Part 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three composable, batteries-included worker agents (`codingAgent`, `researchAgent`, `agencyCodingAgent`) as file-per-agent stdlib modules, lift a fail-open dynamic `verify` into `std::agency`, and upgrade `writeAgency`.

**Architecture:** Each agent is an independent `def` in its own file (`stdlib/agents/<name>.agency` → `std::agents/<name>`), sharing plain helpers. Each runs an LLM in a `thread` with curated tools and a bounded verify→fix loop **inside** a `guard(cost:, time:)` block that *returns* the reply; the agent captures the guard's `Result` and handles the trip. Verification reuses the existing `Feedback` type. `plannerAgent` is Part 2.

**Tech Stack:** Agency `.agency` stdlib; `std::agency` (`writeAgency`, `runCode`, `review`, `Feedback`, `feedbackHasErrors`, `renderFeedback`); `std::shell`/`std::fs`/`std::http`/`std::wikipedia`/`std::web/search`/`std::thread` (`guard`, `systemMessage`); `agency test`.

## Global Constraints

- **Composition, not configuration.** Independent `def`s; no base, no config schema, no `verifyMode` enum. Shared logic only as plain callable helpers.
- **Reuse `Feedback`.** `type Feedback = { error: boolean; feedback: string; data?: any }` (in `std::agency`). Gate on `feedbackHasErrors(...)`; feed `renderFeedback(...)` back. No `Verdict`/`renderGaps`/`verifyArtifact`.
- **`guard` semantics are load-bearing** (`docs/site/guide/guards.md:28-40`): a `guard` block is a value-producing scope — *only its `return` value escapes*, and `guard(...)` yields `Result<T, GuardFailureData>`. So: **all loop state lives inside the block, the block `return`s the reply, the agent `match`es the captured `Result`**, and on a trip the in-flight reply is lost. Therefore each loop also carries a small explicit **attempt cap** for normal termination (so the reply returns via the success path); `guard` is only the cost/time backstop.
- **Signature convention:** `def xAgent(task: string, context: string = "", maxCost: number = $50.00, maxTime: number = 10m): <ReturnType>`. Trip behavior: `codingAgent`/`researchAgent` return a `"stopped: <cap> reached"` string; `agencyCodingAgent` folds the trip into a `WriteFailure`.
- **Agency syntax:** `{ }` blocks; parens+braces on `if`/`while`/`for`; only `for (x in xs)`; no C-style `for`; no lambdas; prefer `match`. **Keep binder `match` OUT of stepped `while` bodies** (`verify.agency:68-69` — the stepped-loop codegen mishandles it; hoist into a plain `def`). `guard(...) as { ... }` returns a `Result`; `try expr` yields a `Result`; `expr catch default` unwraps with a default. Verify each snippet with `pnpm run ast <file>` before committing (N5).
- **Templates (READ FIRST):** `subagents/verify.agency`, `subagents/review.agency` (delegation), `code.agency:454-505`, `docs/site/guide/guards.md`, `error-handling.md`, `pattern-matching.md`.
- **No import-allowlist work.** `importPaths.ts` gates by *kind*; stdlib resolves by path (`resolveAgencyImportPath`/`getStdlibFiles`). `std::agents/coding` resolves the moment the file exists — like `std::web/search`, which has no allowlist entry. Do NOT touch `importPaths.ts`.
- **Build:** `make` after editing stdlib `.agency`. Commit generated `docs/site/stdlib/agents/*.md` only.
- **Spec:** `docs/superpowers/specs/2026-07-12-std-agents-building-block-library-design.md`.

---

## File Structure

- Create `stdlib/agents/coding.agency` → `std::agents/coding`, `stdlib/agents/research.agency` → `std::agents/research`, `stdlib/agents/agency.agency` → `std::agents/agency`, `stdlib/agents/shared.agency` → `std::agents/shared` (the `withContext` helper).
- Modify `stdlib/agency.agency` — add `verify` + `verifyInner` + `failOpenFeedback` (near `review`); upgrade `writeSysPrompt`; add `syntaxHintFor` + wire it into the retry loop. (Do NOT re-import `guard`/`systemMessage` — already imported at line 2.)
- Modify `lib/agents/agency-agent/subagents/verify.agency` — delegate to `std::agency::verify`; delete the now-dead `verifyTools`/`verifySysPrompt`.
- Create `tests/agency/agents/*.agency` (+ `.test.json`) — pure unit tests + mock-LLM behavioral tests.
- Create `tests/integration/agents/test.mjs`; modify `.github/workflows/test-with-llm.yml`, `package.json`.

---

### Task 1: Pure helpers — `withContext`, `failOpenFeedback`, `syntaxHintFor` (no LLM)

**Files:**
- Create: `stdlib/agents/shared.agency` (`withContext`)
- Modify: `stdlib/agency.agency` (`failOpenFeedback`, `syntaxHintFor`)
- Test: `tests/agency/agents/helpers.agency` + `.test.json`

**Interfaces:**
- Produces: `def withContext(task: string, context: string): string`; `def failOpenFeedback(r: Result<Feedback[]>): Result<Feedback[]>` (passes success through, maps failure → `success([])`); `def syntaxHintFor(errors: string): string`.

- [ ] **Step 1: Write failing tests** — `tests/agency/agents/helpers.agency`:

```ts
import { withContext } from "std::agents/shared"
import { syntaxHintFor } from "std::agency"

node contextEmpty(): boolean { return withContext("do X", "") == "do X" }
node contextFilled(): boolean { return withContext("do X", "c") == "do X\n\n<context>\nc\n</context>" }
node hintForCStyleFor(): boolean { return syntaxHintFor("Parse error: for (i=0; i<3; i++)") =~ re/while loop/ }
node hintForMissingMain(): boolean { return syntaxHintFor("no node named main") =~ re/node named .main./ }
node hintForUnrelated(): boolean { return syntaxHintFor("Type error: expected string") == "" }
```

`.test.json` maps each node → `"true"` (exact).

- [ ] **Step 2: Run, expect failure** — `pnpm run a test tests/agency/agents/helpers.agency` → FAIL (symbols undefined).

- [ ] **Step 3: Implement `withContext`** in `stdlib/agents/shared.agency`:

```ts
/** @module Shared helpers for the std::agents worker agents. */

/** Fold optional context material into a task prompt. */
export def withContext(task: string, context: string): string {
  return if context == "" then task else "${task}\n\n<context>\n${context}\n</context>"
}
```

- [ ] **Step 4: Implement `failOpenFeedback` + `syntaxHintFor`** in `stdlib/agency.agency` (near `review`). Tighten the `main` match so it only fires on the missing-entry-node message, not any "main":

```ts
/** Pass a successful feedback list through; map any failure to no findings. */
export def failOpenFeedback(r: Result<Feedback[]>): Result<Feedback[]> {
  return match (r) {
    success(items) => success(items)
    failure(_) => success([])
  }
}

/** A specific syntax reminder to inject next to a typecheck error, or "". */
export def syntaxHintFor(errors: string): string {
  if (errors =~ re/for\s*\([^)]*;/) {
    return "Reminder: Agency has no C-style for loop. Count with a while loop."
  }
  if (errors =~ re/no node named .?main/) {
    return "Reminder: the program MUST have a node named `main` as its entry point."
  }
  return ""
}
```

- [ ] **Step 5: Build + run** — `make && pnpm run a test tests/agency/agents/helpers.agency` → PASS (all 5).

- [ ] **Step 6: Commit** ("Add withContext, failOpenFeedback, syntaxHintFor helpers").

---

### Task 2: Lift a fail-open `verify` into `std::agency`

**Files:**
- Modify: `stdlib/agency.agency` (add `verifyInner` + `verify`; reuse Task-1 `failOpenFeedback`; add only `{ ls, glob, grep, exec }` from `std::shell` — `guard`/`systemMessage` already imported)
- Modify: `lib/agents/agency-agent/subagents/verify.agency` (delegate; delete dead consts)
- Test: `tests/agency/agents/verifyFailOpen.agency` (deterministic, via `failOpenFeedback`) + `.test.json`

**Interfaces:**
- Produces: `def verify(task: string): Result<Feedback[]>` — reconstructs the task's success check, RUNS the artifact, returns findings (`error: true` = unmet criterion, STRICT on output contract; `error: false` = satisfied). Fails open to `success([])` if the LLM calls throw.

- [ ] **Step 1: Read** `subagents/verify.agency` and `stdlib/agency.agency:410-560`.

- [ ] **Step 2: Add `verifyInner` + `verify`** to `stdlib/agency.agency`:

```ts
import { ls, glob, grep, exec } from "std::shell"

static const verifyTools: any[] = [
  read.partial(useAgentCwd: true),
  ls.partial(useAgentCwd: true),
  glob.partial(useAgentCwd: true),
  grep.partial(useAgentCwd: true),
  exec.partial(useAgentCwd: true),
]

static const verifySysPrompt = """
You verify whether a coding task was completed correctly. You do NOT fix
anything — inspect, run, and report. The grading tests are hidden and NOT here.
Reconstruct the success check from the task's own description and any example,
then RUN the artifact with `exec`. Check the output contract STRICTLY: exact
file path/name, exact format (JSON keys, field types, units, trailing newline),
and every explicit criterion. A near-miss is an error.
"""

// Throwing inner: the two-phase inspection. `verify` wraps it fail-open.
def verifyInner(task: string): Feedback[] {
  let items: Feedback[] = []
  thread(label: "verify", summarize: true) {
    systemMessage(verifySysPrompt)
    const analysis: string = llm("The task was:\n\n${task}\n\nInspect the working directory, run the artifact against the task's own success criteria, and describe what passes and what fails.", { tools: verifyTools })
    items = llm("Convert this analysis into Feedback items — one per concrete finding: error=true for an unmet criterion (name it), error=false for a satisfied one. Empty list if you cannot tell.\n\nAnalysis:\n${analysis}")
  }
  return items
}

export def verify(task: string): Result<Feedback[]> {
  """
  Reconstruct a task's success criteria, run the produced artifact against them,
  and return findings. Fails open (empty success) if verification cannot run.

  @param task - the original task description to verify against.
  """
  return failOpenFeedback(try verifyInner(task))
}
```

> `try verifyInner(task)` catches a thrown terminal failure into a `Result`; `failOpenFeedback` maps that to `success([])`. Confirm `try` + `failOpenFeedback` compose (else use `match (try verifyInner(task)) { success(i) => success(i); failure(_) => success([]) }`).

- [ ] **Step 3: Delegate from the agent** — in `subagents/verify.agency`, keep the existing `Verdict`-returning `verify(originalUserMsg)` signature (so `code.agency` is untouched) but make its body delegate, and **delete the now-dead `verifyTools`/`verifySysPrompt`** there:

```ts
import { verify as stdVerify, feedbackHasErrors, renderFeedback } from "std::agency"

export def verify(originalUserMsg: string): Verdict {
  const fb = stdVerify(originalUserMsg)
  return {
    satisfied: !feedbackHasErrors(fb),
    gaps: if feedbackHasErrors(fb) then [renderFeedback(fb)] else []
  }
}
```

> Keep `renderGaps`/`unwrapVerdict` in `verify.agency` — `code.agency` still uses them (~499/501). Only the two consts and the old body go.

- [ ] **Step 4: Deterministic fail-open test** — `tests/agency/agents/verifyFailOpen.agency` exercises the pure `failOpenFeedback` (the LLM path is covered in Task 7):

```ts
import { failOpenFeedback } from "std::agency"

node passesSuccessThrough(): boolean {
  const r = failOpenFeedback(success([{ error: true, feedback: "x" }]))
  return feedbackHasErrors(r)
}
node failureBecomesEmpty(): boolean {
  const r = failOpenFeedback(failure("boom"))
  return !feedbackHasErrors(r)
}
```

(import `feedbackHasErrors` from `std::agency`.) `.test.json` → both `"true"`.

- [ ] **Step 5: Build + run** — `make && pnpm run a test tests/agency/agents/verifyFailOpen.agency` → PASS. Also confirm the existing agent tests still compile: `pnpm run a test lib/agents/agency-agent/tests/oneShotRounds.agency`.

- [ ] **Step 6: Commit** ("Lift fail-open verify into std::agency; delegate from agent").

---

### Task 3: Upgrade `writeAgency` (worked examples + point-of-need `syntaxHintFor`)

**Files:** Modify `stdlib/agency.agency` (`writeSysPrompt` ~588; retry loop ~632-660). Test: unit coverage of `syntaxHintFor` already in Task 1; end-to-end in Task 7.

- [ ] **Step 1: Read** `stdlib/agency.agency:588-660`.
- [ ] **Step 2: Append the two worked examples** to `writeSysPrompt` (imports, `node main`, explicit `return`):

```ts
"""
Two complete, correct Agency programs — copy their structure:

EXAMPLE 1 — compute and return a value:
import { sum } from "std::array"
node main(): number {
  const xs = [1, 2, 3]
  return sum(xs)
}

EXAMPLE 2 — call a tool and return its result:
import { bash } from "std::shell"
node main(): string {
  return bash(command: "echo hello")
}
"""
```

- [ ] **Step 3: Wire `syntaxHintFor` into the retry loop** — where diagnostics are fed back, prepend `syntaxHintFor(rendered)` when non-empty:

```ts
const hint = syntaxHintFor(rendered)
const feedbackPrompt = if hint == "" then rendered else "${hint}\n\n${rendered}"
```

- [ ] **Step 4: Build** — `make 2>&1 | tail -5` → succeeds.
- [ ] **Step 5: Commit** ("Upgrade writeAgency with worked examples and point-of-need hints").

---

### Task 4: `codingAgent` (`std::agents/coding`)

**Files:** Create `stdlib/agents/coding.agency`. Tests: `tests/agency/agents/codingLoop.agency` (mock-LLM behavioral) + `.test.json`.

**Interfaces:** `def codingAgent(task: string, context: string = "", maxCost: number = $50.00, maxTime: number = 10m): string`.

- [ ] **Step 1: Create `stdlib/agents/coding.agency`** using the corrected guard-capture pattern:

```ts
/** @module General-purpose coding agent: writes/edits/runs code and verifies
  the produced artifact against the task's success criteria. */
import { bash, ls, glob, grep } from "std::shell"
import { edit } from "std::fs"
import { systemMessage, guard } from "std::thread"
import { verify, feedbackHasErrors, renderFeedback } from "std::agency"
import { withContext } from "std::agents/shared"

static const codingTools: any[] = [
  read.partial(useAgentCwd: true), write.partial(useAgentCwd: true),
  edit.partial(useAgentCwd: true), ls.partial(useAgentCwd: true),
  glob.partial(useAgentCwd: true), grep.partial(useAgentCwd: true),
  bash.partial(useAgentCwd: true),
]
static const codingSysPrompt = """
You are an expert software engineer. Solve the task by writing and running real
code. The deliverable is a working artifact backed by real tool output, not a
description — actually run what you build. Match the output contract EXACTLY
(filename, path, format, fields, units, trailing newline); a near-miss fails.
NEVER fabricate output you did not produce.
"""
static const finalizeReminder = "Before finishing: re-read the task's exact output requirements (filename, format, fields) and confirm the artifact on disk matches them exactly."

export def codingAgent(task: string, context: string = "", maxCost: number = $50.00, maxTime: number = 10m): string {
  """General-purpose coding agent. Returns a short summary; the real output is
  filesystem side effects.
  @param task - what to build or fix.
  @param context - optional extra material.
  @param maxCost - hard spend cap.
  @param maxTime - hard wall-clock cap."""
  const captured = guard(cost: maxCost, time: maxTime) as {
    let reply = ""
    let msg = withContext(task, context)
    thread(label: "codingAgent", summarize: true) {
      systemMessage(codingSysPrompt)
      let done = false
      let attemptsLeft = 3
      while (!done && attemptsLeft > 0) {
        reply = llm("${msg}\n\n${finalizeReminder}", { tools: codingTools })
        const fb = verify(task)
        if (feedbackHasErrors(fb)) {
          msg = "Not done yet:\n\n${renderFeedback(fb)}\n\nFix each problem exactly."
          attemptsLeft = attemptsLeft - 1
        } else {
          done = true
        }
      }
    }
    return reply
  }
  return match (captured) {
    success(v) => v
    failure(e) => "Agent stopped before completing: ${e.type} cap reached."
  }
}
```

- [ ] **Step 2: Behavioral mock-LLM test** — `tests/agency/agents/codingLoop.agency`. Using the deterministic test LLM provider (see `docs/misc/TESTING.md` / `testing-llm-and-agency-js`), drive two nodes and observe via statelog:
  - `boundsWhenNeverSatisfied`: mock `verify`'s judge to always emit an `error:true` finding; assert the agent makes at most 3 tool-loop rounds (statelog `promptStart` count) and returns the last reply, not `""`.
  - `shortCircuitsWhenSatisfied`: mock the judge to emit `[]`; assert exactly one round.
  Confirm the exact mock-provider wiring during implementation (deterministic provider returns canned completions; assert via statelog since the mock can't inspect messages). `.test.json` maps both → `"true"`.

- [ ] **Step 3: Run, expect FAIL, then implement/build until PASS** — `make && pnpm run a test tests/agency/agents/codingLoop.agency`. First run the wiring compiles; iterate the mock until both behavioral assertions hold.

- [ ] **Step 4: Commit** ("Add codingAgent with bounded guard loop + behavioral test").

---

### Task 5: `researchAgent` (`std::agents/research`)

**Files:** Create `stdlib/agents/research.agency`. Test: `tests/agency/agents/researchLoop.agency` (mock-LLM) + `.test.json`.

**Interfaces:** `def researchAgent(task: string, context: string = "", maxCost: number = $50.00, maxTime: number = 10m): string`.

- [ ] **Step 1: Create `stdlib/agents/research.agency`** — note the judge emits a plain `Feedback[]` (G4), wrapped in `success(...)` before `feedbackHasErrors`/`renderFeedback`:

```ts
/** @module Research agent: gathers from web/Wikipedia sources and synthesizes a
  cited, grounded answer. */
import { search as webSearch } from "std::web/search"
import { fetch, fetchMarkdown } from "std::http"
import { search as wikiSearch } from "std::wikipedia"
import { systemMessage, guard } from "std::thread"
import { Feedback, feedbackHasErrors, renderFeedback } from "std::agency"
import { withContext } from "std::agents/shared"

static const researchTools: any[] = [ webSearch, wikiSearch, fetchMarkdown, fetch, read.partial(useAgentCwd: true) ]
static const researchSysPrompt = """
You are a research analyst. Answer the task using your source tools. Ground every
factual claim in a cited source. If your tools cannot retrieve the needed
information, say so plainly — NEVER fabricate sources or facts.
"""

export def researchAgent(task: string, context: string = "", maxCost: number = $50.00, maxTime: number = 10m): string {
  """Research agent: gathers from sources and synthesizes a cited answer.
  @param task - the research question.
  @param context - optional extra material.
  @param maxCost - hard spend cap.
  @param maxTime - hard wall-clock cap."""
  const captured = guard(cost: maxCost, time: maxTime) as {
    let answer = ""
    let msg = withContext(task, context)
    thread(label: "researchAgent", summarize: true) {
      systemMessage(researchSysPrompt)
      let done = false
      let attemptsLeft = 2
      while (!done && attemptsLeft > 0) {
        answer = llm(msg, { tools: researchTools })
        const items: Feedback[] = llm("Judge the answer against the task. One Feedback item per finding: error=true if a claim is ungrounded/uncited or the task is not fully answered (name it), error=false for a well-supported point.\n\nTask: ${task}\n\nAnswer:\n${answer}")
        const fb = success(items)
        if (feedbackHasErrors(fb)) {
          msg = "Your answer has gaps:\n\n${renderFeedback(fb)}\n\nRetrieve more and fix them."
          attemptsLeft = attemptsLeft - 1
        } else {
          done = true
        }
      }
    }
    return answer
  }
  return match (captured) {
    success(v) => v
    failure(e) => "Research stopped before completing: ${e.type} cap reached."
  }
}
```

- [ ] **Step 2: Behavioral mock-LLM test** — mirror Task 4: never-grounded judge bounds at 2 attempts; grounded judge single-pass. `.test.json` → `"true"`.
- [ ] **Step 3: Build + iterate to PASS. Step 4: Commit** ("Add researchAgent with grounding-judge loop + behavioral test").

---

### Task 6: `agencyCodingAgent` (`std::agents/agency`)

**Files:** Create `stdlib/agents/agency.agency`. Test: `tests/agency/agents/agencyLoop.agency` (mock-LLM) + `.test.json`.

**Interfaces:** `def agencyCodingAgent(task: string, context: string = "", maxCost: number = $50.00, maxTime: number = 10m): Result<string, WriteFailure>`.

- [ ] **Step 1: Read** `writeAgency` (612) + `runCode` (324; success value at `.data`).
- [ ] **Step 2: Create `stdlib/agents/agency.agency`** — verify judges `runCode`'s **actual result** (D2/N3), and the per-attempt `match` lives in a helper `def` (D3), not the loop:

```ts
/** @module Agency-coding agent: writes an Agency program, runs it, and verifies
  the result satisfies the task. */
import { writeAgency, runCode, feedbackHasErrors, renderFeedback, Feedback, WriteFailure } from "std::agency"
import { systemMessage, guard } from "std::thread"
import { withContext } from "std::agents/shared"

type AttemptOutcome = { done: boolean; feedback: string }

// One attempt: run the source, judge the ACTUAL result against the task.
// `match` is confined here, out of the stepped loop.
def judgeRun(task: string, src: string): AttemptOutcome {
  return match (try runCode(src)) {
    failure(f) => { done: false, feedback: "The program failed to run: ${f.error}" }
    success(data) => outcomeFromJudge(task, data)
  }
}

def outcomeFromJudge(task: string, data: any): AttemptOutcome {
  const items: Feedback[] = llm("Does this program's result satisfy the task? One Feedback per finding; error=true if it fails the task (name it).\n\nTask: ${task}\n\nResult: ${data}")
  const fb = success(items)
  return if feedbackHasErrors(fb) then { done: false, feedback: renderFeedback(fb) } else { done: true, feedback: "" }
}

export def agencyCodingAgent(task: string, context: string = "", maxCost: number = $50.00, maxTime: number = 10m): Result<string, WriteFailure> {
  """Writes an Agency program, runs it, and verifies its result satisfies the
  task. Returns source that compiles, typechecks, and passes verification.
  @param task - what the generated program should do.
  @param context - optional extra material.
  @param maxCost - hard spend cap.
  @param maxTime - hard wall-clock cap."""
  const captured = guard(cost: maxCost, time: maxTime) as {
    let extra = context
    let result: Result<string, WriteFailure> = writeAgency(task, extra)
    let done = false
    let attemptsLeft = 2
    while (!done && attemptsLeft > 0) {
      match (result) {
        failure(f) => { done = true }
        success(src) => {
          const outcome = judgeRun(task, src)
          if (outcome.done) {
            done = true
          } else {
            extra = "${context}\n\nA prior attempt had these problems; fix them:\n${outcome.feedback}"
            result = writeAgency(task, extra)
            attemptsLeft = attemptsLeft - 1
          }
        }
      }
    }
    return result
  }
  return match (captured) {
    success(r) => r
    failure(e) => failure({ source: "", errors: [] })
  }
}
```

> The outer `match (result)` is still inside the `while` — if the stepped-loop codegen rejects it (D3), hoist the whole body into `def stepAttempt(task, extra): { result, done, extra }` returning a record and keep the `while` binder-free. Test this first (Step 3).

- [ ] **Step 3: Behavioral mock-LLM test** — `agencyLoop.agency`: mock `writeAgency` success + a judge that fails once then passes; assert two `writeAgency` calls then done. Also a mock where `runCode` fails → outcome `done:false` with the run-error feedback. If the in-loop `match` trips codegen, apply the hoist above. `.test.json` → `"true"`.
- [ ] **Step 4: Build + iterate to PASS. Step 5: Commit** ("Add agencyCodingAgent judging runCode result + behavioral test").

---

### Task 7: Real-LLM efficacy + CI + docs

**Files:** Create `tests/integration/agents/test.mjs`; modify `.github/workflows/test-with-llm.yml`, `package.json`; regenerate `docs/site/stdlib/agents/*.md`.

- [ ] **Step 1: Read** `tests/integration/optimize-efficacy/test.mjs` (spawn `agency`, assert, `process.exit(1)`, retry transient once).
- [ ] **Step 2: Write `tests/integration/agents/test.mjs`** — five cases, each a temp dir + tiny `.agency` driver printing a machine-readable line:
  - `codingAgent` **loop-forcing** (T5): "write `./data.json` containing exactly `{"count":3}` with **no trailing newline** and keys in that exact order" — a contract models often miss first pass, so the verify→fix loop must fire. Assert the file matches byte-for-byte.
  - `agencyCodingAgent` (D2): "return the sum of [1,2,3]" — assert `success` and that re-running the returned source yields `6` (checks the result, not disk).
  - `verify` strictness **both polarities** (T4): seed a wrong-format file → `feedbackHasErrors == true`; seed a correct file → `feedbackHasErrors == false`.
  - `researchAgent` (T3): a Wikipedia-answerable question ("What year was the Eiffel Tower completed?") → assert the answer contains `1889` and a citation marker.
  - `writeAgency` regression: a task that previously produced C-style `for` → assert it now compiles.
  Retry transient API errors once. `researchAgent` case: if the web-search backend is unavailable, log a SKIP (not a failure).
- [ ] **Step 3: `package.json`** — `"test:agents-efficacy": "node tests/integration/agents/test.mjs"`.
- [ ] **Step 4: CI (non-blocking)** — add to `.github/workflows/test-with-llm.yml`:

```yaml
    - name: std::agents efficacy tests (real LLM)
      continue-on-error: true
      working-directory: packages/agency-lang
      env:
        OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      run: pnpm run test:agents-efficacy
```

- [ ] **Step 5: Run locally with a key** (NOT the full agency suite): `cd packages/agency-lang && make && pnpm run test:agents-efficacy 2>&1 | tee /tmp/agents-efficacy.log`. Save the log.
- [ ] **Step 6: Regenerate docs + commit** — `make` regenerates `docs/site/stdlib/agents/*.md`. Commit modules, tests, workflow, script, docs. ("Add std::agents efficacy tests, CI wiring, and docs").

---

## Self-Review

**1. Spec coverage:** fail-open `verify` lifted + delegated ✓ (T2, G3). `writeAgency` upgrade ✓ (T3). Three agents ✓ (T4/5/6). File-per-agent, resolve-by-path, **no allowlist work** ✓ (D1). Reuse `Feedback` ✓. Correct `guard` capture + trip handling + attempt cap ✓ (G1/G2). `researchAgent` judge emits `Feedback[]` ✓ (G4). `agencyCodingAgent` judges `runCode` result, `match` hoisted ✓ (D2/D3/N3). `withContext` extracted ✓ (D4). Behavioral + polarity + loop-forcing + research tests ✓ (T1–T5). No re-import / dead-code removal / `session:` dropped ✓ (N1/N2/N4). `ast`-check-before-commit ✓ (N5). `plannerAgent` → Part 2.

**2. Placeholder scan:** No TBD/TODO. Every code step shows code. Commit messages via temp file (apostrophe convention). The one explicitly-flagged unknown is the mock-LLM wiring mechanism (Tasks 4-6 Step 2) — the *intent and assertions* are concrete; only the provider-wiring detail is confirmed against `testing-llm-and-agency-js` during implementation.

**3. Type consistency:** `Feedback`/`Result<Feedback[]>` uniform; `feedbackHasErrors`/`renderFeedback`/`failOpenFeedback`/`withContext`/`syntaxHintFor` names consistent across tasks. `codingAgent`/`researchAgent` → `string` (trip → string); `agencyCodingAgent` → `Result<string, WriteFailure>` (trip → `WriteFailure`). `guard(...)` → `Result` captured and `match`ed in all three (G1/G2). `AttemptOutcome` defined and used only in Task 6.

**Risks to verify against the compiler first (N5):** (a) `guard(...) as { ... return x }` wrapping a `thread` and yielding a matchable `Result`; (b) `try verifyInner(task)` composing with `failOpenFeedback`; (c) `match (result)` inside the `while` in Task 6 (hoist if codegen rejects); (d) object-literal `match` arms (`AttemptOutcome`) — confirm against `pattern-matching.md`.
