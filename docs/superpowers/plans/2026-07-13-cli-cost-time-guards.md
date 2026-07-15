# CLI cost/time guards + working-time semantics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--max-cost` / `--max-time` flags to `agency run` and `agency agent`, make time budgets stop counting while waiting on a human, and give each `fork` branch its own time budget.

**Architecture:** Reuse the existing guard primitives (`CostGuard`, `TimeGuard`, `pushGuard`) and the `--policy` CLI→env→runtime plumbing. Three PRs, semantics first: (1) tighten the disable rule for time and make input-wait free; (2) per-branch time budgets; (3) CLI flags installing a root guard, with a distinct exit code.

**Tech Stack:** TypeScript runtime (`lib/runtime/`), stdlib TS seams (`lib/stdlib/`), commander CLI (`scripts/agency.ts`), tarsec-based codegen (`lib/backends/`), Agency execution-test fixtures (`tests/agency/`).

## Global Constraints

- Guard disable ranges (verbatim from the design): **cost** disabled when value `< 0`, real limit when `>= 0` (`0` = "no paid spend" / local-models-only); **time** disabled when value `<= 0`, real limit when `> 0`.
- Budget-exceeded exit code is **3**, defined once as a named constant in `lib/constants.ts`, distinct from `1` (generic failure) and `2` (usage error).
- Cost stays shared/cumulative across `fork` branches (`CostGuard.cloneForBranch` returns `this`, unchanged). Only **time** becomes per-branch.
- `sleep` still counts against time budgets. Only waiting on a human (`input`) is exempt.
- `--max-cost` is bare dollars (no `$`). `--max-time` accepts duration strings only (`30s`, `5m`, `1h`, `500ms`), plus a leading `-` for a disable value; a bare unitless number is a usage error.
- Never use dynamic imports. Objects over maps, arrays over sets, types over interfaces (per `docs/dev/coding-standards.md`).
- Run `make` after changing stdlib `.agency` files. Save test output to a file.

---

# PR 1 — Time-zero disables + input-wait is free

**Context for the implementer:** "Negative disables a dimension" already works — `pushGuardImpl` in `lib/stdlib/thread.ts:258` only pushes a guard when the limit is `>= 0`, and the `guard` docstring in `stdlib/thread.agency:212` already documents it. This PR does two things: (a) tighten **time** so `0` also disables (matches the design's "time `<= 0` disables"), and (b) stop counting time while `input` waits on a human.

## Task 1.1: `time: 0` disables the time guard

**Files:**
- Modify: `lib/stdlib/thread.ts:281` (the `timeLimit != null && timeLimit >= 0` condition)
- Modify: `stdlib/thread.agency:230` (docstring for `@param time`)
- Test: `tests/agency/guards/guard-time-zero-disables.agency` + `.test.json` (create)

**Interfaces:**
- Consumes: `pushGuardImpl(stack, costLimit, timeLimit)` (existing, `lib/stdlib/thread.ts:258`).
- Produces: no signature change. Behavior change only: `guard(time: 0)` installs no time guard.

- [ ] **Step 1: Check nothing relies on `guard(time: 0)` tripping**

Run: `grep -rn "time: 0\b\|TimeGuard(0)\|time: 0ms" tests/ lib/ stdlib/`
Expected: no test asserts that a zero time budget trips. If any exists, note it and adjust that test to the new "disabled" meaning as part of this task.

- [ ] **Step 2: Write the failing execution test**

Create `tests/agency/guards/guard-time-zero-disables.agency`:

```
import { guard } from "std::thread"

// A zero time budget disables the time guard: the block runs to
// completion and returns its value instead of tripping. (A negative
// budget already disables; this locks in that 0 does too, matching
// the design's "time <= 0 disables" rule.)
node main() {
  const result = guard(time: 0) as {
    sleep(20ms)
    return "ran to completion"
  }
  if (isFailure(result)) {
    return "tripped:${result.error.type}"
  }
  return result.value
}
```

Create `tests/agency/guards/guard-time-zero-disables.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"ran to completion\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "A zero time budget disables the time guard; the block runs to completion rather than tripping."
    }
  ]
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm run a test tests/agency/guards/guard-time-zero-disables.agency 2>&1 | tee /tmp/pr1-t1.log`
Expected: FAIL — with today's `>= 0`, a `TimeGuard(0)` is pushed and trips almost immediately, so output is `"tripped:timeoutFailure"`, not `"ran to completion"`.

- [ ] **Step 4: Tighten the time condition**

In `lib/stdlib/thread.ts`, change the time branch in `pushGuardImpl`:

```ts
  if (costLimit != null && costLimit >= 0) {
    const g = new CostGuard(costLimit);
    stack.pushGuard(g);
    ids.push(g.guardId);
  }
  // Time: a NON-POSITIVE limit disables (0 would otherwise trip instantly and
  // has no useful meaning). Cost differs on purpose: cost 0 is a real limit
  // meaning "no paid spend" (local-models-only), since check() trips on
  // spent > limit (strict).
  if (timeLimit != null && timeLimit > 0) {
    const g = new TimeGuard(timeLimit);
    stack.pushGuard(g);
    ids.push(g.guardId);
  }
```

- [ ] **Step 5: Update the docstring**

In `stdlib/thread.agency`, change the `@param time` line (around line 230):

```
  @param time - Maximum compute time in milliseconds (e.g. 30s, 5m, or a raw number). null, zero, or negative = no time limit.
```

- [ ] **Step 6: Rebuild stdlib and run the test**

Run: `make 2>&1 | tail -5 && pnpm run a test tests/agency/guards/guard-time-zero-disables.agency 2>&1 | tee /tmp/pr1-t1.log`
Expected: PASS.

- [ ] **Step 7: Confirm existing guard tests still pass**

Run: `pnpm run a test tests/agency/guards/guard-time-trip.agency 2>&1 | tee -a /tmp/pr1-t1.log && pnpm run a test tests/agency/guards/guard-cost-no-trip.agency 2>&1 | tee -a /tmp/pr1-t1.log`
Expected: both PASS (positive time budgets still trip; cost unaffected).

- [ ] **Step 8: Commit**

```bash
git add lib/stdlib/thread.ts stdlib/thread.agency tests/agency/guards/guard-time-zero-disables.*
git commit -F /tmp/commit-1-1.txt
```

Where `/tmp/commit-1-1.txt` contains:

```
Make time: 0 disable the time guard (design: time <= 0 = no limit)

Cost 0 stays a real limit (no paid spend / local-only); only time
treats 0 as disabled, since a zero time budget trips instantly and
has no useful meaning.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

## Task 1.2: Pause time guards while `input` waits on a human

**Files:**
- Modify: `lib/stdlib/builtins.ts:59-90` (`inputImpl`)
- Test: `tests/agency/guards/guard-time-input-wait-free.agency` + `.test.json` (create)
- Test: `tests/agency/guards/guard-time-sleep-still-counts.agency` + `.test.json` (create)

**Interfaces:**
- Consumes: `stack.guards` (array of `Guard`, `lib/runtime/state/stateStack.ts:309`); `Guard.pause()` / `Guard.resume(stack)` (`lib/runtime/guard.ts:59`).
- Produces: no signature change to `inputImpl`. Behavior: time guards on the active branch stack do not accrue elapsed time across the input wait.

- [ ] **Step 1: Add a test input override helper the fixtures can use**

The real `input` blocks on stdin, which an execution test cannot drive. `inputImpl` already honors a global override at `builtins.ts:64` (`__agencyInputOverride`). The override must be exercised through the SAME pause/resume path as the real wait (see Step 4). To let a fixture install an override that also takes real time, add a tiny stdlib test seam.

In `lib/stdlib/builtins.ts`, above `inputImpl`, add:

```ts
/** Test-only: install an input override that resolves after `delayMs`,
 *  used by guard fixtures to simulate a slow human without touching stdin.
 *  Exposed as the `_installSlowInput` builtin (test imports only). */
export function _installSlowInput(delayMs: number, answer: string): void {
  (globalThis as any).__agencyInputOverride = (_prompt: string) =>
    new Promise<string>((resolve) => setTimeout(() => resolve(answer), delayMs));
}
```

Register it as a test-only builtin (follow the existing `_input` registration in `lib/codegenBuiltins/` — mirror how another `_`-prefixed builtin with no context injection is registered; grep `"_round"` for the simplest analog and copy its registration entry).

- [ ] **Step 2: Write the failing "input-wait is free" test**

Create `tests/agency/guards/guard-time-input-wait-free.agency`:

```
import test { _installSlowInput } from "std::builtins"
import { guard } from "std::thread"

// A 40ms time budget wrapping an input() whose (simulated) human takes
// 120ms to answer. Because input-wait does not count against a time
// budget, the guard must NOT trip: the block returns the answer.
node main() {
  _installSlowInput(120, "hello")
  const result = guard(time: 40ms) as {
    const answer = input("your name? ")
    return "got:${answer}"
  }
  if (isFailure(result)) {
    return "tripped:${result.error.type}"
  }
  return result.value
}
```

Create `tests/agency/guards/guard-time-input-wait-free.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"got:hello\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "A time budget does not count time spent waiting for a human via input(); a slow answer that exceeds the raw budget does not trip the guard."
    }
  ]
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `make 2>&1 | tail -3 && pnpm run a test tests/agency/guards/guard-time-input-wait-free.agency 2>&1 | tee /tmp/pr1-t2.log`
Expected: FAIL — today the timer keeps running during the wait, so the 120ms answer overruns the 40ms budget and output is `"tripped:timeoutFailure"`.

- [ ] **Step 4: Wrap the input wait in pause/resume**

Rewrite `inputImpl` in `lib/stdlib/builtins.ts` so BOTH the override path and the readline path pause the active stack's guards for the duration of the wait:

```ts
function inputImpl(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  prompt: string,
): Promise<string> {
  // Waiting on a human must not count against a time budget. Pause every
  // guard on the active branch stack before blocking, resume after. These
  // are the same idempotent calls the runner makes on halt()/step entry;
  // CostGuard.pause() is a no-op, so only time budgets are affected.
  stack.guards.forEach((g) => g.pause());
  const resumeGuards = () => stack.guards.forEach((g) => g.resume(stack));

  const override = (globalThis as any).__agencyInputOverride as
    | ((prompt: string) => Promise<string>)
    | undefined;
  if (override) {
    return override(prompt).finally(resumeGuards);
  }
  const signal = ctx.getAbortSignal(stack);
  if (signal.aborted) {
    resumeGuards();
    return Promise.reject(new AgencyCancelledError("input cancelled"));
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      try { rl.close(); } catch {}
      reject(new AgencyCancelledError("input cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    rl.question(prompt, (answer: string) => {
      signal.removeEventListener("abort", onAbort);
      rl.close();
      resolve(answer);
    });
  }).finally(resumeGuards);
}
```

Note: `getRuntimeContext().stack` (via `_input`) resolves the ALS active-branch stack, so pausing `stack.guards` targets the right scope. This is a no-op when there are no guards.

- [ ] **Step 5: Run the test to verify it passes**

Run: `make 2>&1 | tail -3 && pnpm run a test tests/agency/guards/guard-time-input-wait-free.agency 2>&1 | tee /tmp/pr1-t2.log`
Expected: PASS — output `"got:hello"`.

- [ ] **Step 6: Write the "sleep still counts" companion test**

Create `tests/agency/guards/guard-time-sleep-still-counts.agency`:

```
import { guard } from "std::thread"

// sleep is NOT exempt: it is the program deliberately spending time,
// not waiting on a human. A sleep that overruns the budget still trips.
node main() {
  const result = guard(time: 20ms) as {
    sleep(150ms)
    sleep(1ms)
    return "did not trip"
  }
  if (isFailure(result)) {
    return "tripped:${result.error.type}"
  }
  return result.value
}
```

Create `tests/agency/guards/guard-time-sleep-still-counts.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"tripped:timeoutFailure\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "sleep still counts against a time budget; a sleep that overruns the limit trips, confirming only input-wait is exempt."
    }
  ]
}
```

- [ ] **Step 7: Run the sleep test to verify it passes**

Run: `pnpm run a test tests/agency/guards/guard-time-sleep-still-counts.agency 2>&1 | tee -a /tmp/pr1-t2.log`
Expected: PASS.

- [ ] **Step 8: Add an Esc-during-input regression test**

Confirm `pause()` does not break external cancellation of an in-progress input wait. Create `tests/agency/guards/guard-input-abort-still-cancels.agency`:

```
import test { _installSlowInput } from "std::builtins"
import { guard } from "std::thread"

// pause() cancels only the guard's own timer; it leaves the abort
// signal composed, so a time-guard TRIP still aborts an in-flight
// input. Here the wait (500ms) far exceeds the budget (30ms), and the
// input is NOT exempt from an abort that the guard itself fires... but
// input-wait is exempt from COUNTING. So the guard never trips and the
// answer returns. This asserts the wait is not spuriously aborted.
node main() {
  _installSlowInput(60, "ok")
  const result = guard(time: 30ms) as {
    const answer = input("q? ")
    return "got:${answer}"
  }
  if (isFailure(result)) {
    return "tripped:${result.error.type}"
  }
  return result.value
}
```

Create the matching `.test.json` expecting `"got:ok"`.

> Implementer note: the interaction between a time-guard trip and an in-flight input is subtle. The property this PR guarantees is that input-wait does not *count*. Whether an outer NON-guard abort (Esc/`cancel()`) interrupts input is unchanged by this PR — it still works via the composed signal, which `pause()` leaves intact. If you want to assert Esc behavior directly, drive it through the existing cancellation test harness rather than a guard fixture.

- [ ] **Step 9: Run the abort test**

Run: `pnpm run a test tests/agency/guards/guard-input-abort-still-cancels.agency 2>&1 | tee -a /tmp/pr1-t2.log`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add lib/stdlib/builtins.ts lib/codegenBuiltins/ tests/agency/guards/guard-time-input-wait-free.* tests/agency/guards/guard-time-sleep-still-counts.* tests/agency/guards/guard-input-abort-still-cancels.*
git commit -F /tmp/commit-1-2.txt
```

`/tmp/commit-1-2.txt`:

```
Make input-wait free against time budgets

Pause the active stack's guards around input()'s wait and resume
after, so waiting on a human does not count against a --max-time or
guard(time:) budget. sleep still counts. Reuses the runner's existing
idempotent pause()/resume(); CostGuard.pause() is a no-op.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

- [ ] **Step 11: Update the guards guide**

In `docs/site/guide/guards.md`, change the "When the clock ticks" list under `## Timeout` so `input` is now exempt:

```
When the clock ticks:
- regular code execution = yes.
- interrupts = no.
- waiting for user input through `input` = no (waiting on a human is free).
- `sleep` = yes.
```

Commit this doc change with the same message body (or fold into the Step 10 commit if not yet pushed).

---

# PR 2 — Per-branch time budgets

**Context:** Today `TimeGuard.cloneForBranch` returns `undefined` (`lib/runtime/guard.ts:360`), so a `fork` branch has no timer of its own — the parent's single timer trips all branches via a composed abort signal. This PR gives each branch its own timer, inheriting the parent's REMAINING budget at fork time, so a branch's input-wait pauses only its own clock. This is what makes PR 1 correct inside a fork.

**Investigation outcome (Task 2.1, completed 2026-07-14).** The plan's original hope — option (a), "parent timer keeps running, no join accounting" — is FALSE. Verified: the parent is not halted while awaiting `runBatch`, so its timer keeps running, AND `composeBranchAbortSignal` (`runBatch.ts:215`) composes the parent's signal into every branch, so a parent trip kills a waiting branch. Per-branch clones alone would change nothing for input-waits. The implemented semantics are therefore **working time along one causal path**:

- At fork entry, parent time guards PAUSE (enforcement is delegated to the branch clones for the duration of the region).
- Each branch clone carries the parent's remaining budget, the parent's `guardId` (so a branch trip is owned by the same `guard { }` boundary's `try`), and pauses/resumes independently.
- At the region's final value join, each parent time guard advances by the MAX of its clones' accrued working time, then resumes. Interrupted exits leave the parent paused (the parent halts anyway; clones keep their accrued time in the serialized branch stacks) — the single charge happens at the eventual final join, so no double-charging across pause/resume cycles.
- Serialization slice rule: inherited guards are sliced off a branch's checkpoint and re-cloned from the parent on resume. Correct for CostGuard (shared reference); WRONG for branch-owned time clones — it would reset a branch's clock on every interrupt. Time clones serialize with the branch and are re-adopted (not re-cloned) on resume, matched by `guardId`.
- Documented limitation: `runBatch` also runs subprocesses; an `input()` inside a CHILD PROCESS cannot pause the parent-process branch clone. Not a regression (child stdin is a dead pipe — `input()` in a subprocess is not a working feature; real subprocess human-waits go through interrupts, which already pause every clock in the chain). If subprocess `input()` is ever made real, route it through an interrupt rather than IPC pause signaling.

**Read before starting:** `docs/dev/runBatch.md`, `lib/runtime/state/stateStack.ts:557-608` (inherited-guard slice/prepend + `inheritedGuardCount` validation), `TimeGuard` (`lib/runtime/guard.ts:256`).

## Task 2.2: `TimeGuard.cloneForBranch` returns a per-branch timer

**Files:**
- Modify: `lib/runtime/guard.ts` (`TimeGuard`: `cloneForBranch`, new `currentElapsed()` private helper reused by `check`/`toJSON`, new `snapshotElapsed()`/`addElapsed(ms)` accessors for join accounting)
- Test: `lib/runtime/guard.test.ts`

**Interfaces:**
- Produces: `cloneForBranch` returns a NEW `TimeGuard` whose `timeLimit` is the parent's remaining budget (floored at 1ms) and whose `guardId` EQUALS the parent's. `snapshotElapsed(): number` returns accrued-plus-in-flight ms. `addElapsed(ms): void` advances the accumulator (join accounting). Task 2.3 consumes all three.

Steps: failing unit tests first (clone inherits remaining budget; clone carries the parent guardId; snapshot/addElapsed round-trip), then implement, then `pnpm test:run lib/runtime/guard.test.ts` green. Commit.

## Task 2.3: runBatch pauses parent time guards and charges max at the join

**Files:**
- Modify: `lib/runtime/runBatch.ts` (entry pause; settle helper; call sites on every exit path)
- Test: `lib/runtime/runBatch` behavior via execution fixtures (Task 2.5) + a focused unit test if a seam exists

**Design:**
- Entry (all modes, before launching children): `pauseParentTimeGuards(parentStack)`.
- A single `settleParentTimeGuards(parentStack, branchStacks, { charge })` helper: for each parent `TimeGuard`, when `charge` is true find the same-`guardId` TimeGuard on each branch stack, advance the parent by `max(clone.snapshotElapsed())`, then `resume`. Guarded by a per-call settled flag so exactly one settle runs.
- Exit wiring: fork-all values path (next to `propagateBranchCost`) and race winner/loser joins settle WITH charge; thrown errors settle WITH charge from a catch/finally (a branch's own time trip must both charge and resume the parent before the error reaches the guard boundary); interrupted exits mark settled WITHOUT charging or resuming (parent halts and stays paused; final join charges once after resume).

Steps: implement helper + wire exits, run the existing guards suite for no-regression, commit.

## Task 2.4: branch-owned time clones survive serialization

**Files:**
- Modify: `lib/runtime/state/stateStack.ts` (`rehydrateInheritedGuardsFrom` + the guards-serialization slice)
- Test: `lib/runtime/state/stateStack.test.ts` (or nearest existing guards-serialization test file)

**Design:** the slice rule keys on `inheritedGuardCount` and today drops ALL inherited entries at serialize time, re-cloning from the parent on resume. Change: serialize inherited TIME guards (value clones) with the branch; on rehydrate, for each parent guard, adopt the branch's already-deserialized clone when one with the same `guardId` exists (time), else `cloneForBranch` as today (cost = shared ref re-attach). The `inheritedGuardCount` mismatch validation stays, adjusted to count both adopted and re-cloned entries.

Steps: failing serialization round-trip unit test (branch with an accrued time clone → toJSON → fromJSON + rehydrate → clone's elapsedMs preserved, not reset), implement, green, commit.

## Task 2.5: execution fixtures + docs + PR

**Fixtures (`tests/agency/guards/`), all with ≥500ms budgets (CI-jitter margin, per the #547 review):**
- `guard-time-fork-per-branch.agency` — outer time budget; branch A waits on a simulated slow human (longer than the whole budget), branch B does real work; neither trips; both values return. This is the PR 1 limitation reversed.
- `guard-time-fork-remaining-budget.agency` — parent burns most of the budget before forking; a branch working longer than the REMAINder trips, proving clones inherit remaining, not fresh, budget. Assert the failure is the outer guard's `timeoutFailure` (proves branch-trip ownership via the inherited guardId).
- `guard-time-branch-survives-interrupt.agency` — a large time budget; a fork branch takes an interrupt and resumes; no spurious trip and correct value (pins Task 2.4's serialization).
- Full `tests/agency/guards/` sweep + the `nested-pause-*`/`run-max-cost` subprocess fixtures (runBatch touched — the #513 alarm suite must stay green).

**Docs:** `docs/site/guide/guards.md` — delete the PR 1 "current limitation" paragraph; document per-branch semantics (remaining-budget inheritance, parent advances by the longest branch's working time) and the subprocess-input note.

Commit, push branch `guards-per-branch-time`, open the PR referencing the plan.


---

# PR 3 — `--max-cost` / `--max-time` CLI flags

**Context:** Mirror the `--policy` plumbing (commit `9fec82ef1`): resolve flags → set env vars on the spawned child → runtime installs a root guard. Both `agency run` (`lib/cli/commands.ts:328`) and `agency agent` (`lib/cli/runBundledAgent.ts:102`) spawn a child and pass env; both children run through `runNode` in `lib/runtime/node.ts`.

## Task 3.1: Constants + budget resolver

**Files:**
- Modify: `lib/constants.ts` (add env names + exit code)
- Create: `lib/cli/budget.ts` (flag parsing → env values)
- Test: `lib/cli/budget.test.ts` (create)

**Interfaces:**
- Produces:
  - `AGENCY_MAX_COST = "AGENCY_MAX_COST"`, `AGENCY_MAX_TIME = "AGENCY_MAX_TIME"`, `EXIT_CODE_BUDGET_EXCEEDED = 3` in `lib/constants.ts`.
  - `resolveBudget(opts: { maxCost?: string; maxTime?: string }): { maxCost?: string; maxTime?: string }` in `lib/cli/budget.ts` — returns the env-var string values (dollars for cost, milliseconds for time), or throws `Error` on a malformed value. Negative/disable values pass through verbatim (cost `< 0`, time `<= 0`); the runtime install applies the disable rule.
  - `parseDurationMs(s: string): number` in `lib/cli/budget.ts` — parses `30s`/`5m`/`1h`/`500ms`/`-1s` to milliseconds; throws on a bare unitless number.

- [ ] **Step 1: Add constants**

In `lib/constants.ts`, after the `AGENCY_RUN_POLICY*` block:

```ts
/** Env vars carrying `agency run`/`agency agent` --max-cost / --max-time to
 *  the spawned child, which installs a root guard from them. Cleared then set
 *  by the CLI, exactly like AGENCY_RUN_POLICY. */
export const AGENCY_MAX_COST = "AGENCY_MAX_COST";
export const AGENCY_MAX_TIME = "AGENCY_MAX_TIME";

/** Process exit code when a top-level cost/time budget is exceeded. Distinct
 *  from 1 (generic failure) and 2 (usage error). */
export const EXIT_CODE_BUDGET_EXCEEDED = 3;
```

- [ ] **Step 2: Write failing resolver tests**

Create `lib/cli/budget.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { resolveBudget, parseDurationMs } from "@/cli/budget.js";

describe("parseDurationMs", () => {
  test("parses unit-suffixed durations", () => {
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
  });
  test("accepts a leading minus (disable value)", () => {
    expect(parseDurationMs("-1s")).toBe(-1_000);
  });
  test("rejects a bare unitless number", () => {
    expect(() => parseDurationMs("300")).toThrow(/duration/i);
  });
});

describe("resolveBudget", () => {
  test("cost: passes through numeric dollars, incl. 0 and negative", () => {
    expect(resolveBudget({ maxCost: "0.50" }).maxCost).toBe("0.5");
    expect(resolveBudget({ maxCost: "0" }).maxCost).toBe("0");
    expect(resolveBudget({ maxCost: "-1" }).maxCost).toBe("-1");
  });
  test("cost: rejects non-numeric", () => {
    expect(() => resolveBudget({ maxCost: "abc" })).toThrow(/max-cost/i);
  });
  test("time: converts to ms string", () => {
    expect(resolveBudget({ maxTime: "5m" }).maxTime).toBe("300000");
    expect(resolveBudget({ maxTime: "-1s" }).maxTime).toBe("-1000");
  });
  test("time: rejects a bare number", () => {
    expect(() => resolveBudget({ maxTime: "300" })).toThrow(/max-time/i);
  });
  test("omitted flags produce no env values", () => {
    expect(resolveBudget({})).toEqual({});
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test:run lib/cli/budget.test.ts 2>&1 | tee /tmp/pr3-t1.log`
Expected: FAIL — module `@/cli/budget.js` does not exist.

- [ ] **Step 4: Implement the resolver**

Create `lib/cli/budget.ts`:

```ts
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parse a duration string (`30s`, `5m`, `1h`, `500ms`, or a leading-minus
 *  disable value like `-1s`) to milliseconds. A bare unitless number throws:
 *  the CLI requires an explicit unit so a value's meaning is never guessed. */
export function parseDurationMs(s: string): number {
  const m = /^(-?\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(s.trim());
  if (!m) {
    throw new Error(
      `--max-time: expected a duration like 30s, 5m, 1h, or 500ms (got "${s}")`,
    );
  }
  return parseFloat(m[1]) * UNIT_MS[m[2]];
}

/** Resolve --max-cost / --max-time flag strings into the env-var string
 *  values the child reads. Cost stays as dollars; time becomes milliseconds.
 *  Negative/zero pass through — the runtime install applies the disable rule
 *  (cost < 0 disables; time <= 0 disables). */
export function resolveBudget(opts: {
  maxCost?: string;
  maxTime?: string;
}): { maxCost?: string; maxTime?: string } {
  const out: { maxCost?: string; maxTime?: string } = {};
  if (opts.maxCost !== undefined) {
    const n = Number(opts.maxCost);
    if (!Number.isFinite(n)) {
      throw new Error(
        `--max-cost: expected a number of dollars (got "${opts.maxCost}")`,
      );
    }
    out.maxCost = String(n);
  }
  if (opts.maxTime !== undefined) {
    out.maxTime = String(parseDurationMs(opts.maxTime));
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test:run lib/cli/budget.test.ts 2>&1 | tee /tmp/pr3-t1.log`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/constants.ts lib/cli/budget.ts lib/cli/budget.test.ts
git commit -F /tmp/commit-3-1.txt
```

`/tmp/commit-3-1.txt`:

```
Add budget flag resolver + constants for --max-cost/--max-time

resolveBudget parses the flags into env-var values (dollars, ms) with
strict validation; a bare unitless --max-time is a usage error. Adds
AGENCY_MAX_COST/AGENCY_MAX_TIME env names and EXIT_CODE_BUDGET_EXCEEDED=3.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

## Task 3.2: Install the root guard from env in the runtime

**Files:**
- Create: `lib/runtime/rootBudget.ts` (read env → push guards)
- Modify: `lib/runtime/node.ts:355` (call the installer next to `installRunPolicyHandler`)
- Test: `lib/runtime/rootBudget.test.ts` (create)

**Interfaces:**
- Consumes: `AGENCY_MAX_COST`, `AGENCY_MAX_TIME` (`lib/constants.ts`); `StateStack.pushGuard`; `CostGuard`, `TimeGuard`; the root-process gate used by `installRunPolicyHandler` (read `lib/runtime/runPolicyHandler.ts` + `lib/runtime/node.ts:352` to reuse the exact "root process, not IPC subprocess" condition).
- Produces: `installRootBudget(stack: StateStack): void` in `lib/runtime/rootBudget.ts` — pushes a `CostGuard` when `AGENCY_MAX_COST` parses to `>= 0`, and a `TimeGuard` when `AGENCY_MAX_TIME` parses to `> 0`. No-op when the env vars are absent or in the disable range, or when not the root process.

- [ ] **Step 1: Write failing tests**

Create `lib/runtime/rootBudget.test.ts`:

```ts
import { describe, test, expect, afterEach } from "vitest";
import { installRootBudget } from "@/runtime/rootBudget.js";
import { StateStack } from "@/runtime/state/stateStack.js";
import { CostGuard, TimeGuard } from "@/runtime/guard.js";
import { AGENCY_MAX_COST, AGENCY_MAX_TIME } from "@/constants.js";

afterEach(() => {
  delete process.env[AGENCY_MAX_COST];
  delete process.env[AGENCY_MAX_TIME];
});

describe("installRootBudget", () => {
  test("pushes a CostGuard for a non-negative cost", () => {
    process.env[AGENCY_MAX_COST] = "0.5";
    const stack = new StateStack();
    installRootBudget(stack);
    expect(stack.guards.some((g) => g instanceof CostGuard)).toBe(true);
  });
  test("cost 0 still installs (local-only limit)", () => {
    process.env[AGENCY_MAX_COST] = "0";
    const stack = new StateStack();
    installRootBudget(stack);
    expect(stack.guards.some((g) => g instanceof CostGuard)).toBe(true);
  });
  test("negative cost installs nothing", () => {
    process.env[AGENCY_MAX_COST] = "-1";
    const stack = new StateStack();
    installRootBudget(stack);
    expect(stack.guards.length).toBe(0);
  });
  test("time <= 0 installs nothing; time > 0 installs a TimeGuard", () => {
    process.env[AGENCY_MAX_TIME] = "0";
    const s1 = new StateStack();
    installRootBudget(s1);
    expect(s1.guards.length).toBe(0);

    process.env[AGENCY_MAX_TIME] = "5000";
    const s2 = new StateStack();
    installRootBudget(s2);
    expect(s2.guards.some((g) => g instanceof TimeGuard)).toBe(true);
  });
  test("no env vars: no guards", () => {
    const stack = new StateStack();
    installRootBudget(stack);
    expect(stack.guards.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/runtime/rootBudget.test.ts 2>&1 | tee /tmp/pr3-t2.log`
Expected: FAIL — `@/runtime/rootBudget.js` does not exist.

- [ ] **Step 3: Implement the installer**

Create `lib/runtime/rootBudget.ts`:

```ts
import { AGENCY_MAX_COST, AGENCY_MAX_TIME } from "../constants.js";
import { CostGuard, TimeGuard } from "./guard.js";
import type { StateStack } from "./state/stateStack.js";

/** Install a root cost/time guard from AGENCY_MAX_COST / AGENCY_MAX_TIME.
 *  Applies the disable rule: cost < 0 installs nothing; time <= 0 installs
 *  nothing (cost 0 IS a real limit — no paid spend). Called once at the
 *  root, wrapping the node body — the same place installRunPolicyHandler
 *  runs. The caller gates on the root-process condition. */
export function installRootBudget(stack: StateStack): void {
  const rawCost = process.env[AGENCY_MAX_COST];
  if (rawCost !== undefined) {
    const cost = Number(rawCost);
    if (Number.isFinite(cost) && cost >= 0) {
      stack.pushGuard(new CostGuard(cost));
    }
  }
  const rawTime = process.env[AGENCY_MAX_TIME];
  if (rawTime !== undefined) {
    const ms = Number(rawTime);
    if (Number.isFinite(ms) && ms > 0) {
      stack.pushGuard(new TimeGuard(ms));
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run lib/runtime/rootBudget.test.ts 2>&1 | tee /tmp/pr3-t2.log`
Expected: PASS.

- [ ] **Step 5: Wire the installer into `runNode`**

In `lib/runtime/node.ts`, read how `installRunPolicyHandler(execCtx)` at line 355 gates on the root process (it no-ops for IPC subprocesses). Install the root budget on the top-level stack under the SAME gate, right after that call. Use `execCtx`'s top-level stack (the same stack the root policy handler is installed against — confirm the field name by reading the surrounding code; it is the `ctx.stateStack` / exec-context root stack, NOT an ALS branch stack):

```ts
  installRunPolicyHandler(execCtx);
  // Install a root cost/time budget from --max-cost / --max-time (via env).
  // Same root-only gate as the policy handler: no-op in IPC subprocesses,
  // whose budgets are owned by the parent's guard. Outermost, before the
  // node body runs, so it cannot be bypassed.
  installRootBudget(<the exec-context root StateStack>);
```

> Implementer note: verify the correct stack handle by reading `node.ts` around the `execCtx` creation and how `installRunPolicyHandler` reaches the root. If the root-process gate lives inside `installRunPolicyHandler`, replicate that same guard-condition here (extract it to a shared `isRootProcess()` helper if it is inline, to keep one source of truth).

- [ ] **Step 6: Build and smoke-test the install**

Create a scratch program `/tmp/budget-smoke.agency`:

```
node main() {
  llm("say hi")
  return "done"
}
```

Run (should trip on the zero-cost / local-only rule with a hosted model):
`AGENCY_MAX_COST=0 pnpm run agency /tmp/budget-smoke.agency 2>&1 | tee /tmp/pr3-smoke.log`
Expected: a cost trip (the paid `llm` call exceeds the `$0` budget). Full user-facing message + exit code come in Task 3.3.

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/rootBudget.ts lib/runtime/rootBudget.test.ts lib/runtime/node.ts
git commit -F /tmp/commit-3-2.txt
```

`/tmp/commit-3-2.txt`:

```
Install a root cost/time guard from env at run start

installRootBudget reads AGENCY_MAX_COST/AGENCY_MAX_TIME and pushes a
root CostGuard/TimeGuard (applying the disable rule), wrapping the node
body next to the run-policy handler under the same root-process gate.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

## Task 3.3: Report a budget trip with exit code 3

**Files:**
- Create: `lib/runtime/budgetExit.ts` (format message + exit)
- Modify: `lib/backends/typescriptBuilder.ts:4440-4453` (the compiled entry's catch)
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache` (import the new symbols into generated code)
- Test: `lib/runtime/budgetExit.test.ts` (create)
- Test: `lib/cli/budgetRun.spawn.test.ts` (create; end-to-end)

**Interfaces:**
- Consumes: `isGuardExceededError` (`lib/runtime/guard.ts:493`), `GuardExceededError` fields `type`/`limit`/`spent`, `EXIT_CODE_BUDGET_EXCEEDED`.
- Produces: `reportBudgetExceededAndExit(error: unknown): void` in `lib/runtime/budgetExit.ts` — if `error` is a `GuardExceededError`, print the user-facing overrun message and `process.exit(3)`; otherwise return (caller falls through to its existing crash handling).

- [ ] **Step 1: Write failing tests for the reporter**

Create `lib/runtime/budgetExit.test.ts`:

```ts
import { describe, test, expect, vi } from "vitest";
import { formatBudgetExceeded } from "@/runtime/budgetExit.js";
import { GuardExceededError } from "@/runtime/guard.js";

describe("formatBudgetExceeded", () => {
  test("cost message", () => {
    const e = new GuardExceededError("cost", 0.5, 0.63, "g1");
    expect(formatBudgetExceeded(e)).toBe(
      "Exceeded cost limit of $0.5 (used $0.63)",
    );
  });
  test("time message renders ms", () => {
    const e = new GuardExceededError("time", 5000, 5002, "g1");
    expect(formatBudgetExceeded(e)).toBe(
      "Exceeded time limit of 5000ms (ran 5002ms)",
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/runtime/budgetExit.test.ts 2>&1 | tee /tmp/pr3-t3.log`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the reporter**

Create `lib/runtime/budgetExit.ts`:

```ts
import { EXIT_CODE_BUDGET_EXCEEDED } from "../constants.js";
import { isGuardExceededError, GuardExceededError } from "./guard.js";

/** User-facing one-line message for a tripped top-level budget. */
export function formatBudgetExceeded(e: GuardExceededError): string {
  if (e.type === "cost") {
    return `Exceeded cost limit of $${e.limit} (used $${e.spent})`;
  }
  return `Exceeded time limit of ${e.limit}ms (ran ${e.spent}ms)`;
}

/** If `error` is a top-level budget trip, report it and exit with code 3.
 *  Otherwise return so the caller can handle it as an ordinary crash. Only a
 *  ROOT guard (no owning try) reaches here — a user guard() trip is always
 *  converted to a Result by _runGuarded, so this never misfires on those. */
export function reportBudgetExceededAndExit(error: unknown): void {
  if (isGuardExceededError(error)) {
    console.error(formatBudgetExceeded(error));
    process.exit(EXIT_CODE_BUDGET_EXCEEDED);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:run lib/runtime/budgetExit.test.ts 2>&1 | tee /tmp/pr3-t3.log`
Expected: PASS.

- [ ] **Step 5: Import the symbols into generated code**

In `lib/templates/backends/typescriptGenerator/imports.mustache`, add `reportBudgetExceededAndExit` to the runtime import list (the block that already imports `runNode`, `success`, `__tryCall`, etc. — see line 12/25). Rebuild templates after: `pnpm run templates`.

- [ ] **Step 6: Prepend the budget check to the compiled entry's catch**

In `lib/backends/typescriptBuilder.ts`, in the `ts.tryCatch(...)` catch body (currently line 4440: `consoleError("Agent crashed: ...")` then `throw`), emit a call to `reportBudgetExceededAndExit(__error)` BEFORE the existing `console.error` + `throw`. Since it `process.exit(3)`s on a budget trip, it never returns in that case; any other error falls through to the existing crash path. Concretely, prepend to the catch `ts.statements([...])`:

```ts
ts.exprStatement(
  ts.call(ts.id("reportBudgetExceededAndExit"), [ts.id("__error")]),
),
```

(Match the existing `ts.*` builder style in this file; grep nearby for `ts.call(ts.id(` usage.)

- [ ] **Step 7: Regenerate fixtures**

Run: `make 2>&1 | tail -5 && make fixtures 2>&1 | tail -20 | tee /tmp/pr3-fixtures.log`
Expected: fixtures rebuild. Inspect the diff (`git diff --stat tests/`) — every compiled fixture that has a `main` should gain the `reportBudgetExceededAndExit(__error)` line in its entry catch, and nothing else should change.

- [ ] **Step 8: Write the end-to-end spawn test**

Create `lib/cli/budgetRun.spawn.test.ts`, modeled on `lib/cli/runPolicy.spawn.test.ts` (read it first for the spawn/tmp-file harness). It should:
- Write a tiny `.agency` program that makes one paid `llm` call (or, to avoid an LLM call, a program that `sleep`s past a small `--max-time`).
- Run `agency run --max-time 20ms <file>` via the CLI entry.
- Assert exit code is `3` and stderr contains `Exceeded time limit`.
- A second case: set `AGENCY_MAX_TIME` in the parent env, run WITHOUT the flag, and assert it is cleared (does not leak) so the run completes normally.

```ts
// Sketch — fill in using runPolicy.spawn.test.ts's harness:
test("--max-time trip exits 3 with a budget message", async () => {
  const file = writeTmpAgency(`
node main() {
  sleep(200ms)
  return "done"
}`);
  const { code, stderr } = await runCli(["run", "--max-time", "20ms", file]);
  expect(code).toBe(3);
  expect(stderr).toMatch(/Exceeded time limit/);
});
```

- [ ] **Step 9: Run the spawn test**

Run: `pnpm test:run lib/cli/budgetRun.spawn.test.ts 2>&1 | tee /tmp/pr3-spawn.log`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add lib/runtime/budgetExit.ts lib/runtime/budgetExit.test.ts lib/backends/typescriptBuilder.ts lib/templates/backends/typescriptGenerator/imports.mustache lib/templates/backends/typescriptGenerator/imports.ts lib/cli/budgetRun.spawn.test.ts tests/
git commit -F /tmp/commit-3-3.txt
```

`/tmp/commit-3-3.txt`:

```
Report a top-level budget trip with exit code 3

A root-guard trip escaping to the compiled entry's catch now prints a
user-facing overrun message and exits 3 (distinct from 1/2). Only root
guards reach here; user guard() trips are already converted to Results.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

## Task 3.4: Wire the flags into `agency run` and `agency agent`

**Files:**
- Modify: `scripts/agency.ts` (add `--max-cost`/`--max-time` options to `run` and `agent`; pass resolved values down)
- Modify: `lib/cli/commands.ts:328` (`run` sets the env vars, cleared-then-set)
- Modify: `lib/cli/runBundledAgent.ts:102` (`runBundledAgent` sets the env vars)
- Docs: `docs/site/cli/` (run/agent flag docs) + `docs/site/guide/guards.md`

**Interfaces:**
- Consumes: `resolveBudget` (Task 3.1); `AGENCY_MAX_COST`, `AGENCY_MAX_TIME`.
- Produces: `run(config, inputFile, outputFile?, resumeFile?, runPolicy?, budget?)` gains a `budget?: { maxCost?: string; maxTime?: string }` param; `runBundledAgent(..., budget?)` likewise.

- [ ] **Step 1: Add options to the `run` command**

In `scripts/agency.ts`, extend `RunOptions` and add the two options where `--policy` is declared (around line 280):

```ts
type RunOptions = CliFlags & {
  resume?: string;
  policy?: string;
  approve?: string;
  reject?: string;
  interactive?: boolean;
  maxCost?: string;
  maxTime?: string;
};
```

```ts
      .option(
        "--max-cost <dollars>",
        "Abort if the run's LLM spend exceeds this many dollars (e.g. 0.50). 0 = no paid spend (local models only); negative = no limit",
      )
      .option(
        "--max-time <duration>",
        "Abort if the run's working time exceeds this duration (e.g. 30s, 5m, 1h, 500ms). Time spent waiting for input is not counted; negative/0 = no limit",
      )
```

- [ ] **Step 2: Resolve + pass the budget in `runWithOptions`**

In `runWithOptions` (around line 165), after resolving `runPolicy`:

```ts
    let budget;
    try {
      budget = resolveBudget({ maxCost: options.maxCost, maxTime: options.maxTime });
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(2);
    }
    run(config, input, undefined, options.resume, runPolicy, budget);
```

Add `import { resolveBudget } from "@/cli/budget.js";` at the top.

- [ ] **Step 3: Set the env vars in `commands.ts` `run`**

In `lib/cli/commands.ts`, extend the `run` signature and env setup (mirror the `AGENCY_RUN_POLICY` clear-then-set at lines 351-358):

```ts
export function run(
  config: AgencyConfig,
  inputFile: string,
  outputFile?: string,
  resumeFile?: string,
  runPolicy?: { policyJson: string; interactive: boolean },
  budget?: { maxCost?: string; maxTime?: string },
): void {
```

```ts
  delete env[AGENCY_MAX_COST];
  delete env[AGENCY_MAX_TIME];
  if (budget?.maxCost !== undefined) env[AGENCY_MAX_COST] = budget.maxCost;
  if (budget?.maxTime !== undefined) env[AGENCY_MAX_TIME] = budget.maxTime;
```

Add `AGENCY_MAX_COST, AGENCY_MAX_TIME` to the `@/constants.js` import at the top of the file.

- [ ] **Step 4: Add options to the `agent` command**

In `scripts/agency.ts`, the `agent` command currently forwards raw `args`. Add `--max-cost`/`--max-time` as declared options and resolve them into env values passed to `runBundledAgent`. Because the agent forwards unknown args to the bundled agent, add these two as FIRST-CLASS commander options on the `agent` command (so commander parses them out), then resolve with `resolveBudget` and hand the result to `agent(config, args, budget)`.

```ts
    .command("agent")
    .description("Launch the Agency language assistant agent (run `agency agent --help` for agent flags)")
    .argument("[args...]", "Arguments forwarded to the agent")
    .option("--max-cost <dollars>", "Abort if the agent's LLM spend exceeds this many dollars (0 = local only; negative = no limit)")
    .option("--max-time <duration>", "Abort if the agent's working time exceeds this duration (e.g. 30m); input-wait is not counted; negative/0 = no limit")
    .helpOption(false)
    .action((args: string[], opts: { maxCost?: string; maxTime?: string }) => {
      const config = getConfig();
      let budget;
      try {
        budget = resolveBudget({ maxCost: opts.maxCost, maxTime: opts.maxTime });
      } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        process.exit(2);
      }
      agent(config, args, budget);
    });
```

> Implementer note: confirm `--max-time`'s leading-minus value isn't swallowed by commander as an unknown flag. If `--max-time -1s` mis-parses, document that disabling on the CLI uses `--max-time=-1s` (attached form), and add a test for the attached form.

- [ ] **Step 5: Thread the budget through `agent` → `runBundledAgent`**

In `lib/cli/agent.ts`:

```ts
export function agent(
  config: AgencyConfig,
  args: string[] = [],
  budget?: { maxCost?: string; maxTime?: string },
): void {
  runBundledAgent(config, "agency-agent", args, {}, budget);
}
```

In `lib/cli/runBundledAgent.ts`, add a `budget` param and set the env vars (cleared-then-set) alongside the existing `env` setup (around line 129):

```ts
export function runBundledAgent(
  config: AgencyConfig,
  agentName: string,
  args: string[] = [],
  deps: { spawn?: typeof realSpawn } = {},
  budget?: { maxCost?: string; maxTime?: string },
): void {
  // ...
  delete env[AGENCY_MAX_COST];
  delete env[AGENCY_MAX_TIME];
  if (budget?.maxCost !== undefined) env[AGENCY_MAX_COST] = budget.maxCost;
  if (budget?.maxTime !== undefined) env[AGENCY_MAX_TIME] = budget.maxTime;
```

Add the `@/constants.js` import.

- [ ] **Step 6: Build and end-to-end test both commands**

Run: `make 2>&1 | tail -5`
Then verify `run`:
`pnpm run agency run --max-time 20ms /tmp/budget-smoke-sleep.agency; echo "exit=$?"`
(where the program sleeps 200ms) — expect the overrun message and `exit=3`.

Then verify usage errors:
`pnpm run agency run --max-time 300 /tmp/budget-smoke.agency; echo "exit=$?"` — expect a `--max-time` error and `exit=2`.

Save output: append `2>&1 | tee -a /tmp/pr3-e2e.log` to each.

- [ ] **Step 7: Add a CLI parse test for the agent command**

Create/extend a commander test (grep for an existing `createProgram` test in `scripts/` or `lib/cli/`) asserting `agency agent --max-cost 0.5 foo` resolves `budget.maxCost === "0.5"` and forwards `["foo"]` to the agent. If the agent command has no existing unit test harness, cover this via a `runBundledAgent` spawn test with an injected `spawn` dep (see `runBundledAgent`'s `deps.spawn`) asserting the env vars are set on the spawned child.

- [ ] **Step 8: Run the CLI test**

Run: `pnpm test:run <the test file> 2>&1 | tee /tmp/pr3-cli.log`
Expected: PASS.

- [ ] **Step 9: Update docs**

- `docs/site/guide/guards.md`: add a short "From the command line" section noting `--max-cost`/`--max-time` on `agency run` and `agency agent`, the `cost: 0` local-only trick, and exit code 3.
- CLI reference pages under `docs/site/cli/` for `run` and `agent`: document both flags, units, and the disable (negative) values.

- [ ] **Step 10: Commit**

```bash
git add scripts/agency.ts lib/cli/commands.ts lib/cli/agent.ts lib/cli/runBundledAgent.ts docs/site/
git commit -F /tmp/commit-3-4.txt
```

`/tmp/commit-3-4.txt`:

```
Add --max-cost / --max-time to agency run and agency agent

Flags resolve to AGENCY_MAX_COST/AGENCY_MAX_TIME on the spawned child
(cleared-then-set like --policy), which installs a root guard. A tripped
budget aborts with exit code 3. Negative disables; cost 0 = local-only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Self-review notes (author)

- **Spec §1 flags** → PR 3 Tasks 3.1/3.4. **§2 runtime install** → 3.2. **§3 trip + exit 3** → 3.3. **§4 input-wait** → PR 1 Task 1.2. **§5 disable rule** → PR 1 Task 1.1 (time-zero delta; negative already done). **§5 cost:0 local-only** → covered by existing strict `>` check, tested in 3.2 + documented in 3.4. **§5 per-branch time** → PR 2. **Testing** section → fixtures across all three PRs.
- **Known risk carried into execution:** PR 2's fork-join accounting (Task 2.1) and the exact root stack handle in `node.ts` (Task 3.2 Step 5) require in-task verification — both are flagged with explicit investigation steps rather than guessed code.
- **Fixture regeneration:** Task 3.3 changes codegen and requires `make fixtures`; the diff must be inspected to confirm only the entry-catch line changed.
