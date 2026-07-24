# Checkpoint-verify and time-boxed expert consult — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the coding agent from thrashing until timeout by verifying its disk output at re-arming checkpoints and redirecting or stopping it, and stop the expert consult from eating the run's time budget.

**Architecture:** Compose existing primitives — `guard` (now interrupt-raising), `handle`/`with`, `saveDraft`, and the existing `verify` — into `codingAgent`. A short re-arming time guard fires mid-tool-loop; an interrupt-free handler reads the body's latest verify result and either extends with a "commit the fix now" message or stops gracefully. The expert consult gets its own time-box that fails open to empty guidance.

**Tech Stack:** Agency language (stdlib `.agency` files compiled via `make`), pure-Agency execution tests under `tests/agency/`.

## Global Constraints

- **NEVER commit to `main`.** Create a worktree/branch off `main` before the first commit (superpowers:using-git-worktrees). Re-check `git branch --show-current` before every commit.
- **Run `make` after editing any `stdlib/*.agency` or `lib/agents/**/*.agency` file** before typechecking or running tests — tests import the compiled `dist` stdlib.
- **Commit messages:** write to a file (apostrophes break the command line), end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-17-checkpoint-verify-and-timeboxed-expert-design.md`. All work is relative to `packages/agency-lang/`.
- **Agency syntax:** `def`/`node` with `{ }`; `if (...) { }`; `let`/`const` before use; `for (x in xs)`. Verify snippets against `docs/site/guide/basic-syntax.md` if unsure.

---

## File Structure

- `tests/agency/guards/checkpoint-verify-mechanism.agency` (create) + `.test.json` — the spike: proves the guard/handler composition `codingAgent` will use, LLM-free.
- `stdlib/agents/coding.agency` (modify) — add checkpoint params + the handle/checkpoint structure to `codingAgent`; add the commit-early prompt bullet.
- `stdlib/agents/expert.agency` (modify) — time-box `consultOrEmpty`; carve `expertAgent`'s budget so `codingAgent`'s handler owns the graceful stop.
- `lib/agents/agency-agent/subagents/code.agency` — no change expected (new `expertAgent` params have defaults); audited in Task 4.

---

## Task 1: Spike — checkpoint/handler mechanism (GATE)

This validates the two genuinely-unproven pieces from the spec's §8 (handler reads body-updated state; a labelled nested `verify` guard routes to its own reject, not the checkpoint handler) plus re-arm and reject-keeps-draft. It touches no production code, so if it fails, STOP and revise the spec — do not proceed.

**Files:**
- Create: `tests/agency/guards/checkpoint-verify-mechanism.agency`
- Create: `tests/agency/guards/checkpoint-verify-mechanism.test.json`

**Interfaces:**
- Consumes: existing `guard`, `handle`/`with`, `saveDraft`, `approve`, `reject`, `pass`, `isFailure`, `i.data.label`/`.dimension`/`.spent`.
- Produces: nothing consumed by later tasks; it is a confidence gate.

- [ ] **Step 1: Write the spike program**

Create `tests/agency/guards/checkpoint-verify-mechanism.agency`. `spin(300000)` reliably overruns tens-of-ms guards (same constant `tests/agency/guards/trip-time.agency` uses):

```ts
// Validates the exact guard/handler composition codingAgent uses:
//   - the handler reads a `let` the guarded body updated (spike item 2)
//   - a labelled inner "verify" guard trips and routes to its own reject,
//     NOT the checkpoint handler (spike item 4)
//   - approve re-arms the checkpoint (loop runs to completion)
//   - reject on the checkpoint returns the saved draft (spike item 3)
// LLM-free: pure time guards + spin, with huge margins (ms limits vs seconds
// of spin), so timer starvation cannot flake it.

def spin(rounds: number): string {
  let i = 0
  while (i < rounds) {
    i = i + 1
  }
  return "spun"
}

// Handler reads body state; inner "verify" guard routes to its own reject.
node checkpointReadsStateAndRoutesVerify(): string {
  let lastGaps = ""
  let sawGaps = "none"
  let verifyOutcome = "verify-?"
  handle {
    const captured = guard(time: 100ms, label: "checkpoint") {
      lastGaps = "gap-A"
      // Inner labelled guard overruns its own 20ms budget → trips. It must NOT
      // be extended by the checkpoint handler; it rejects on its own → failure.
      const v = guard(time: 20ms, label: "verify") {
        const inner = spin(300000)
        return "verify-ok"
      }
      verifyOutcome = match (v) {
        success(x) => "verify-ok"
        failure(_) => "verify-failed"
      }
      // Overrun the checkpoint → trips → handler reads lastGaps and grants.
      const s2 = spin(300000)
      return "body-done"
    }
    if (isFailure(captured)) { return "rejected|saw=${sawGaps}|${verifyOutcome}" }
    return "ok:${captured.value}|saw=${sawGaps}|${verifyOutcome}"
  } with (i) {
    if (i.effect == "std::guard" && i.data.label == "checkpoint") {
      sawGaps = lastGaps
      return approve({ maxTime: 600000, message: "keep going" })
    }
    return pass()
  }
}

// A checkpoint reject returns the saved draft, not a bare failure.
node checkpointRejectKeepsDraft(): string {
  handle {
    const captured = guard(time: 100ms, label: "checkpoint") {
      saveDraft("best-so-far")
      const s = spin(300000)
      return "full-result"
    }
    if (isFailure(captured)) { return "no-draft" }
    return "kept:${captured.value}"
  } with (i) {
    if (i.effect == "std::guard" && i.data.label == "checkpoint") {
      return reject()
    }
    return pass()
  }
}

// The exact fail-open composition consultOrEmpty (Task 3) uses: a guard with NO
// saved draft trips, nobody grants (handler passes, mirroring the auto-approve
// pass on std::guard), so the guard rejects → failure → match returns the
// fallback default.
node guardFailureFallsBackToDefault(): string {
  let out = ""
  handle {
    const captured = guard(time: 20ms, label: "consult") {
      const s = spin(300000)
      return "real-guidance"
    }
    out = match (captured) {
      success(v) => v
      failure(_) => "empty-fallback"
    }
  } with (i) {
    return pass()
  }
  return out
}
```

- [ ] **Step 2: Write the fixture**

Create `tests/agency/guards/checkpoint-verify-mechanism.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "checkpointReadsStateAndRoutesVerify",
      "input": "",
      "expectedOutput": "\"ok:body-done|saw=gap-A|verify-failed\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [],
      "description": "Checkpoint handler reads the body's lastGaps write (saw=gap-A); the labelled verify guard trips and routes to its own reject (verify-failed); approve re-arms so the loop finishes (body-done)."
    },
    {
      "nodeName": "checkpointRejectKeepsDraft",
      "input": "",
      "expectedOutput": "\"kept:best-so-far\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [],
      "description": "A checkpoint reject returns the saved draft."
    },
    {
      "nodeName": "guardFailureFallsBackToDefault",
      "input": "",
      "expectedOutput": "\"empty-fallback\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [],
      "description": "A guard with no saved draft trips and nobody grants → failure → match returns the fallback. This is consultOrEmpty's fail-open composition."
    }
  ]
}
```

- [ ] **Step 3: Run the spike, expect PASS**

Run: `pnpm run a test tests/agency/guards/checkpoint-verify-mechanism.agency 2>&1 | tee /tmp/spike.log`
Expected: both tests PASS. If `checkpointReadsStateAndRoutesVerify` returns `saw=none`, the handler cannot read body state → STOP, the design's no-progress detection is unbuildable as written. If `verifyOutcome` is `verify-ok`, the checkpoint handler wrongly extended the verify guard → STOP, the label routing is wrong.

- [ ] **Step 4: Commit**

```bash
git branch --show-current   # MUST NOT be main
git add tests/agency/guards/checkpoint-verify-mechanism.agency tests/agency/guards/checkpoint-verify-mechanism.test.json
git commit -F /tmp/commit-msg.txt   # message file ends with the Co-Authored-By trailer
```

---

## Task 2: Feature A + C — `codingAgent` checkpoint and commit-early prompt

**Files:**
- Modify: `stdlib/agents/coding.agency` (signature + body of `codingAgent`, lines 31-67; prompt bullet in `codingSysPrompt`, lines 22-27)

**Interfaces:**
- Consumes: `verify(task, criteria) → Result<Feedback[]>`, `feedbackHasErrors(Result<Feedback[]>) → boolean`, `renderFeedback(Result<Feedback[]>) → string` (all from `std::agency`, already imported); `saveDraft`, `guard`, `handle`, `unwrapGuard`.
- Produces: `codingAgent(task, context, criteria, maxAttempts, maxCost, maxTime, checkpoint, verifyTime, verifyCost) → string`. New trailing params: `checkpoint: number = 0` (0 = today's behavior), `verifyTime: number = 3m`, `verifyCost: number = $5.00`. Task 4 relies on these names.

- [ ] **Step 1: Add the commit-early prompt bullet**

In `stdlib/agents/coding.agency`, inside `codingSysPrompt` (lines 22-27), add this bullet immediately before the `- NEVER fabricate` line:

```
- Keep a valid, best-effort version of the required output file on disk at all times. The moment you have any plausible answer, write it to the exact required path. When a check finds a problem, fix the file before running another check. Never leave the deliverable unwritten while you analyze — an analyzed but unwritten answer scores zero.
```

- [ ] **Step 2: Replace `codingAgent` with the checkpoint-aware version**

Replace `codingAgent` (lines 31-67) with this. The `checkpoint <= 0` branch is the current body verbatim (behavior-preserving); the `checkpoint > 0` branch is Feature A.

```ts
export def codingAgent(task: string, context: string = "", criteria: string[] = [], maxAttempts: number = 3, maxCost: number = $50.00, maxTime: number = 30m, checkpoint: number = 0, verifyTime: number = 3m, verifyCost: number = $5.00): string {
  """
  General-purpose coding agent. Writes and runs code to complete a task and
  verifies the result against the task's success criteria. Returns a short
  summary; the real output is filesystem side effects.

  @param task - What to build or fix.
  @param context - Optional extra material (data, examples, constraints).
  @param criteria - Optional authoritative acceptance criteria passed through to
    `verify`.
  @param maxAttempts - Max verify-and-fix attempts before returning (default 3).
  @param maxCost - Hard spend cap for the whole run (default $50).
  @param maxTime - Hard wall-clock cap for the whole run (default 30 minutes).
  @param checkpoint - If > 0, verify the disk output at this interval and either
    redirect the agent or stop it. 0 keeps the plain single-guard behavior.
  @param verifyTime - Per-checkpoint budget for the verify review (default 3m).
  @param verifyCost - Per-checkpoint spend cap for the verify review (default $5).
  """
  if (checkpoint <= 0) {
    const captured = guard(cost: maxCost, time: maxTime) {
      let reply = ""
      let msg = withContext(task, context)
      thread(label: "codingAgent") {
        systemMessage(codingSysPrompt)
        let done = false
        let attemptsLeft = maxAttempts
        while (!done && attemptsLeft > 0) {
          reply = llm("${msg}\n\n${finalizeReminder}", { tools: codingTools })
          const fb = verify(task, criteria)
          if (feedbackHasErrors(fb)) {
            msg = "Not done yet. A strict review found:\n\n${renderFeedback(fb)}\n\nFix each problem exactly."
            attemptsLeft = attemptsLeft - 1
          } else {
            done = true
          }
        }
      }
      return reply
    }
    return unwrapGuard(captured, "Coding")
  }

  // checkpoint > 0: re-arming checkpoint guard + interrupt-free handler.
  let reply = ""
  let msg = withContext(task, context)
  let lastGaps = ""          // gap text from the body's most recent verify
  let handlerSeenGaps = ""   // what the handler compared against last checkpoint
  let noProgress = 0
  let captured: Result<string> = success("")

  handle {
    captured = guard(cost: maxCost, time: checkpoint, label: "checkpoint") {
      thread(label: "codingAgent") {
        systemMessage(codingSysPrompt)
        let done = false
        let attemptsLeft = maxAttempts
        while (!done && attemptsLeft > 0) {
          reply = llm("${msg}\n\n${finalizeReminder}", { tools: codingTools })
          saveDraft(reply)
          // verify is bounded here, in the body, where a guard is legal.
          const v = guard(time: verifyTime, cost: verifyCost, label: "verify") { return verify(task, criteria) }
          match (v) {
            success(fb) =>
              if (feedbackHasErrors(fb)) {
                lastGaps = renderFeedback(fb)
                msg = "Not done yet. A strict review of the files on disk found:\n\n${lastGaps}\n\nFix each problem on disk."
                attemptsLeft = attemptsLeft - 1
              } else {
                done = true
              }
            failure(_) => attemptsLeft = attemptsLeft - 1
          }
        }
      }
      return reply
    }
  } with (i) {
    if (i.effect == "std::guard" && i.data.label == "checkpoint") {
      if (i.data.dimension == "time" && i.data.spent < maxTime) {
        if (lastGaps == "" || lastGaps == handlerSeenGaps) {
          noProgress = noProgress + 1
          if (noProgress >= 2) { return reject() }
        } else {
          noProgress = 0
        }
        handlerSeenGaps = lastGaps
        return approve({ maxTime: checkpoint, message: "You are over the checkpoint budget. Stop analyzing and writing new scripts. Make the concrete fix to the required output file on disk now, then finish. Latest known gaps:\n${lastGaps}" })
      }
      return reject()
    }
    return pass()
  }
  return unwrapGuard(captured, "Coding")
}
```

- [ ] **Step 3: Build and typecheck**

Run: `make 2>&1 | tail -5 && pnpm run a typecheck stdlib/agents/coding.agency 2>&1 | tail -3`
Expected: `make` exits 0; typecheck prints `No type errors found.` If `success("")` or `Result<string>` errors, check `stdlib/agency.agency` for the exact `Result` spelling and fix.

- [ ] **Step 4: Confirm the mechanism still passes (no regression to Task 1's primitives)**

Run: `pnpm run a test tests/agency/guards/checkpoint-verify-mechanism.agency 2>&1 | tail -5`
Expected: both PASS (Task 2 changed no runtime; this is a sanity check that `make` did not break the guard primitives).

> Note on testing: a fully-deterministic unit test of the `checkpoint > 0` path inside `codingAgent` would need to mock both the coding `llm()` and `verify`'s internal `llm()` while forcing a mid-turn time trip — brittle. The composed mechanism is proven by Task 1; the end-to-end behavior is validated by Task 5 (real-LLM). Task 2's automated gate is typecheck + the unchanged `checkpoint == 0` default.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # MUST NOT be main
git add stdlib/agents/coding.agency   # coding.js is gitignored (built by `make`)
git commit -F /tmp/commit-msg.txt
```

---

## Task 3: Feature B1 — time-box the expert consult

**Files:**
- Modify: `stdlib/agents/expert.agency` — `consultOrEmpty` (lines 150-155) and `expertAgent` (lines 185-196)

**Interfaces:**
- Consumes: `consultExpert(question, expertModel, expertProvider) → ExpertGuidance`; `guard`; `emptyGuidance`.
- Produces: `consultOrEmpty(task, expertModel, expertProvider, expertBudget, expertCost) → ExpertGuidance` with `expertBudget: number = 3m`, `expertCost: number = $5.00`. `expertAgent` gains `expertBudget`/`expertCost` params and threads them.

- [ ] **Step 1: Replace `consultOrEmpty` with the guarded, fail-open version**

Replace `consultOrEmpty` (lines 150-155) with:

```ts
// Fail-open AND time-boxed: a consult that errors OR overruns its budget yields
// empty guidance, so the coding agent still runs exactly as it would without a
// consult. A guard block converts both a raised exception and a budget trip into
// a `failure`, so this single guard replaces the old `try`.
def consultOrEmpty(task: string, expertModel: string = "", expertProvider: string = "", expertBudget: number = 3m, expertCost: number = $5.00): ExpertGuidance {
  const captured = guard(time: expertBudget, cost: expertCost) {
    return consultExpert(task, expertModel, expertProvider)
  }
  return match (captured) {
    success(g) => g
    failure(_) => emptyGuidance
  }
}
```

- [ ] **Step 2: Thread `expertBudget`/`expertCost` through `expertAgent`**

In `expertAgent` (lines 185-196), add the two params to the signature and pass them to `consultOrEmpty`. Change the signature line to:

```ts
export def expertAgent(task: string, context: string = "", maxCost: number = $20.00, maxTime: number = 15m, expertModel: string = "", expertProvider: string = "", expertBudget: number = 3m, expertCost: number = $5.00, checkpoint: number = 5m): string {
```

and change the `consultOrEmpty` call inside the guard block to:

```ts
    const guidance = consultOrEmpty(task, expertModel, expertProvider, expertBudget, expertCost)
```

(The `checkpoint` param added here is used in Task 4; adding it now keeps the signature stable across the two tasks.) Add matching `@param expertBudget`/`@param expertCost`/`@param checkpoint` docstring lines.

- [ ] **Step 3: Build and typecheck**

Run: `make 2>&1 | tail -5 && pnpm run a typecheck stdlib/agents/expert.agency 2>&1 | tail -3`
Expected: `make` exits 0; `No type errors found.`

- [ ] **Step 4: Confirm the fail-open composition (via the Task 1 proof)**

A deterministic unit test of `consultOrEmpty`'s time-box would need to trip an
instant mock `llm()`, which is flaky, and `consultOrEmpty` is not exported. Its
composition — `match (guard {...}) { success => g; failure => emptyGuidance }` —
is exactly what Task 1's `guardFailureFallsBackToDefault` node proves. Re-run it
to confirm nothing regressed, and rely on Task 5 for the real consult:

Run: `pnpm run a test tests/agency/guards/checkpoint-verify-mechanism.agency 2>&1 | tail -5`
Expected: `guardFailureFallsBackToDefault` PASS (`"empty-fallback"`).

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add stdlib/agents/expert.agency   # expert.js is gitignored (built by `make`)
git commit -F /tmp/commit-msg.txt
```

---

## Task 4: Feature A wiring — `expertAgent` budget carving

Make `codingAgent`'s checkpoint handler the graceful overall-time authority (spec §3 reconciliation) by giving `codingAgent` a budget that fits inside `expertAgent`'s outer guard, and pass the checkpoint through.

**Files:**
- Modify: `stdlib/agents/expert.agency` — the `codingAgent(...)` call inside `expertAgent` (currently line 194)
- Audit: `lib/agents/agency-agent/subagents/code.agency` — the `expertAgent(...)` call (lines ~507-517)

**Interfaces:**
- Consumes: `codingAgent(..., maxTime, checkpoint)` from Task 2; `expertBudget`/`checkpoint` params on `expertAgent` from Task 3.
- Produces: no new symbols; wires budgets.

- [ ] **Step 1: Carve the coding budget and pass the checkpoint**

In `expertAgent`, replace the `return codingAgent(...)` line (line 194) with:

```ts
    // Give the solver a time budget that fits inside this outer guard's remaining
    // time (outer = expertBudget + codingBudget + buffer), so codingAgent's
    // checkpoint handler reaches its graceful stop before the outer guard's
    // handler-less hard abort. Clamp so tiny budgets stay positive.
    const rawCodingBudget = maxTime - expertBudget - 30s
    const codingBudget = if rawCodingBudget < 60s then 60s else rawCodingBudget
    return codingAgent(task, context: solverContext, criteria: guidance.checklist, maxCost: maxCost, maxTime: codingBudget, checkpoint: checkpoint)
```

- [ ] **Step 2: Build and typecheck**

Run: `make 2>&1 | tail -5 && pnpm run a typecheck stdlib/agents/expert.agency 2>&1 | tail -3`
Expected: `make` exits 0; `No type errors found.` If `maxTime - expertBudget - 30s` errors, confirm unit literals are plain numbers (ms) that subtract — they are (`docs/site/guide/basic-syntax.html#unit-literals`).

- [ ] **Step 3: Audit the agent call site**

Run: `sed -n '500,520p' lib/agents/agency-agent/subagents/code.agency`
Expected: the existing `expertAgent(userMsg, maxCost: ..., maxTime: ..., expertModel: ..., expertProvider: ...)` call. Because `expertBudget`, `expertCost`, and `checkpoint` all have defaults, **no change is required** — confirm the call still typechecks:
Run: `pnpm run a typecheck lib/agents/agency-agent/subagents/code.agency 2>&1 | tail -3`
Expected: `No type errors found.`

- [ ] **Step 4: Commit**

```bash
git branch --show-current
git add stdlib/agents/expert.agency   # expert.js is gitignored (built by `make`)
git commit -F /tmp/commit-msg.txt
```

---

## Task 5: Real-LLM end-to-end validation (manual)

Not a CI task — it needs the Terminal-Bench container. This is the acceptance gate the automated tests cannot cover.

- [ ] **Step 1: Build the tarball** with the branch's changes (`~/bench-agency/build-tarball.sh`).
- [ ] **Step 2: Run dna-insert once** via the adapter with `--log /logs/agent/statelog.jsonl`.
- [ ] **Step 3: Confirm from the statelog:**
  - a `std::guard` interrupt with `label` `"checkpoint"` fired (the checkpoint engaged mid-run);
  - after it, a user message containing "Make the concrete fix to the required output file" reached a turn;
  - a `primers.fasta` exists on disk at the end even if the run stopped early (graceful stop, not a bare timeout);
  - the run did not spend the full 30 minutes producing 18 analysis scripts (compare tool-call counts to `~/bench-agency/jobs/2026-07-15__16-54-10/dna-insert__r7qHua3`).
- [ ] **Step 4: Record the result** in a short note next to the job dir, as with the prior `ANALYSIS.md`.

---

## Deferred: Feature B2 (two-pass expert with saved partial)

Out of scope for this plan. Implement only after a spike confirms a `saveDraft` inside `domainExpert` crosses the `consultOrEmpty` guard block as the guard's success value (spec §8 item 5). Until then, B1 (Task 3) is the shipped behavior: the consult is time-boxed and fails open to empty.

---

## Self-Review

**Spec coverage:**
- Feature A (checkpoint verify) → Task 1 (mechanism) + Task 2 (wiring) + Task 4 (budget carving) + Task 5 (e2e).
- Feature B1 (time-boxed consult, fail-open) → Task 3.
- Feature B2 → explicitly deferred with its gating spike named.
- Feature C (commit-early prompt) → Task 2, Step 1.
- §4 uniform budget params → `codingAgent` (Task 2) and `expertAgent`/`consultOrEmpty` (Tasks 3-4) gain named params. `researchAgent`/`agencyCodingAgent` already carry `maxCost`/`maxTime`; no new work, no task needed.
- §3 two-guard reconciliation (the owner-confirmed decision) → Task 4 (codingBudget < outer remaining; checkpoint handler owns the graceful stop).

**Placeholder scan:** No TBD/TODO. Every code step shows complete code; every test step shows the fixture and the exact command + expected output.

**Type consistency:** `codingAgent`'s new params (`checkpoint`, `verifyTime`, `verifyCost`) are declared in Task 2 and consumed by name in Task 4. `consultOrEmpty`'s `expertBudget`/`expertCost` are declared in Task 3 and threaded from `expertAgent` in the same task. `verify → Result<Feedback[]>`, `feedbackHasErrors`, `renderFeedback` are used with the signatures confirmed in `stdlib/agency.agency`. `success(...)`/`failure(...)` constructors and `Result<string>` annotations match stdlib usage (`stdlib/agency.agency:340,434`).

**Known limitation (carried from the spec, not hidden):** the `checkpoint > 0` path in `codingAgent` has no cheap deterministic unit test; its correctness rests on Task 1's isolated mechanism proof plus Task 5's real-LLM e2e. The handler's thrashing signal is indirect (fresh-vs-stale `lastGaps`); the `noProgress >= 2` threshold may need tuning against real runs.
