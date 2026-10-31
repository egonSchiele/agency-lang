# safeBash: record what every call decided (ADI-238) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `safeBash` call logs which decision `planFor` made and why, and a rejected broad command tells the model, in a sentence, why it could not be narrowed.

**Architecture:** `planFor` already computes a failure message for every unrecognized command and discards it, and already holds the flattened command list. The `Plan` record gains two facts about the decision: `broadReason`, a small record (a kind and a detail) or null, and `verbs`, the command words `planFor` decided over. An Agency function `outcomeOf(plan)` names the outcome with an exhaustive match over the `Execution` union, so a new execution kind breaks the build there as it already does in `safeBash`. A generic `_debug(message, data)` bridge beside `_turnStart` in `lib/stdlib/statelog.ts` posts the run's existing `debug` statelog event; nothing in it knows about safeBash. The rejection message comes from one sentence table keyed by the reason's kind.

**Tech Stack:** Agency (`stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`), TypeScript bridge in `lib/stdlib/statelog.ts`, vitest, Agency execution tests.

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-reads/packages/agency-lang/docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`, Part 3 and the end of Part 6. Linear: ADI-238. Review: the sibling `-REVIEW.md`; its three changes are folded in here.

## Global Constraints

- Nothing raises or runs before `planFor` returns. The log call sits between `planFor` and the refusal check, so a refused plan is logged too.
- The event is the generic `debug` event, message `safeBash plan`. No method is added to `lib/statelogClient.ts`. Observability off is already covered by the client being a no-op (`_isLogging` in `lib/stdlib/statelog.ts`); nothing new to pin.
- Outside an Agency run the bridge is a no-op, as `_turnStart` is.
- Agency has no `?.` operator. A nullable record is read with an `if`.
- `make` after every change to a `.agency` file; `pnpm run build` after a change to a `.ts` file the Agency tests import; `pnpm run typecheck`, `pnpm run lint:structure`, and prettier on the named `.ts` files before pushing.
- Dev docs record mechanism and rule, never history.
- The spec's "names the read tools when every verb was a read-family verb" clause waits for ADI-242 and ADI-244, which introduce the read-family table. This slice appends the reason sentence only.

## Review Focus

- A command that is unparseable: `broadReason` is `{ kind: "unparseable", detail: <parser message> }` and `verbs` is `[]`. Pinned in Task 1.
- A string of echoes that falls to `std::bash` by the audit rule: kind `noEffects`, and the model's sentence must not claim an unrecognized command. Pinned in Tasks 1 and 3.
- A refused command: outcome `refuse`, `broadReason` null, nothing raised, still logged. Pinned in Tasks 1 and 2.
- A rejection of a narrow question (`std::git::status`) has no reason to append; the failure must read as it does today. Pinned in Task 3.
- An assignment-only command (`FOO=bar`) has no command word; `verbs` carries `""` for it so the list stays aligned with the commands. Pinned in Task 1.

---

### Task 1: `Plan.broadReason`, `Plan.verbs`, and `outcomeOf`

**Files:**
- Modify: `stdlib/safeBash/actions.agency` (the `Plan` type, a new `BroadReason` type)
- Modify: `stdlib/safeBash.agency` (`bashPlan`, `refusePlan`, `echoPlan`, `writePlan`, `agencyCommandPlan`, `planFor`; new `broadPlan`, `verbNames`, `outcomeOf`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Produces, in `actions.agency`:

```
export type BroadReason = {
  kind: "unparseable" | "unrecognized" | "noEffects" | "unrenderable";
  detail: string
}

export type Plan = {
  effects: Effect[];
  execution: Execution;
  /** Why the plan asks the broad std::bash question, or null when it does not. */
  broadReason: BroadReason | null;
  /** The command word of every simple command planFor decided over, in
   *  order; "" for an assignment-only command; [] when unparseable. */
  verbs: string[]
}
```

- Produces, in `safeBash.agency`: `def broadPlan(command: string, verbs: string[], reason: BroadReason): Plan`; `def verbNames(commands: SimpleCommand[]): string[]`; `export def outcomeOf(plan: Plan): string` returning `refuse`, `shellFree`, `agency`, `narrow`, or `broad`.
- `detail` is the parser message for `unparseable`, the first `why` from `effectsFor` for `unrecognized` (for example ``no rule for `xargs` ``), the `why` from `rebuild` for `unrenderable`, and `""` for `noEffects`.

- [ ] **Step 1: Write the failing plan tests**

Add to `tests/agency/safeBash.agency`:

```
def planReason(source: string): any {
  const plan = planFor(source, "/repo")
  if (plan.broadReason == null) {
    return null
  }
  return [plan.broadReason.kind, plan.broadReason.detail]
}

def planOutcome(source: string): string {
  return outcomeOf(planFor(source, "/repo"))
}

node planReasons() {
  return [
    planReason("git status"),
    planReason("xargs rm x"),
    planReason("echo hi; echo bye"),
    planReason("echo $(date)"),
    planReason("rm -rf build"),
    planReason("git status; xargs rm x"),
  ]
}

node planVerbs() {
  return [
    planFor("git status; xargs rm x", "/repo").verbs,
    planFor("echo $(date)", "/repo").verbs,
    planFor("FOO=bar", "/repo").verbs,
    planFor("rm -rf build", "/repo").verbs,
  ]
}

node planOutcomes() {
  return [
    planOutcome("git status"),
    planOutcome("xargs rm x"),
    planOutcome("echo hi"),
    planOutcome("echo hi > out.txt"),
    planOutcome("rm -rf build"),
    planOutcome("agency typecheck foo.agency"),
    planOutcome("echo hi; echo bye"),
  ]
}
```

Expected outputs in `tests/agency/safeBash.test.json`:

- `planReasons`: `[null,["unrecognized","no rule for `xargs`"],["noEffects",""],["unparseable","Unexpected input after commands: \"$(date)\""],null,["unrecognized","no rule for `xargs`"]]`. The parser message is the review's traced value; confirm it by running `pnpm run agency` on a one-line file that prints `bashParser("echo $(date)")` and paste what it prints if it differs.
- `planVerbs`: `[["git","xargs"],[],[""],["rm"]]`
- `planOutcomes`: `["narrow","broad","shellFree","shellFree","refuse","agency","broad"]`

- [ ] **Step 2: Run the test to see it fail**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/safebash-t1.txt 2>&1; grep -n "planReasons\|planVerbs\|planOutcomes" -A3 /tmp/safebash-t1.txt`
Expected: FAIL, `broadReason` is not a field of `Plan`.

- [ ] **Step 3: Add `BroadReason` and the two fields to `Plan` in `stdlib/safeBash/actions.agency`**

As in the Interfaces block, with the two doc comments.

- [ ] **Step 4: Fill the fields in `stdlib/safeBash.agency`**

- `verbNames(commands: SimpleCommand[]): string[]` is a comprehension over the list: the command word's text, or `""` when `command` is null.
- `bashPlan(command: string, effects: Effect[], verbs: string[], reason: BroadReason | null): Plan` writes both fields. Its audit rule (empty effects become `[BASH_EFFECT]`) is unchanged.
- `broadPlan(command, verbs, reason)` is `bashPlan(command, [BASH_EFFECT], verbs, reason)`.
- `refusePlan(reason: string, verbs: string[])`, `echoPlan`, `writePlan`, and `agencyCommandPlan` set `broadReason: null` and their `verbs`: the single command's word for the three single-command builders (`verbNames([command])`), and the flattened list's names for `refusePlan`, passed by `planFor`.
- In `planFor`: compute `const verbs = verbNames(simple)` right after `flattenCommands`; the unparseable branch uses `broadPlan(source, [], { kind: "unparseable", detail: why })` before any flatten; the loop keeps the first `why` from `effectsFor` in `let firstMiss = ""` and the `!allRecognized` branch uses `{ kind: "unrecognized", detail: firstMiss }`; the `narrow.length == 0` branch `{ kind: "noEffects", detail: "" }`; the `rebuilt is failure(why)` branch `{ kind: "unrenderable", detail: why }`; the final narrow plan `bashPlan(rebuilt.value, narrow, verbs, null)`.
- `outcomeOf(plan)` is an exhaustive `match(plan.execution.kind)` with no catch-all: `"refuse" => "refuse"`, `"echo" => "shellFree"`, `"write" => "shellFree"`, `"agency" => "agency"`, and the `"bash"` arm returning `"broad"` when `plan.broadReason != null` and `"narrow"` otherwise. Place it next to `planFor` and export it.

- [ ] **Step 5: `make`, then run the test to see it pass**

Run: `make > /tmp/make-t1.txt 2>&1; tail -3 /tmp/make-t1.txt; AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/safebash-t1.txt 2>&1; tail -5 /tmp/safebash-t1.txt`
Expected: every case passes, including the existing ones.

- [ ] **Step 6: Commit**

```bash
git add stdlib/safeBash/actions.agency stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -F /tmp/msg.txt   # "safeBash: a plan records why it went broad, its verbs, and its outcome"
```

---

### Task 2: The `debug` event

**Files:**
- Modify: `lib/stdlib/statelog.ts` (new `_debug`)
- Modify: `stdlib/statelog.agency` (export `_debug` is not needed; safeBash imports the bridge directly)
- Modify: `stdlib/safeBash.agency` (`safeBash`, between `planFor` and the refusal check)
- Test: `lib/stdlib/statelog.test.ts`

**Interfaces:**
- Consumes: `Plan.broadReason`, `Plan.verbs`, `outcomeOf` from Task 1; `currentRunOrNone()` from `lib/runtime/asyncContext.ts`; `run.log.debug(message: string, data: any)`.
- Produces: `export async function _debug(message: string, data: unknown): Promise<void>` in `lib/stdlib/statelog.ts`, the fourth function there with the `currentRunOrNone` no-op shape. The event data safeBash sends: `{ command, cwd, outcome, reason, detail, verbs, effects }` where `reason` is the kind or `""`, `detail` is the detail or `""`, and `effects` is the list of effect names.

- [ ] **Step 1: Write the failing unit test**

In `lib/stdlib/statelog.test.ts`, add a `debug` spy to `spyClient` and:

```ts
it("_debug posts a debug event with the message and data it was given", async () => {
  const threads = ThreadStore.withDefaultActive(makeCtx().statelogClient);
  await withFrame(threads, async (spies) => {
    await _debug("safeBash plan", { outcome: "broad" });
    expect(spies.debug).toHaveBeenCalledOnce();
    expect(spies.debug).toHaveBeenCalledWith("safeBash plan", { outcome: "broad" });
  });
});

it("_debug is a no-op outside a run", async () => {
  await expect(_debug("x", {})).resolves.toBeUndefined();
});
```

Match the way the existing `turnStart` test builds its frame.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run lib/stdlib/statelog.test.ts > /tmp/safebash-t2.txt 2>&1; tail -8 /tmp/safebash-t2.txt`
Expected: FAIL, `_debug` is not exported.

- [ ] **Step 3: Implement `_debug` beside `_turnStart`**

Three lines in the shape of `_turnStart`: get the frame, return if none, `await frame.log.debug(message, data)`.

- [ ] **Step 4: Run the unit test to see it pass, then `pnpm run build`**

Run: `pnpm vitest run lib/stdlib/statelog.test.ts > /tmp/safebash-t2.txt 2>&1; tail -4 /tmp/safebash-t2.txt; pnpm run build > /tmp/build-t2.txt 2>&1; tail -2 /tmp/build-t2.txt`
Expected: PASS; build clean.

- [ ] **Step 5: Call it from `safeBash`**

Import `_debug` from `agency-lang/stdlib-lib/statelog.js`. In `safeBash`, after `const plan = planFor(command, dir)` and before `if (exec is { kind: "refuse", reason })`, build the data with an `if` on `plan.broadReason` for the two reason fields and `[e.name for e in plan.effects]` for the effects, and call `_debug("safeBash plan", data)`. The comment above it says the call sits above the refusal check on purpose, so a refused plan is logged.

- [ ] **Step 6: `make`; run the safeBash Agency tests to confirm nothing changed**

Run: `make > /tmp/make-t2.txt 2>&1; tail -3 /tmp/make-t2.txt; AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/safebash-t2b.txt 2>&1; tail -5 /tmp/safebash-t2b.txt`
Expected: all pass. The outcome mapping is pinned by `planOutcomes` in Task 1; the bridge by the unit test.

- [ ] **Step 7: Commit**

```bash
git add lib/stdlib/statelog.ts lib/stdlib/statelog.test.ts stdlib/safeBash.agency
git commit -F /tmp/msg.txt   # "safeBash: log every plan as a debug event"
```

---

### Task 3: The rejection message carries the reason

**Files:**
- Modify: `stdlib/safeBash.agency` (a `BROAD_SENTENCES` table and the `raised is failure(why)` branch of `safeBash`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `Plan.broadReason` from Task 1.
- Produces: a `static const BROAD_SENTENCES` keyed by `BroadReason.kind`:

```
static const BROAD_SENTENCES = {
  unparseable: "the command could not be parsed",
  unrecognized: "it has no rule for one of the commands",
  noEffects: "every command was recognized but none needs an approval of its own, so the shell itself had to be approved",
  unrenderable: "the parsed command could not be rendered back to text"
}
```

  and `def broadExplanation(reason: BroadReason): string` returning `"safeBash could not ask a narrower question because ${sentence}${suffix}."` where `suffix` is `": ${reason.detail}"` when the detail is non-empty and `""` otherwise. When `raiseAll` fails and `plan.broadReason` is non-null, the failure is `"${why} ${broadExplanation(plan.broadReason)}"`; otherwise `why` unchanged.

- [ ] **Step 1: Write the failing end-to-end tests**

```
node rejectedBroadSaysWhy() {
  const result = safeBash("xargs echo hi")
  if (result is failure(why)) {
    return why
  }
  return "UNEXPECTEDLY RAN"
}

node rejectedAuditSaysWhy() {
  const result = safeBash("echo hi; echo bye")
  if (result is failure(why)) {
    return why
  }
  return "UNEXPECTEDLY RAN"
}

node rejectedNarrowIsUnchanged() {
  const result = safeBash("git status")
  if (result is failure(why)) {
    return why
  }
  return "UNEXPECTEDLY RAN"
}
```

In `tests/agency/safeBash.test.json`, each gets `interruptHandlers: [{ "action": "reject", "expectedMessage": ... }]` with the `std::bash` message for the first two and `Show git status` for the third. The rejection text comes from the test runner's reject handler, not from safeBash (`renderVerdict` in `lib/runtime/interrupts.ts` passes the handler's value through), so run once with a placeholder `expectedOutput` to capture it, then set:

- first: that text plus `` safeBash could not ask a narrower question because it has no rule for one of the commands: no rule for `xargs`.``
- second: that text plus ` safeBash could not ask a narrower question because every command was recognized but none needs an approval of its own, so the shell itself had to be approved.`
- third: that text unchanged.

- [ ] **Step 2: Run to see the first two fail and the third pass**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/safebash-t3.txt 2>&1; grep -n "rejected" -A3 /tmp/safebash-t3.txt`

- [ ] **Step 3: Add the table, `broadExplanation`, and the branch**

In the `raised is failure(why)` branch: `if (plan.broadReason == null) { return failure(why) }` then return the composed failure.

- [ ] **Step 4: `make`; run the tests to see all pass**

Run: `make > /tmp/make-t3.txt 2>&1; tail -3 /tmp/make-t3.txt; AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/safebash-t3.txt 2>&1; tail -5 /tmp/safebash-t3.txt`

- [ ] **Step 5: Commit**

```bash
git add stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -F /tmp/msg.txt   # "safeBash: a rejected broad command says why it stayed broad"
```

---

### Task 4: The dev doc and the indexes

**Files:**
- Create: `docs/dev/stdlib/safe-bash.md`
- Modify: `CLAUDE.md` (Standard library section, after the `grep-flags.md` line), `.claude/skills/agency-stdlib-docs/SKILL.md` (same line; the file is tracked and not ignored, plain `git add`)
- Modify: `docs/superpowers/specs/2026-07-26-safebash-classifier-design.md` (status line)

- [ ] **Step 1: Write `docs/dev/stdlib/safe-bash.md`**

Sections, mechanism and rule only: what `planFor` returns and why nothing runs inside it; the five rules from the spec's "The rules the current design rests on"; the three outcomes (refuse, shell-free, bash) and the audit rule; `Plan.broadReason` with its four kinds and `Plan.verbs`; `outcomeOf`; the `debug` event, its message, and its data fields, with the one-line filter that tallies a session; the sentence table and the rejection message; the refuse wall and what it does not stop; files and tests. Later slices add their sections, so give it headings they can extend.

- [ ] **Step 2: Add the index line to both indexes**

One line in the style of the `grep-flags.md` entry: the doc's name, then what it covers, in one sentence.

- [ ] **Step 3: Point the v3 spec at the new one**

Under its `## Status`, one line: superseded in part by the 2026-10-30 spec, with the relative link.

- [ ] **Step 4: Prose check and commit**

Read `~/.claude/skills/simplify-speech/verbal-tics.md` and check the new doc against it. Then:

```bash
git add docs/dev/stdlib/safe-bash.md CLAUDE.md .claude/skills/agency-stdlib-docs/SKILL.md docs/superpowers/specs/2026-07-26-safebash-classifier-design.md
git commit -F /tmp/msg.txt   # "docs: a dev doc for safeBash"
```

---

### Task 5: Pre-push checks and the PR

- [ ] **Step 1: Typecheck, structural lint, and formatting on the named files**

Run: `pnpm run typecheck > /tmp/tc.txt 2>&1; tail -3 /tmp/tc.txt; pnpm run lint:structure > /tmp/lint.txt 2>&1; tail -3 /tmp/lint.txt; npx prettier --check lib/stdlib/statelog.ts lib/stdlib/statelog.test.ts`
Expected: all clean. Never amend; a fix is a new commit.

- [ ] **Step 2: Anti-pattern pass**

Invoke `/anti-pattern-check` on the branch's diff and fix what it finds.

- [ ] **Step 3: Push and open the PR**

PR body in a file: the three code changes, the deferred read-tools hint and where it lands, and the Linear issue. Title: `safeBash: log every plan and say why a command stayed broad (ADI-238)`. Then stop; the owner merges.
