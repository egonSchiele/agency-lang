# safeBash: record what every call decided (ADI-238) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `safeBash` call logs which decision `planFor` made and why, and a rejected broad command tells the model why it could not be narrowed.

**Architecture:** `planFor` already computes a failure message for every unrecognized command and discards it. The `Plan` record gains a `reason` string carrying the first one. `safeBash` logs the plan through the run's existing `debug` statelog event before raising anything, and appends the reason to the failure it returns when the broad question is rejected. No new event type, no viewer change.

**Tech Stack:** Agency (`stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`), TypeScript bridge in `lib/stdlib/safeBash.ts`, vitest, Agency execution tests.

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-reads/packages/agency-lang/docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`, Part 3 and the end of Part 6. Linear: ADI-238.

## Global Constraints

- Nothing raises or runs before `planFor` returns. The log call sits between `planFor` and `raiseAll`.
- The event is the generic `debug` event, message `safeBash plan`. No method is added to `lib/statelogClient.ts`.
- Outside an Agency run the log call is a no-op, as `_turnStart` in `lib/stdlib/statelog.ts` is.
- `make` after every change to a `.agency` file; `pnpm run build` after a change to a `.ts` file the Agency tests import; `pnpm run typecheck`, `pnpm run lint:structure`, and prettier on the named `.ts` files before pushing.
- Dev docs record mechanism and rule, never history.
- The spec's "names the read tools when every verb was a read-family verb" clause waits for ADI-242 and ADI-244, which introduce the read-family table. This slice appends the reason only.

## Review Focus

- A command that is unparseable: `reason` must carry the parser's message, and the event must say `unparseable`, with an empty `verbs` list. Pinned in Task 1.
- A string of echoes that falls to `std::bash` by the audit rule: `reason` is `noEffects`, and the rejection message must not claim an unrecognized command. Pinned in Task 1.
- A refused command: logged with outcome `refuse` and nothing raised. Pinned in Task 2.
- Observability off: the log call must not throw and must not post. Pinned in Task 2.
- A rejection of a narrow question (for example `std::git::status`) has no reason to append; the failure must read as it does today. Pinned in Task 3.

---

### Task 1: `Plan.reason`

**Files:**
- Modify: `stdlib/safeBash/actions.agency` (the `Plan` type)
- Modify: `stdlib/safeBash.agency` (`bashPlan`, `refusePlan`, `planFor`, and the shell-free and agency plan builders)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Produces: `Plan.reason: string`. Empty when the plan is not broad. When broad, one of these shapes, used verbatim by Tasks 2 and 3:
  - `unparseable: <parser message>`
  - `unrecognized: <the first failure message effectsFor returned>` (for example ``unrecognized: no rule for `xargs` ``)
  - `noEffects` (everything recognized, nothing raised, so the audit rule asked `std::bash`)
  - `unrenderable: <why>` (the tree could not be rendered back to text)

- [ ] **Step 1: Write the failing plan tests**

Add to `tests/agency/safeBash.agency`:

```
def planReason(source: string): string {
  return planFor(source, "/repo").reason
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
```

Add to `tests/agency/safeBash.test.json` a case `planReasons` with `expectedOutput`:

```
["","unrecognized: no rule for `xargs`","noEffects","unparseable: Unexpected input after commands: \"$(date)\"","","unrecognized: no rule for `xargs`"]
```

Check the exact parser message for `echo $(date)` by running `pnpm run agency` on a one-line file that prints `bashParser("echo $(date)")`, and paste what it prints.

- [ ] **Step 2: Run the test to see it fail**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/safebash-t1.txt 2>&1; grep -n "planReasons" -A3 /tmp/safebash-t1.txt`
Expected: FAIL, `reason` is not a field of `Plan`.

- [ ] **Step 3: Add `reason: string` to `Plan` in `stdlib/safeBash/actions.agency`**

Document it in one sentence on the type: why the plan was broad, empty otherwise.

- [ ] **Step 4: Thread the reason through `planFor` in `stdlib/safeBash.agency`**

`bashPlan(command: string, effects: Effect[], reason: string): Plan` gains the third parameter. `refusePlan`, `echoPlan`, `writePlan`, and `agencyCommandPlan` set `reason: ""`. In `planFor`:

- the unparseable branch passes `"unparseable: ${why}"`;
- the classification loop keeps the first `why` from `effectsFor` in a local (`let firstMiss = ""`) and the `!allRecognized` branch passes `"unrecognized: ${firstMiss}"`;
- the `narrow.length == 0` branch passes `"noEffects"`;
- the `rebuilt is failure(why)` branch passes `"unrenderable: ${why}"`;
- the final narrow plan passes `""`.

- [ ] **Step 5: `make`, then run the test to see it pass**

Run: `make > /tmp/make-t1.txt 2>&1; tail -3 /tmp/make-t1.txt; AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/safebash-t1.txt 2>&1; tail -5 /tmp/safebash-t1.txt`
Expected: every case passes, including the existing ones.

- [ ] **Step 6: Commit**

```bash
git add stdlib/safeBash/actions.agency stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -F /tmp/msg.txt   # "safeBash: keep the reason a plan went broad"
```

---

### Task 2: The `debug` event

**Files:**
- Modify: `lib/stdlib/safeBash.ts`
- Modify: `stdlib/safeBash.agency` (`safeBash`, between `planFor` and `raiseAll`)
- Test: `lib/stdlib/safeBash.test.ts`

**Interfaces:**
- Consumes: `Plan.reason` from Task 1; `currentRunOrNone()` from `lib/runtime/asyncContext.ts`; `run.log.debug(message: string, data: any)`.
- Produces: `export async function _logSafeBashPlan(plan: SafeBashPlanView, command: string, cwd: string): Promise<void>` in `lib/stdlib/safeBash.ts`, where `SafeBashPlanView` is a type declared in the same file with the fields the function reads: `{ effects: { name: string }[]; execution: { kind: string }; reason: string; verbs: string[] }`. It posts one `debug` event with message `safeBash plan` and data `{ command, cwd, outcome, reason, verbs, effects }`, where `outcome` is derived from the plan: `refuse` for execution kind `refuse`, `shellFree` for `echo` and `write`, `agency` for `agency`, and for `bash` either `broad` when `reason` is non-empty or `narrow` when it is empty; `effects` is the list of effect names.

- [ ] **Step 1: Write the failing unit test**

In `lib/stdlib/safeBash.test.ts`, following `withFrame` and `spyClient` in `lib/stdlib/statelog.test.ts` (copy the two helpers, with a `debug` spy in place of `turnStart`):

```ts
describe("_logSafeBashPlan", () => {
  it("posts one debug event describing the plan", async () => {
    await withFrame(async (spies) => {
      await _logSafeBashPlan(
        { effects: [{ name: "std::bash" }], execution: { kind: "bash" }, reason: "unrecognized: no rule for `xargs`", verbs: ["xargs"] },
        "xargs rm x", "/repo",
      );
      expect(spies.debug).toHaveBeenCalledOnce();
      expect(spies.debug).toHaveBeenCalledWith("safeBash plan", {
        command: "xargs rm x", cwd: "/repo", outcome: "broad",
        reason: "unrecognized: no rule for `xargs`", verbs: ["xargs"], effects: ["std::bash"],
      });
    });
  });

  it("calls a narrow bash plan narrow and a refusal refuse", async () => { /* two more calls, assert outcome */ });

  it("is a no-op outside a run", async () => {
    await expect(_logSafeBashPlan({ effects: [], execution: { kind: "refuse" }, reason: "", verbs: ["rm"] }, "rm x", "/repo")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run lib/stdlib/safeBash.test.ts > /tmp/safebash-t2.txt 2>&1; tail -8 /tmp/safebash-t2.txt`
Expected: FAIL, `_logSafeBashPlan` is not exported.

- [ ] **Step 3: Implement `_logSafeBashPlan` in `lib/stdlib/safeBash.ts`**

`const run = currentRunOrNone(); if (!run) return;` then `await run.log.debug("safeBash plan", data)`. The outcome mapping is a lookup object keyed by execution kind, with the `bash` entry deciding on `reason`.

- [ ] **Step 4: Run the unit test to see it pass, then `pnpm run build`**

Run: `pnpm vitest run lib/stdlib/safeBash.test.ts > /tmp/safebash-t2.txt 2>&1; tail -4 /tmp/safebash-t2.txt; pnpm run build > /tmp/build-t2.txt 2>&1; tail -2 /tmp/build-t2.txt`
Expected: PASS; build clean.

- [ ] **Step 5: Call it from `safeBash` in `stdlib/safeBash.agency`**

Import `_logSafeBashPlan` from `agency-lang/stdlib-lib/safeBash.js` beside `_bashParser`. In `safeBash`, after `const plan = planFor(command, dir)` and before the refusal check, call `_logSafeBashPlan({ effects: plan.effects, execution: plan.execution, reason: plan.reason, verbs: verbsOf(command) }, command, dir)`. Add `def verbsOf(source: string): string[]` next to `flattenCommands`: parse, flatten, and collect each simple command's literal command word; an unparseable string gives `[]`, an assignment-only command gives `""`. The call goes before the refusal check so a refused plan is logged too.

- [ ] **Step 6: `make`; run the safeBash Agency tests to confirm nothing changed**

Run: `make > /tmp/make-t2.txt 2>&1; tail -3 /tmp/make-t2.txt; AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/safebash-t2b.txt 2>&1; tail -5 /tmp/safebash-t2b.txt`
Expected: all pass. The event has no assertion at this layer; the unit test owns it.

- [ ] **Step 7: Commit**

```bash
git add lib/stdlib/safeBash.ts lib/stdlib/safeBash.test.ts stdlib/safeBash.agency
git commit -F /tmp/msg.txt   # "safeBash: log every plan as a debug event"
```

---

### Task 3: The rejection message carries the reason

**Files:**
- Modify: `stdlib/safeBash.agency` (`safeBash`, the `raised is failure(why)` branch)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `Plan.reason` from Task 1.
- Produces: when `raiseAll` fails and `plan.reason` is non-empty, the returned failure is `"${why} safeBash could not ask a narrower question because: ${plan.reason}."`; when `plan.reason` is empty the failure is `why` unchanged.

- [ ] **Step 1: Write the failing end-to-end tests**

```
node rejectedBroadSaysWhy() {
  const result = safeBash("xargs echo hi")
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

In `tests/agency/safeBash.test.json`, both cases get `interruptHandlers: [{ "action": "reject", "expectedMessage": ... }]` with the `std::bash` message for the first and `Show git status` for the second. Run once with a placeholder `expectedOutput` to capture today's exact rejection text, then set `expectedOutput` to that text with `" safeBash could not ask a narrower question because: unrecognized: no rule for `xargs`."` appended for the first case and unchanged for the second. Use `"type": "contains"` only if the rejection text carries a run-specific id; otherwise `exact`.

- [ ] **Step 2: Run to see the first fail and the second pass**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/safebash-t3.txt 2>&1; grep -n "rejected" -A3 /tmp/safebash-t3.txt`

- [ ] **Step 3: Append the reason in `safeBash`**

In the `raised is failure(why)` branch: `if (plan.reason == "") { return failure(why) }` else return the composed string above.

- [ ] **Step 4: `make`; run the tests to see both pass**

Run: `make > /tmp/make-t3.txt 2>&1; tail -3 /tmp/make-t3.txt; AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/safebash-t3.txt 2>&1; tail -5 /tmp/safebash-t3.txt`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -F /tmp/msg.txt   # "safeBash: a rejected broad command says why it stayed broad"
```

---

### Task 4: The dev doc and the indexes

**Files:**
- Create: `docs/dev/stdlib/safe-bash.md`
- Modify: `CLAUDE.md` (Standard library section, after the `grep-flags.md` line), `.claude/skills/agency-stdlib-docs/SKILL.md` (same line; the directory is gitignored but the file is tracked, so `git add -f`)
- Modify: `docs/superpowers/specs/2026-07-26-safebash-classifier-design.md` (status line)

- [ ] **Step 1: Write `docs/dev/stdlib/safe-bash.md`**

Sections, mechanism and rule only: what `planFor` returns and why nothing runs inside it; the five rules from the spec's "The rules the current design rests on"; the three outcomes (refuse, shell-free, bash) and the audit rule; `Plan.reason` and its four shapes; the `debug` event, its message, and its data fields, with the one-line `jq` or `grep` that tallies a session; the rejection message; the refuse wall and what it does not stop; files and tests (`stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`, `lib/stdlib/safeBash.ts`, `tests/agency/safeBash.agency`, `lib/stdlib/safeBash.test.ts`). Under 150 lines. Later slices add their sections.

- [ ] **Step 2: Add the index line to both indexes**

One line in the style of the `grep-flags.md` entry: the doc's name, then what it covers, in one sentence.

- [ ] **Step 3: Point the v3 spec at the new one**

Under its `## Status`, one line: superseded in part by the 2026-10-30 spec, with the relative link.

- [ ] **Step 4: Prose check and commit**

Read `~/.claude/skills/simplify-speech/verbal-tics.md` and check the new doc against it. Then:

```bash
git add docs/dev/stdlib/safe-bash.md CLAUDE.md docs/superpowers/specs/2026-07-26-safebash-classifier-design.md
git add -f .claude/skills/agency-stdlib-docs/SKILL.md
git commit -F /tmp/msg.txt   # "docs: a dev doc for safeBash"
```

---

### Task 5: Pre-push checks and the PR

- [ ] **Step 1: Typecheck, structural lint, and formatting on the named files**

Run: `pnpm run typecheck > /tmp/tc.txt 2>&1; tail -3 /tmp/tc.txt; pnpm run lint:structure > /tmp/lint.txt 2>&1; tail -3 /tmp/lint.txt; npx prettier --check lib/stdlib/safeBash.ts lib/stdlib/safeBash.test.ts`
Expected: all clean. Fix and amend nothing; make a new commit if something needs a change.

- [ ] **Step 2: Anti-pattern pass**

Invoke `/anti-pattern-check` on the branch's diff and fix what it finds.

- [ ] **Step 3: Push and open the PR**

PR body in a file: what the three code changes are, the deferred read-tools hint and where it lands, and the Linear issue. Title: `safeBash: log every plan and say why a command stayed broad (ADI-238)`. Then stop; the owner merges.
