# std::agents Worker Agents — Implementation Plan (Part 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `std::agents` with three batteries-included, composable worker agents (`codingAgent`, `researchAgent`, `agencyCodingAgent`) plus a shared `verifyArtifact` helper, and upgrade `writeAgency` for reliability.

**Architecture:** A new stdlib module `stdlib/agents.agency` whose agents are independent, composable `def`s that share only plain helper functions (never a config schema or base shape). Each agent runs an LLM in a `thread`, uses a curated tool set, and owns a small verify→fix loop. Reliability comes from worked examples in prompts plus point-of-need guidance injection. `plannerAgent` (the meta-agent) is deliberately deferred to Part 2.

**Tech Stack:** Agency language (`.agency` stdlib source), the `std::agency` ADAS primitives (`writeAgency`, `runCode`, `review`), `std::shell`/`std::fs`/`std::http`/`std::wikipedia`/`std::thread`, the `agency test` harness.

## Global Constraints

- **Composition, not configuration.** Agents are independent `def`s combinable in any way (by hand, inside each other, inside generated agents). No mandatory base, no `AgentConfig` schema, no `verifyMode` enum. Shared logic is only ever a plain callable helper. (Copied verbatim as a hard constraint from the spec.)
- **Minimal signatures.** Public agent signature is `def xAgent(task: string, context: string = ""): <ReturnType>`. Caps (`maxRounds`, `maxCost`) stay internal constants, not parameters. Rationale: LLM callers configure poorly.
- **Agency syntax:** `def`/`node` with `{ }` blocks; `if`/`while`/`for` require parens AND braces; only `for (x in xs)`; no C-style `for`; no lambdas (blocks only); declare with `let`/`const`; a runnable program needs a `node main`. Verify snippets against `docs/site/guide/basic-syntax.md`.
- **Template files to mirror (READ THESE FIRST):** `lib/agents/agency-agent/subagents/verify.agency` (the exact stdlib-agent pattern: `thread` + `systemMessage` + `llm(task, {tools})` + `.partial(useAgentCwd: true)` tools + fail-open `Result` unwrap), and `lib/agents/agency-agent/subagents/code.agency` lines 454-505 (the verify→fix loop shape).
- **Build:** run `make` (NOT `pnpm run build`) after editing stdlib `.agency` files. Generated docs regenerate via `make`; commit `docs/site/stdlib/agents.md` only.
- **Spec:** `docs/superpowers/specs/2026-07-12-std-agents-building-block-library-design.md`.

---

## File Structure

- **Create `stdlib/agents.agency`** — the module. Contains, top to bottom: the `Verdict` type; `renderGaps`; `verifyArtifact`; the worked-example consts + system-prompt consts + tool-list consts; `codingAgent`; `researchAgent`; `agencyCodingAgent`. One module, but each agent is self-contained and independently readable.
- **Modify `stdlib/agency.agency`** — upgrade `writeSysPrompt` (worked examples + point-of-need typecheck-error injection in the `writeAgency` retry loop).
- **Modify the stdlib import allowlist** (`lib/importPaths.ts` — confirm exact list location via its tests `lib/importPaths.test.ts`) so `std::agents` is an allowed stdlib import.
- **Create `tests/agency/agents/`** — Agency execution tests for pure logic (`renderGaps`), which need no LLM.
- **Create `tests/integration/agents/test.mjs`** — real-LLM efficacy tests (mirrors `tests/integration/optimize-efficacy/test.mjs`), wired into `.github/workflows/test-with-llm.yml`.
- **Modify `.github/workflows/test-with-llm.yml`** — add a non-blocking efficacy step.

---

### Task 1: Scaffold and register the `std::agents` module

**Files:**
- Create: `stdlib/agents.agency`
- Modify: `lib/importPaths.ts` (allowlist; confirm via `lib/importPaths.test.ts`)
- Test: `tests/agency/agents/smoke.agency` + `tests/agency/agents/smoke.test.json`

**Interfaces:**
- Produces: an importable module `std::agents` exporting a trivial `def agentsModuleReady(): boolean`.

- [ ] **Step 1: Write the failing test** — `tests/agency/agents/smoke.agency`:

```ts
import { agentsModuleReady } from "std::agents"

node moduleImports(): boolean {
  return agentsModuleReady()
}
```

And `tests/agency/agents/smoke.test.json`:

```json
{
  "sourceFile": "smoke.agency",
  "tests": [
    { "nodeName": "moduleImports", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] }
  ]
}
```

- [ ] **Step 2: Run it, expect failure** (module does not exist / import not allowed):

Run: `cd packages/agency-lang && pnpm run a test tests/agency/agents/smoke.agency`
Expected: FAIL — unresolved import `std::agents` or import-not-allowed.

- [ ] **Step 3: Create the module** — `stdlib/agents.agency`:

```ts
/** @module
  Building-block agents: composable, batteries-included agent primitives
  (coding, research, Agency-coding) plus the shared verifyArtifact helper.
*/

export def agentsModuleReady(): boolean {
  return true
}
```

- [ ] **Step 4: Register the import** — add `"agents"` to the stdlib allowlist in `lib/importPaths.ts`. Confirm the exact structure by reading `lib/importPaths.test.ts` (it asserts `isImportAllowed("fs", { allowKinds: ["stdlib"] })`); add an equivalent allowance for `"agents"`.

- [ ] **Step 5: Build and run the test**

Run: `cd packages/agency-lang && make && pnpm run a test tests/agency/agents/smoke.agency`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add stdlib/agents.agency lib/importPaths.ts tests/agency/agents/smoke.agency tests/agency/agents/smoke.test.json
git commit -F <msgfile>   # "Scaffold and register std::agents module"
```

---

### Task 2: `Verdict` type + `renderGaps` helper (pure, no LLM)

**Files:**
- Modify: `stdlib/agents.agency`
- Test: `tests/agency/agents/renderGaps.agency` + `.test.json`

**Interfaces:**
- Produces: `type Verdict = { satisfied: boolean; gaps: string[] }` and `def renderGaps(gaps: string[]): string` (renders a bullet list, one `- ` per gap, newline-joined). Mirrors `verify.agency:renderGaps`.

- [ ] **Step 1: Write the failing test** — `tests/agency/agents/renderGaps.agency`:

```ts
import { renderGaps } from "std::agents"

node rendersBullets(): boolean {
  return renderGaps(["a", "b"]) == "- a\n- b"
}

node rendersEmpty(): boolean {
  return renderGaps([]) == ""
}
```

`.test.json`:

```json
{
  "sourceFile": "renderGaps.agency",
  "tests": [
    { "nodeName": "rendersBullets", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "rendersEmpty", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] }
  ]
}
```

- [ ] **Step 2: Run it, expect failure** (`renderGaps` not exported):

Run: `cd packages/agency-lang && pnpm run a test tests/agency/agents/renderGaps.agency`
Expected: FAIL.

- [ ] **Step 3: Implement** — add to `stdlib/agents.agency` (import `map` and `join` as `verify.agency` does):

```ts
import { map } from "std::array"

/** The result of verifying an agent's work against a task. */
export type Verdict = {
  satisfied: boolean;
  gaps: string[]
}

export def renderGaps(gaps: string[]): string {
  return map(gaps, \g -> "- ${g}").join("\n")
}
```

- [ ] **Step 4: Build and run** — `make && pnpm run a test tests/agency/agents/renderGaps.agency` → Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -F <msgfile>` ("Add Verdict type and renderGaps helper").

---

### Task 3: `verifyArtifact(task)` — the shared verifier

**Files:**
- Modify: `stdlib/agents.agency`
- Test: `tests/integration/agents/test.mjs` (real-LLM, added in Task 8; a manual smoke here)

**Interfaces:**
- Produces: `def verifyArtifact(task: string): Verdict`. Adapted almost verbatim from `verify.agency:verify` — a two-phase `thread`: (1) tool-enabled inspection producing a text analysis, (2) a no-tool `llm` call converting the analysis to a `Verdict` via structured output. Fails open (returns `{ satisfied: true, gaps: [...] }`) on any failure.

- [ ] **Step 1: Read the template** — `lib/agents/agency-agent/subagents/verify.agency` in full. `verifyArtifact` is that `verify()` function relocated into `std::agents`, minus the `first`/systemMessage-once gating (a fresh thread each call is fine here).

- [ ] **Step 2: Implement** — add to `stdlib/agents.agency` (mirror verify.agency exactly for the tool list, prompt, and two-phase llm calls):

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
You verify whether a coding task was actually completed correctly. You do NOT
fix anything — you inspect, run, and report.

The grading tests are hidden and NOT in this environment. Reconstruct the
success check from the task's own description and any example usage, then RUN
the artifact through it: apply the regex, execute the program, run the example,
curl the endpoint, query the db. Use the `exec` tool to run programs.

Check the output contract STRICTLY: the exact required file path and name, the
exact format (JSON keys, field types, units, signed-vs-unsigned, a trailing
newline), and every explicit criterion in the request. A near-miss on the
output contract is NOT satisfied.
"""

export def verifyArtifact(task: string): Verdict {
  """
  Reconstruct a task's success criteria, run the produced artifact against
  them, and return a strict Verdict. Fails open (satisfied=true) on any
  internal failure so verification never blocks.

  @param task - the original task description to verify against.
  """
  let result: Verdict = { satisfied: true, gaps: [] }
  thread(label: "verifyArtifact", summarize: true, session: "verify") {
    systemMessage(verifySysPrompt)
    const inspect = "The coding task to verify was:\n\n${task}\n\nInspect the working directory, run the artifact against the task's own success criteria, and determine whether it is complete and correct."
    const analysis: string = llm(inspect, { tools: verifyTools })
    const parsed: Verdict = llm("Convert this verification analysis into the structured verdict. List only concrete, actionable gaps. If you cannot tell, return satisfied=true with no gaps.\n\nAnalysis:\n${analysis}")
    result = parsed
  }
  return result
}
```

> Note the deliberate spec deviation from `verify.agency`: the prompt says checks are **STRICT** on the output contract (not "lean toward satisfied"), because output-contract near-misses are the dominant failure. Still fails open on internal *errors*, but does not rubber-stamp near-misses.

- [ ] **Step 3: Manual smoke** — create a scratch program that writes a wrong-format file, call `verifyArtifact`, confirm `satisfied == false` with a gap naming the format. (Formalized as a real-LLM test in Task 8.)

Run: `cd packages/agency-lang && make && pnpm run a <scratch>.agency`
Expected: prints a Verdict with `satisfied: false`.

- [ ] **Step 4: Commit** — ("Add verifyArtifact shared verifier").

---

### Task 4: Upgrade `writeAgency` (worked examples + point-of-need injection)

**Files:**
- Modify: `stdlib/agency.agency` (`writeSysPrompt` around line 588; the retry loop in `writeAgency` around lines 632-660)
- Test: `tests/integration/agents/test.mjs` (Task 8) — a task that previously produced invalid code now compiles.

**Interfaces:**
- Consumes: nothing new. Produces: same `writeAgency` signature; better output.

- [ ] **Step 1: Read** `stdlib/agency.agency:588-660` (current `writeSysPrompt` and the `writeAgency` retry loop that feeds `typeCheckFeedback` back).

- [ ] **Step 2: Add worked examples** — extend `writeSysPrompt` with 2 complete, typechecked programs as an appended block. Keep the existing rules; add:

```ts
// appended to writeSysPrompt:
"""
Here are two complete, correct Agency programs. Copy their structure — the
imports, the `node main`, and the explicit `return`.

EXAMPLE 1 — compute and return a value:
import { sum } from "std::array"
node main(): number {
  const xs = [1, 2, 3]
  return sum(xs)
}

EXAMPLE 2 — call a tool and return its result:
import { bash } from "std::shell"
node main(): string {
  const out = bash(command: "echo hello")
  return out
}
"""
```

- [ ] **Step 3: Point-of-need injection in the retry loop** — where the loop currently feeds typecheck diagnostics back, prepend the *specific* rule matched to the error text. Add a small pure helper in `stdlib/agency.agency`:

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

Then in the retry re-prompt, if `syntaxHintFor(renderedErrors) != ""`, put that hint line first, before the diagnostics.

- [ ] **Step 4: Build** — `make`. Confirm `stdlib/agency.agency` still typechecks and the stdlib compiles.

Run: `cd packages/agency-lang && make 2>&1 | tail -5`
Expected: build succeeds; no new errors.

- [ ] **Step 5: Commit** — ("Upgrade writeAgency with worked examples and point-of-need hints").

---

### Task 5: `codingAgent(task, context)`

**Files:**
- Modify: `stdlib/agents.agency`
- Test: `tests/agency/agents/codingWiring.agency` (deterministic wiring) + real-LLM in Task 8

**Interfaces:**
- Consumes: `verifyArtifact`, `renderGaps` (Tasks 2-3).
- Produces: `def codingAgent(task: string, context: string = ""): string`.

- [ ] **Step 1: Add tools + prompt consts** — in `stdlib/agents.agency` (import `edit` from `std::fs`; `bash` from `std::shell`; `read`/`write` are prelude):

```ts
import { bash } from "std::shell"
import { edit } from "std::fs"

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
  description. Actually run/exercise what you build.
- Match the output contract EXACTLY: the requested filename, path, format,
  fields, units, and trailing newline. A near-miss fails.
- NEVER fabricate output you did not actually produce.
"""

// point-of-need reminder, injected before the model finalizes:
static const codingFinalizeReminder = "Before you finish: re-read the task's exact output requirements (filename, format, fields). Confirm the artifact on disk matches them exactly."
```

- [ ] **Step 2: Implement the agent** — mirror `code.agency:454-505` loop shape; verify with `verifyArtifact`, cap at 2 rounds:

```ts
export def codingAgent(task: string, context: string = ""): string {
  """
  General-purpose coding agent: reads, writes, edits, and runs code to complete
  a task, then verifies the produced artifact against the task's success
  criteria. Returns a short summary; the real output is filesystem side effects.

  @param task - what to build or fix.
  @param context - optional extra material.
  """
  let reply = ""
  let msg = if context == "" then task else "${task}\n\n<context>\n${context}\n</context>"
  let rounds = 0
  thread(label: "codingAgent", summarize: true, session: "coding") {
    systemMessage(codingSysPrompt)
    let done = false
    while (!done && rounds <= 2) {
      reply = llm("${msg}\n\n${codingFinalizeReminder}", { tools: codingTools })
      const verdict = verifyArtifact(task)
      if (verdict.satisfied) {
        done = true
      } else {
        msg = "Not done yet. A strict review found these gaps:\n\n${renderGaps(verdict.gaps)}\n\nFix each gap exactly."
        rounds = rounds + 1
      }
    }
  }
  return reply
}
```

- [ ] **Step 3: Wiring test** (deterministic) — `tests/agency/agents/codingWiring.agency`: import `codingAgent` and assert it is callable/typechecks by referencing it in a node that returns a boolean without invoking the LLM (e.g. a node that checks the module exports resolve). Keep it LLM-free.

```ts
import { codingAgent } from "std::agents"
// Compile-time wiring check: referencing the symbol proves it is exported and
// typechecks. Do NOT call it here (would hit the LLM).
node codingAgentExported(): boolean {
  return true
}
```

`.test.json` with `codingAgentExported` → `"true"`.

- [ ] **Step 4: Build + run wiring test** — `make && pnpm run a test tests/agency/agents/codingWiring.agency` → PASS.

- [ ] **Step 5: Commit** — ("Add codingAgent").

---

### Task 6: `researchAgent(task, context)`

**Files:**
- Modify: `stdlib/agents.agency`
- Test: `tests/agency/agents/researchWiring.agency` + real-LLM in Task 8

**Interfaces:**
- Produces: `def researchAgent(task: string, context: string = ""): string`.

- [ ] **Step 1: Tools + prompt** — import `fetch`, `fetchMarkdown` from `std::http` and `search` from `std::wikipedia`. Build `researchTools`. Prompt instructs: gather from sources, cite them, synthesize; if no source tool succeeds, say so rather than fabricating.

```ts
import { fetch, fetchMarkdown } from "std::http"
import { search } from "std::wikipedia"

static const researchTools: any[] = [ search, fetchMarkdown, fetch, read.partial(useAgentCwd: true) ]

static const researchSysPrompt = """
You are a research analyst. Answer the task using your source tools (web fetch,
Wikipedia search). Ground every factual claim in a source and cite it. If your
tools cannot retrieve the needed information, say so plainly — NEVER fabricate
sources or facts.
"""
```

- [ ] **Step 2: Implement** — a `thread` that runs the tool-enabled `llm`, then a second grounding/completeness `llm` judge (returns a `Verdict`); one fix round. Structure mirrors `codingAgent` but the check is the grounding judge, not `verifyArtifact`:

```ts
static const researchJudgePrompt = "Judge the answer below against the task. Is every claim grounded in a cited source, and is the task fully answered? Return satisfied=false with concrete gaps if not.\n\nTask: ${task}\n\nAnswer:\n${answer}"

export def researchAgent(task: string, context: string = ""): string {
  """
  Research agent: gathers from web/Wikipedia sources and synthesizes a cited
  answer, checked for grounding and completeness.

  @param task - the research question.
  @param context - optional extra material.
  """
  let answer = ""
  let msg = if context == "" then task else "${task}\n\n<context>\n${context}\n</context>"
  let rounds = 0
  thread(label: "researchAgent", summarize: true, session: "research") {
    systemMessage(researchSysPrompt)
    let done = false
    while (!done && rounds <= 1) {
      answer = llm(msg, { tools: researchTools })
      const verdict: Verdict = llm("Judge the answer below against the task. Is every claim grounded in a cited source, and is the task fully answered? Return satisfied=false with concrete gaps if not.\n\nTask: ${task}\n\nAnswer:\n${answer}")
      if (verdict.satisfied) {
        done = true
      } else {
        msg = "Your answer has gaps:\n\n${renderGaps(verdict.gaps)}\n\nRetrieve more and fix them."
        rounds = rounds + 1
      }
    }
  }
  return answer
}
```

- [ ] **Step 3: Wiring test** — `researchWiring.agency` (LLM-free export check, same shape as Task 5 Step 3).

- [ ] **Step 4: Build + run** → PASS.

- [ ] **Step 5: Commit** — ("Add researchAgent").

---

### Task 7: `agencyCodingAgent(task, context)`

**Files:**
- Modify: `stdlib/agents.agency`
- Test: `tests/agency/agents/agencyCodingWiring.agency` + real-LLM in Task 8

**Interfaces:**
- Consumes: `writeAgency`, `runCode`, `WriteFailure` from `std::agency` (existing); `verifyArtifact`.
- Produces: `def agencyCodingAgent(task: string, context: string = ""): Result<string, WriteFailure>`.

- [ ] **Step 1: Read** `stdlib/agency.agency` `writeAgency` (line 612) and `runCode` (line 324) signatures and return shapes (`runCode` returns `.data` on success per the ADAS-primitives notes).

- [ ] **Step 2: Implement** — generate via the upgraded `writeAgency`; on success, `runCode` it and `verifyArtifact`; on gaps, re-generate with the gaps as `context`, capped:

```ts
import { writeAgency, runCode } from "std::agency"

export def agencyCodingAgent(task: string, context: string = ""): Result<string, WriteFailure> {
  """
  Writes an Agency program for the task, runs it, and verifies it does the task.
  Returns source that compiles, typechecks, and passes verification.

  @param task - what the generated program should do.
  @param context - optional extra material.
  """
  let extra = context
  let last: Result<string, WriteFailure> = writeAgency(task, extra)
  let rounds = 0
  while (rounds <= 1) {
    match (last) {
      failure(f) => { return last }
      success(src) => {
        const ran = try runCode(src)
        const verdict = verifyArtifact(task)
        if (verdict.satisfied) {
          return last
        }
        extra = "${context}\n\nA prior attempt had these gaps; fix them:\n${renderGaps(verdict.gaps)}"
        last = writeAgency(task, extra)
        rounds = rounds + 1
      }
    }
  }
  return last
}
```

> Confirm `match`/`try` usage against `docs/site/guide/pattern-matching.md` and `error-handling.md`; `runCode` is wrapped in `try` because a runtime failure must not abort the agent.

- [ ] **Step 3: Wiring test** — `agencyCodingWiring.agency` (LLM-free export check).

- [ ] **Step 4: Build + run** → PASS.

- [ ] **Step 5: Commit** — ("Add agencyCodingAgent").

---

### Task 8: Real-LLM efficacy tests + CI wiring + docs

**Files:**
- Create: `tests/integration/agents/test.mjs` (+ any fixtures)
- Modify: `.github/workflows/test-with-llm.yml`
- Modify: `package.json` (add `test:agents-efficacy` script)
- Regenerate + commit: `docs/site/stdlib/agents.md`

**Interfaces:**
- Consumes: all three agents + `verifyArtifact`.

- [ ] **Step 1: Read the template** — `tests/integration/optimize-efficacy/test.mjs` (spawns `agency`, reads a summary, asserts an objective, `process.exit(1)` on failure, retries transient errors).

- [ ] **Step 2: Write efficacy tests** — `tests/integration/agents/test.mjs` with three cases, each in a temp dir:
  - `codingAgent`: task "write /out/answer.txt containing exactly the text `42` with a trailing newline"; assert the file matches byte-for-byte.
  - `agencyCodingAgent`: task "return the sum of [1,2,3]"; assert the result is `success` and `runCode` yields `6`.
  - `verifyArtifact` strictness: seed a wrong-format file; assert `satisfied == false`.
  Each case runs via a tiny `.agency` driver that calls the agent and prints a machine-readable result the `.mjs` parses. Retry transient API errors once (copy the retry logic from the template).

- [ ] **Step 3: Add the script** — in `package.json`:

```json
"test:agents-efficacy": "node tests/integration/agents/test.mjs"
```

- [ ] **Step 4: Wire CI (non-blocking)** — add a step to `.github/workflows/test-with-llm.yml` after the existing agent tests:

```yaml
    - name: std::agents efficacy tests (real LLM)
      continue-on-error: true
      working-directory: packages/agency-lang
      env:
        OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      run: pnpm run test:agents-efficacy
```

> `continue-on-error: true` makes it non-blocking, matching the "track, don't gate" intent from the CI-tracking discussion.

- [ ] **Step 5: Run locally with a key** (author's machine; do NOT run the full agency suite):

Run: `cd packages/agency-lang && make && pnpm run test:agents-efficacy 2>&1 | tee /tmp/agents-efficacy.log`
Expected: all three cases pass. Save the log (do not rerun to inspect).

- [ ] **Step 6: Regenerate docs + commit** — `make` regenerates `docs/site/stdlib/agents.md` from the module doc comments. Commit the module, the tests, the workflow, the script, and `agents.md`.

```bash
git add stdlib/agents.agency tests/integration/agents package.json .github/workflows/test-with-llm.yml docs/site/stdlib/agents.md
git commit -F <msgfile>   # "Add std::agents efficacy tests, CI wiring, and docs"
```

---

## Self-Review

**1. Spec coverage:**
- `std::agents` module ✓ (Task 1). `verifyArtifact`/`Verdict`/`renderGaps` ✓ (Tasks 2-3). `writeAgency` upgrade (examples + point-of-need) ✓ (Task 4). `codingAgent` ✓ (5), `researchAgent` ✓ (6), `agencyCodingAgent` ✓ (7). Worked examples + point-of-need injection ✓ (Tasks 4-5). Two-tier tests ✓ (wiring in 5-7, efficacy + CI in 8). Composition constraint ✓ (Global Constraints; no config core). `plannerAgent` — intentionally deferred to Part 2 (spec allows phasing). Effect-envelope preview — spec non-goal, not planned. ✓
- Gap: the spec's `researchAgent` "degrades gracefully when search is off" — Task 6 prompt handles it ("say so plainly"), but add an explicit efficacy note if search backend is unavailable in CI (documented as a known-skip, not a failure).

**2. Placeholder scan:** No TBD/TODO. Code shown in every code step. Commit messages reference a `<msgfile>` because Agency commit messages with apostrophes must go through a file (per repo convention) — the implementer writes the quoted message to a temp file.

**3. Type consistency:** `Verdict { satisfied, gaps }` used identically in Tasks 2/3/5/6/7. `codingAgent`/`researchAgent` return `string`; `agencyCodingAgent` returns `Result<string, WriteFailure>` — matches the spec exports. `renderGaps(string[]) -> string` consistent throughout.

**Known risk to verify during implementation:** several agent bodies (`while` + `thread` + `match` + `try` + inline `if/then/else`) must be checked against the guide and the `verify.agency`/`code.agency` templates — the plan deliberately anchors each to a proven template file rather than trusting novel syntax.
