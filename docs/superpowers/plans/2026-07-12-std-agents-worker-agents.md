# std::agents Worker Agents — Implementation Plan (Part 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three composable, batteries-included worker agents (`codingAgent`, `researchAgent`, `agencyCodingAgent`) as file-per-agent stdlib modules, lift the dynamic `verify` into `std::agency`, and upgrade `writeAgency`.

**Architecture:** Each agent is an independent `def` in its own file (`stdlib/agents/<name>.agency` → `std::agents/<name>`), sharing only plain helper functions. Agents run an LLM in a `thread`, use a curated tool set, and own a small verify→fix loop wrapped in a `guard(cost:, time:)` hard cap. Verification reuses the existing `Feedback` type. `plannerAgent` is deferred to Part 2.

**Tech Stack:** Agency `.agency` stdlib source; `std::agency` (`writeAgency`, `runCode`, `review`, `Feedback`, `feedbackHasErrors`, `renderFeedback`); `std::shell`/`std::fs`/`std::http`/`std::wikipedia`/`std::web/search`/`std::thread`; the `guard` primitive; the `agency test` harness.

## Global Constraints

- **Composition, not configuration.** Agents are independent `def`s combinable any way. No mandatory base, no `AgentConfig` schema, no `verifyMode` enum. Shared logic only ever as plain callable helpers.
- **Reuse `Feedback`, do not invent a type.** `type Feedback = { error: boolean; feedback: string; data?: any }` (exists in `std::agency`). Gate loops on `feedbackHasErrors(...)`; feed `renderFeedback(...)` back. No `Verdict`, no `renderGaps`, no `verifyArtifact`.
- **Every loop has a hard cap via `guard`.** Wrap each verify→fix loop in `guard(cost: maxCost, time: maxTime) as { ... }`. Exit the loop on a boolean; never a bare numeric counter. `maxCost`/`maxTime` are params with high defaults (`$50.00`, `10m`).
- **Signature convention:** `def xAgent(task: string, context: string = "", maxCost: number = $50.00, maxTime: number = 10m): <ReturnType>`.
- **Agency syntax:** `def`/`node` + `{ }`; `if`/`while`/`for` need parens AND braces; only `for (x in xs)`; no C-style `for`; no lambdas (blocks: `\x -> ...` inline or trailing `as x { }`); prefer `match` over nested `if`. Verify snippets against `docs/site/guide/basic-syntax.md`, `guards.md`, `pattern-matching.md`.
- **Templates to mirror (READ FIRST):** `lib/agents/agency-agent/subagents/verify.agency` (thread + systemMessage + `llm(task, {tools})` + `.partial(useAgentCwd: true)`), `subagents/review.agency` (how a subagent delegates to `std::agency`), `code.agency:454-505` (verify→fix loop), `docs/site/guide/guards.md` (`guard(cost:, time:) as { }`).
- **Build:** run `make` after editing stdlib `.agency`. Commit generated `docs/site/stdlib/agents/*.md` only.
- **Spec:** `docs/superpowers/specs/2026-07-12-std-agents-building-block-library-design.md`.

---

## File Structure

- **Create `stdlib/agents/coding.agency`** → `std::agents/coding` (`codingAgent`).
- **Create `stdlib/agents/research.agency`** → `std::agents/research` (`researchAgent`).
- **Create `stdlib/agents/agency.agency`** → `std::agents/agency` (`agencyCodingAgent`).
- **Modify `stdlib/agency.agency`** — add the lifted `verify(task): Result<Feedback[]>` (next to `review`); upgrade `writeSysPrompt` + the `writeAgency` retry loop.
- **Modify `lib/agents/agency-agent/subagents/verify.agency`** — delegate to `std::agency::verify`, converting to its existing `Verdict` for the unchanged `code.agency` consumer.
- **Modify the stdlib import allowlist** (`lib/importPaths.ts`; confirm via `lib/importPaths.test.ts`) so `std::agents/*` resolves (mirror how `std::web/*`, `std::ui/*` are allowed).
- **Create `tests/agency/agents/*.agency` + `.test.json`** — LLM-free wiring tests.
- **Create `tests/integration/agents/test.mjs`** — real-LLM efficacy (mirror `tests/integration/optimize-efficacy/test.mjs`).
- **Modify `.github/workflows/test-with-llm.yml`** and `package.json`.

---

### Task 1: Lift `verify` into `std::agency` (returns `Result<Feedback[]>`)

**Files:**
- Modify: `stdlib/agency.agency` (add `verify`, near `review` ~line 509)
- Modify: `lib/agents/agency-agent/subagents/verify.agency` (delegate)
- Test: `tests/agency/agents/verifyWiring.agency` + `.test.json` (LLM-free: assert `verify` is exported/typechecks)

**Interfaces:**
- Produces: `def verify(task: string): Result<Feedback[]>` in `std::agency`. Reconstructs the task's success criteria, runs the artifact, returns findings — `error: true` for unmet criteria (STRICT on output contract), `error: false` for satisfied observations. Fails open (`success([])`) on internal failure.

- [ ] **Step 1: Read** `subagents/verify.agency` (the `verify()` body + tools + prompt) and `stdlib/agency.agency:509-560` (`review`, `Feedback`, `renderFeedback`, `feedbackHasErrors`).

- [ ] **Step 2: Add `verify` to `stdlib/agency.agency`** (mirror the verify.agency two-phase pattern; second phase emits `Feedback[]` via structured output):

```ts
import { ls, glob, grep, exec } from "std::shell"
import { systemMessage } from "std::thread"

static const verifyTools: any[] = [
  read.partial(useAgentCwd: true),
  ls.partial(useAgentCwd: true),
  glob.partial(useAgentCwd: true),
  grep.partial(useAgentCwd: true),
  exec.partial(useAgentCwd: true),
]

static const verifySysPrompt = """
You verify whether a coding task was completed correctly. You do NOT fix
anything — you inspect, run, and report.

The grading tests are hidden and NOT here. Reconstruct the success check from
the task's own description and any example usage, then RUN the artifact through
it with the `exec` tool. Check the output contract STRICTLY: exact file path
and name, exact format (JSON keys, field types, units, signed-vs-unsigned, a
trailing newline), and every explicit criterion. A near-miss is an error.
"""

export def verify(task: string): Result<Feedback[]> {
  """
  Reconstruct a task's success criteria, run the produced artifact against them,
  and return findings. `error: true` = an unmet criterion; `error: false` = a
  satisfied observation. Fails open (empty success) on internal failure.

  @param task - the original task description to verify against.
  """
  let out: Result<Feedback[]> = success([])
  thread(label: "verify", summarize: true, session: "verify") {
    systemMessage(verifySysPrompt)
    const analysis: string = llm("The task was:\n\n${task}\n\nInspect the working directory, run the artifact against the task's own success criteria, and describe what passes and what fails.", { tools: verifyTools })
    const items: Feedback[] = llm("Convert this analysis into Feedback items. One item per concrete finding: error=true for an unmet criterion (name it), error=false for a satisfied one. If you cannot tell, return an empty list.\n\nAnalysis:\n${analysis}")
    out = success(items)
  }
  return out
}
```

- [ ] **Step 3: Delegate from the agent** — in `subagents/verify.agency`, replace the body of the existing `verify(...)` so it calls `std::agency::verify` and converts to the local `Verdict` its `code.agency` consumer already expects (keeps `code.agency` untouched):

```ts
import { verify as stdVerify } from "std::agency"
import { feedbackHasErrors, renderFeedback } from "std::agency"

export def verify(originalUserMsg: string): Verdict {
  const fb = stdVerify(originalUserMsg)
  const gaps = if feedbackHasErrors(fb) then [renderFeedback(fb)] else []
  return { satisfied: !feedbackHasErrors(fb), gaps: gaps }
}
```

> Confirm the import-name-shadowing warning noted in the ADAS memory: import `verify as stdVerify` to avoid clashing with the local `verify`.

- [ ] **Step 4: Wiring test** — `tests/agency/agents/verifyWiring.agency`:

```ts
import { verify } from "std::agency"
node verifyExported(): boolean { return true }
```

`.test.json` → `verifyExported` expects `"true"`.

- [ ] **Step 5: Build + run** — `cd packages/agency-lang && make && pnpm run a test tests/agency/agents/verifyWiring.agency` → PASS.

- [ ] **Step 6: Commit** ("Lift verify into std::agency returning Feedback").

---

### Task 2: Upgrade `writeAgency` (worked examples + point-of-need)

**Files:**
- Modify: `stdlib/agency.agency` (`writeSysPrompt` ~588; retry loop ~632-660)
- Test: covered by Task 7 efficacy (a task that previously produced invalid code now compiles)

- [ ] **Step 1: Read** `stdlib/agency.agency:588-660`.

- [ ] **Step 2: Append worked examples to `writeSysPrompt`:**

```ts
"""
Two complete, correct Agency programs — copy their structure (imports, the
`node main`, the explicit `return`):

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

- [ ] **Step 3: Point-of-need helper + injection** — add:

```ts
def syntaxHintFor(errors: string): string {
  if (errors =~ re/for\s*\(/ && errors =~ re/;/) {
    return "Reminder: Agency has no C-style for loop. Count with a while loop."
  }
  if (errors =~ re/main/) {
    return "Reminder: the program MUST have a node named `main` as its entry point."
  }
  return ""
}
```

In the retry re-prompt, prepend `syntaxHintFor(renderedErrors)` (when non-empty) before the diagnostics.

- [ ] **Step 4: Build** — `make 2>&1 | tail -5` → succeeds, no new errors.

- [ ] **Step 5: Commit** ("Upgrade writeAgency with worked examples and point-of-need hints").

---

### Task 3: Scaffold + register `std::agents/coding`

**Files:**
- Create: `stdlib/agents/coding.agency`
- Modify: `lib/importPaths.ts`
- Test: `tests/agency/agents/codingWiring.agency` + `.test.json`

**Interfaces:**
- Produces: `def codingAgent(task: string, context: string = "", maxCost: number = $50.00, maxTime: number = 10m): string`.

- [ ] **Step 1: Write the failing wiring test** — `tests/agency/agents/codingWiring.agency`:

```ts
import { codingAgent } from "std::agents/coding"
// Compile-time wiring only — do NOT call (would hit the LLM).
node codingAgentExported(): boolean { return true }
```

`.test.json` → `codingAgentExported` expects `"true"`.

- [ ] **Step 2: Run, expect failure** (unresolved import): `pnpm run a test tests/agency/agents/codingWiring.agency` → FAIL.

- [ ] **Step 3: Create `stdlib/agents/coding.agency`:**

```ts
/** @module
  General-purpose coding agent: reads, writes, edits, and runs code to complete
  a task, verifying the produced artifact against the task's success criteria.
*/
import { bash, ls, glob, grep } from "std::shell"
import { edit } from "std::fs"
import { systemMessage } from "std::thread"
import { verify, feedbackHasErrors, renderFeedback } from "std::agency"

static const codingTools: any[] = [
  read.partial(useAgentCwd: true),
  write.partial(useAgentCwd: true),
  edit.partial(useAgentCwd: true),
  ls.partial(useAgentCwd: true),
  glob.partial(useAgentCwd: true),
  grep.partial(useAgentCwd: true),
  bash.partial(useAgentCwd: true),
]

static const codingSysPrompt = """
You are an expert software engineer. Solve the task by writing and running real
code with your tools. Rules:
- The deliverable is a working artifact backed by real tool output, not a
  description. Actually run and exercise what you build.
- Match the output contract EXACTLY: the requested filename, path, format,
  fields, units, and trailing newline. A near-miss fails.
- NEVER fabricate output you did not actually produce.
"""

static const finalizeReminder = "Before finishing: re-read the task's exact output requirements (filename, format, fields) and confirm the artifact on disk matches them exactly."

export def codingAgent(task: string, context: string = "", maxCost: number = $50.00, maxTime: number = 10m): string {
  """
  General-purpose coding agent. Returns a short summary; the real output is
  filesystem side effects.

  @param task - what to build or fix.
  @param context - optional extra material.
  @param maxCost - hard spend cap for the whole run.
  @param maxTime - hard wall-clock cap for the whole run.
  """
  let reply = ""
  let msg = if context == "" then task else "${task}\n\n<context>\n${context}\n</context>"
  guard(cost: maxCost, time: maxTime) as {
    thread(label: "codingAgent", summarize: true, session: "coding") {
      systemMessage(codingSysPrompt)
      let done = false
      while (!done) {
        reply = llm("${msg}\n\n${finalizeReminder}", { tools: codingTools })
        const fb = verify(task)
        if (feedbackHasErrors(fb)) {
          msg = "Not done yet. A strict review found:\n\n${renderFeedback(fb)}\n\nFix each problem exactly."
        } else {
          done = true
        }
      }
    }
  }
  return reply
}
```

> The `guard` is the hard cap: if `!done` never flips, `guard` trips on cost/time and aborts the block; `reply` holds the last attempt and is returned. Confirm `guard(...) as { }` wrapping a `thread` against `docs/site/guide/guards.md`.

- [ ] **Step 4: Register the import** — add `std::agents/coding` (or the `agents/` prefix) to the stdlib allowlist in `lib/importPaths.ts`, mirroring how `web/search` / `ui/layout` are allowed. Confirm shape via `lib/importPaths.test.ts`.

- [ ] **Step 5: Build + run** — `make && pnpm run a test tests/agency/agents/codingWiring.agency` → PASS.

- [ ] **Step 6: Commit** ("Add codingAgent (std::agents/coding)").

---

### Task 4: `std::agents/research`

**Files:**
- Create: `stdlib/agents/research.agency`
- Modify: `lib/importPaths.ts` (allow `agents/research` if per-module)
- Test: `tests/agency/agents/researchWiring.agency` + `.test.json`

**Interfaces:**
- Produces: `def researchAgent(task: string, context: string = "", maxCost: number = $50.00, maxTime: number = 10m): string`.

- [ ] **Step 1: Failing wiring test** — `researchWiring.agency` importing `researchAgent` from `std::agents/research`, node returns `true`. Run → FAIL.

- [ ] **Step 2: Create `stdlib/agents/research.agency`** (verify via a grounding judge that returns `Feedback[]`, NOT the artifact-running `verify`):

```ts
/** @module
  Research agent: gathers from web/Wikipedia sources and synthesizes a cited,
  grounded answer.
*/
import { search as webSearch } from "std::web/search"
import { fetch, fetchMarkdown } from "std::http"
import { search as wikiSearch } from "std::wikipedia"
import { systemMessage } from "std::thread"
import { Feedback, feedbackHasErrors, renderFeedback } from "std::agency"

static const researchTools: any[] = [ webSearch, wikiSearch, fetchMarkdown, fetch, read.partial(useAgentCwd: true) ]

static const researchSysPrompt = """
You are a research analyst. Answer the task using your source tools. Ground every
factual claim in a cited source. If your tools cannot retrieve the needed
information, say so plainly — NEVER fabricate sources or facts.
"""

export def researchAgent(task: string, context: string = "", maxCost: number = $50.00, maxTime: number = 10m): string {
  """
  Research agent: gathers from web/Wikipedia sources and synthesizes a cited
  answer, checked for grounding and completeness.

  @param task - the research question.
  @param context - optional extra material.
  @param maxCost - hard spend cap.
  @param maxTime - hard wall-clock cap.
  """
  let answer = ""
  let msg = if context == "" then task else "${task}\n\n<context>\n${context}\n</context>"
  guard(cost: maxCost, time: maxTime) as {
    thread(label: "researchAgent", summarize: true, session: "research") {
      systemMessage(researchSysPrompt)
      let done = false
      while (!done) {
        answer = llm(msg, { tools: researchTools })
        const fb: Result<Feedback[]> = llm("Judge the answer against the task. One Feedback item per finding: error=true if a claim is ungrounded/uncited or the task is not fully answered (name it), error=false for a well-supported point. \n\nTask: ${task}\n\nAnswer:\n${answer}")
        if (feedbackHasErrors(fb)) {
          msg = "Your answer has gaps:\n\n${renderFeedback(fb)}\n\nRetrieve more and fix them."
        } else {
          done = true
        }
      }
    }
  }
  return answer
}
```

- [ ] **Step 3: Register import** (if per-module). **Step 4: Build + run** → PASS. **Step 5: Commit** ("Add researchAgent (std::agents/research)").

---

### Task 5: `std::agents/agency`

**Files:**
- Create: `stdlib/agents/agency.agency`
- Modify: `lib/importPaths.ts`
- Test: `tests/agency/agents/agencyWiring.agency` + `.test.json`

**Interfaces:**
- Consumes: `writeAgency`, `runCode`, `WriteFailure`, `verify`, `feedbackHasErrors`, `renderFeedback` from `std::agency`.
- Produces: `def agencyCodingAgent(task: string, context: string = "", maxCost: number = $50.00, maxTime: number = 10m): Result<string, WriteFailure>`.

- [ ] **Step 1: Read** `stdlib/agency.agency` `writeAgency` (612) and `runCode` (324) signatures. `runCode` success value is at `.data`.

- [ ] **Step 2: Failing wiring test** — `agencyWiring.agency`. Run → FAIL.

- [ ] **Step 3: Create `stdlib/agents/agency.agency`** (uses `match` on the `writeAgency` Result):

```ts
/** @module
  Agency-coding agent: writes an Agency program for the task, runs it, and
  verifies it does the task. Built on writeAgency + runCode + verify.
*/
import { writeAgency, runCode, verify, feedbackHasErrors, renderFeedback, WriteFailure } from "std::agency"

export def agencyCodingAgent(task: string, context: string = "", maxCost: number = $50.00, maxTime: number = 10m): Result<string, WriteFailure> {
  """
  Writes an Agency program for the task, runs it, and verifies it. Returns
  source that compiles, typechecks, and passes verification.

  @param task - what the generated program should do.
  @param context - optional extra material.
  @param maxCost - hard spend cap.
  @param maxTime - hard wall-clock cap.
  """
  let extra = context
  let result: Result<string, WriteFailure> = writeAgency(task, extra)
  guard(cost: maxCost, time: maxTime) as {
    let done = false
    while (!done) {
      match (result) {
        failure(f) => { done = true }
        success(src) => {
          const ran = try runCode(src)
          const fb = verify(task)
          if (feedbackHasErrors(fb)) {
            extra = "${context}\n\nA prior attempt had these problems; fix them:\n${renderFeedback(fb)}"
            result = writeAgency(task, extra)
          } else {
            done = true
          }
        }
      }
    }
  }
  return result
}
```

> `runCode` is wrapped in `try` so a runtime failure does not abort the agent. Confirm `match`/`try` against `docs/site/guide/pattern-matching.md` + `error-handling.md`. Note the `guard` + `#513` caveat: a paused generated program can lose the guard value — acceptable/watched for v1.

- [ ] **Step 4: Register import. Step 5: Build + run** → PASS. **Step 6: Commit** ("Add agencyCodingAgent (std::agents/agency)").

---

### Task 6: Real-LLM efficacy tests + CI wiring + docs

**Files:**
- Create: `tests/integration/agents/test.mjs`
- Modify: `.github/workflows/test-with-llm.yml`, `package.json`
- Regenerate + commit: `docs/site/stdlib/agents/*.md`

- [ ] **Step 1: Read** `tests/integration/optimize-efficacy/test.mjs` (spawn `agency`, read a result, assert, `process.exit(1)` on failure, retry transient errors once).

- [ ] **Step 2: Write `tests/integration/agents/test.mjs`** — three cases, each in a temp dir with a tiny `.agency` driver that calls the agent and prints a machine-readable line the `.mjs` parses:
  - `codingAgent`: "write ./answer.txt containing exactly `42` with a trailing newline" → assert the file matches byte-for-byte.
  - `agencyCodingAgent`: "return the sum of [1,2,3]" → assert `success` and `runCode` yields `6`.
  - `verify` strictness: seed a wrong-format file, call `verify(task)`, assert `feedbackHasErrors` is true.
  Retry transient API errors once (copy the retry logic from the template).

- [ ] **Step 3: Add script** — `package.json`: `"test:agents-efficacy": "node tests/integration/agents/test.mjs"`.

- [ ] **Step 4: Wire CI (non-blocking)** — add to `.github/workflows/test-with-llm.yml` after the existing agent tests:

```yaml
    - name: std::agents efficacy tests (real LLM)
      continue-on-error: true
      working-directory: packages/agency-lang
      env:
        OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      run: pnpm run test:agents-efficacy
```

- [ ] **Step 5: Run locally with a key** (do NOT run the full agency suite):

Run: `cd packages/agency-lang && make && pnpm run test:agents-efficacy 2>&1 | tee /tmp/agents-efficacy.log`
Expected: all three cases pass. Save the log.

- [ ] **Step 6: Regenerate docs + commit** — `make` regenerates `docs/site/stdlib/agents/*.md`. Commit modules, tests, workflow, script, docs. ("Add std::agents efficacy tests, CI wiring, and docs").

---

## Self-Review

**1. Spec coverage:** `verify` lifted to `std::agency` returning `Feedback[]`, agent delegates ✓ (Task 1). `writeAgency` upgrade ✓ (Task 2). `codingAgent` ✓ (3), `researchAgent` ✓ (4, uses `std::web/search`), `agencyCodingAgent` ✓ (5). File-per-agent + no barrel ✓. Reuse `Feedback`, no `Verdict`/`renderGaps`/`verifyArtifact` ✓. `guard`-capped loops with `maxCost`/`maxTime` params ✓. Composition constraint ✓. Two verifiers not three ✓. Worked examples + point-of-need ✓ (2, 3). Two-tier tests ✓ (wiring 1/3/4/5, efficacy 6). `plannerAgent` deferred to Part 2 ✓.

**2. Placeholder scan:** No TBD/TODO. Code in every code step. Commit messages via a temp file (Agency apostrophe convention).

**3. Type consistency:** `Feedback`/`Result<Feedback[]>` used identically in Tasks 1/3/4/5. `feedbackHasErrors`/`renderFeedback` names consistent. `codingAgent`/`researchAgent` return `string`; `agencyCodingAgent` returns `Result<string, WriteFailure>`. `verify(task): Result<Feedback[]>` consistent.

**Known risks to verify during implementation:** (a) `guard(...) as { }` wrapping a `thread` — confirm against `guards.md`; (b) lifting `verify` to `std::agency` must not create an import cycle (`std::agency` importing `std::shell`/`std::thread` — both lower-level, should be fine); (c) `import { verify as stdVerify }` shadowing warning in `verify.agency`; (d) `std::agents/*` import-allowlist shape.
