# safeBash asks `std::env` for a variable in a narrow line: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A narrow `safeBash` line asks `std::env { name }` once for each environment variable one of its words expands, and `recommended` approves that question for ten names that hold no secret.

**Architecture:** The classifier already returns an effect list for each simple command. One new function reads the variable names out of a command's words and adds a `std::env` effect per name to that list. Because the effect belongs to the command's step, the step runner needs no change: the plan made just before the step produces the same effect. `planLine` drops repeated names so the person is asked once per name.

**Tech Stack:** Agency (`stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`), TypeScript (`lib/runtime/builtinPolicies.ts`), Agency tests.

**Spec:** `docs/superpowers/specs/2026-11-21-safebash-env-question-design.md`. The owner said yes to all four decisions in it on 2026-11-21.

## Background a builder needs

Read `docs/dev/stdlib/safe-bash.md` first, and the section "MUST READ: How interrupts, handlers, policies, and effects work" in `CLAUDE.md`.

Today `verbEffects` returns no effect for `echo`, whatever its words are:

```
git status && echo $GITHUB_TOKEN     # asks only std::git::status
```

`recommended` approves the git read, bash prints the token, and nobody was asked. The `env` tool asks `std::env { name }` before the same read.

Three places already mention this gap in a comment and must be rewritten when the rule lands: `stdlib/safeBash.agency` near lines 571, 639, and 5157 (search for `std::env`).

## Global Constraints

- The effect is the existing one: `effect std::env { name: string }` in `stdlib/system.agency`. Do not add a field to it and do not declare a new effect.
- No question other than the ones in "Lines whose question changes" in the spec may change. `tests/agency/safeBash-corpus.json` must not change unless a line in it holds a variable in an `echo`; if one does, the change must be the addition of `std::env` and nothing else.
- The names bash computes itself ask nothing: `?`, `$`, `#`, `0` to `9`, `RANDOM`, `SECONDS`.
- The names `recommended` approves, exactly: `HOME`, `PWD`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `TMPDIR`, `PATH`, `HOSTNAME`.
- `minimal` is unchanged.
- Change files with the Edit and Write tools only. Run `agency test` with `--check-capabilities` after the path, and save the output to a file.
- One pull request. Do not hand-edit `docs/site/`; `make` regenerates it.

## Review Focus

1. **A variable inside quotes or joined to text.** `echo "t: $X"` and `echo pre$X` must each ask for `X`. A walk that only looks at a bare `$X` word misses both.
2. **The step runner must not stop a line that holds a variable.** `pnpm --version; echo $HOME` must run to the end. If the effect were added only to the whole plan and not to the step, or the other way round, the check before the step would see a different list and stop.
3. **One question per name.** `echo $A; echo $A` must raise `std::env` for `A` once.
4. **A rejected `std::env` runs nothing.** `git status && echo $TOKEN` with `std::env` rejected must not run `git status` either, because every question is asked before anything runs.
5. **A line that is only an `echo` of a computed name.** `echo $RANDOM` has no effect of its own and one word that is not known in advance, so it must still ask `std::bash`, as today.

---

### Task 1: the classifier adds `std::env` for each variable

**Files:**
- Modify: `stdlib/safeBash/actions.agency` (the `Effect` union near line 157; a builder beside `mkdirEffect`)
- Modify: `stdlib/safeBash.agency` (`classifySimple`, `planLine`, `raiseOne`, `SafeBashEffects`, the three comments)
- Modify: `stdlib/workflow.agency` only if the compiler reports that its explicit `raises <...>` list near line 1286 is missing `std::env`
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`, `tests/agency/safeBashSteps.agency`, `tests/agency/safeBashSteps.test.json`

**Interfaces:**
- Produces, in `actions.agency`:
  - a new member of `Effect`: `{ name: "std::env"; payload: { name: string } }`
  - `export def envEffect(name: string): Effect`
- Produces, in `safeBash.agency`:
  - `static const COMPUTED_VARIABLES: string[]` holding the names in Global Constraints
  - `def variableNames(command: SimpleCommand): string[]`: the distinct variable names in the command's words (`commandWords`) and in its assignment values, in the order they appear, without the computed names. It looks inside `doubleQuoted` and `interpolatedVariable` words. `variableIn` and `firstVariableIn`, which the step runner added, walk the same shapes and return one name; write this beside them and share the walk if that comes out shorter.
  - `def envEffects(command: SimpleCommand, own: Effect[]): Effect[]`: one `envEffect` per name from `variableNames`, or `[]` when `own` holds a `std::exec` effect.

- [ ] **Step 1: Write the failing planner test.** Add a node `variablesAskStdEnv` to `tests/agency/safeBash.agency` that returns, for each line below planned in `FILES_FIXTURE`, the line, `outcomeOf`, and each effect as its name and, for `std::env`, its `payload.name`:

```
git status && echo $GITHUB_TOKEN          narrow  std::git::status, std::env GITHUB_TOKEN
git status && echo "t: $GITHUB_TOKEN"     narrow  std::git::status, std::env GITHUB_TOKEN
git status && echo pre$GITHUB_TOKEN       narrow  std::git::status, std::env GITHUB_TOKEN
git status && echo $A $A $B               narrow  std::git::status, std::env A, std::env B
echo $A; echo $A                          narrow  std::env A
git status && echo $TOKEN > out.txt       narrow  std::git::status, std::env TOKEN, std::write
git status; (echo $TOKEN)                 narrow  std::git::status, std::env TOKEN
git status; echo $TOKEN | cat             narrow  std::git::status, std::env TOKEN
git status; timeout 5 echo $TOKEN         narrow  std::git::status, std::env TOKEN
git status && true $TOKEN                 narrow  std::git::status, std::env TOKEN
echo $HOME                                narrow  std::env HOME
git status; echo $?                       narrow  std::git::status
git status; echo $RANDOM $$ $1            narrow  std::git::status
echo $RANDOM                              broad   std::bash
git status && printf '%s' $TOKEN          broad   std::bash
git status; cat $F                        broad   std::bash
pnpm test $FLAGS                          broad   std::bash
```

The order of effects inside one command is the command's own effects, then `std::env`, except that a redirect's `std::write` stays last if that is where the code puts it today; record whatever order the code gives and keep it stable. Put a placeholder in `safeBash.test.json`, with a description that says the rule in plain words.

- [ ] **Step 2: Run it and see it fail.** `node ./dist/scripts/agency.js test tests/agency/safeBash.agency --check-capabilities > <file> 2>&1`. Expected: `variablesAskStdEnv` fails, and the first row shows no `std::env`.

- [ ] **Step 3: Add the effect and the builder** in `actions.agency`.

- [ ] **Step 4: Add `COMPUTED_VARIABLES`, `variableNames`, and `envEffects`** in `safeBash.agency`.

- [ ] **Step 5: Call `envEffects` in `classifySimple`.** In both branches (with and without `timeout`), the command's effects become `[...rule.effects, ...envEffects(inner, rule.effects)]`, where `inner` is the command the rule classified. The same list goes to `runStepOf`, to `afterCommand`, and into the returned `Classified`. This is what makes the check before a step produce the same list.

- [ ] **Step 6: Ask once per name in `planLine`.** After `const narrow: Effect[] = classified.value.effects`, drop every `std::env` effect whose name an earlier one in the list already has. Only the plan's list changes; each step keeps its own.

- [ ] **Step 7: Raise it.** Add an arm to `raiseOne`:

```
"std::env" => {
  raise std::env("A shell command reads this environment variable${where}: `${fullCommand}`", {
    name: effect.payload.name
  })
  return success(null)
}
```

Add `std::env` to `SafeBashEffects`. If the build then reports a `raises` list elsewhere that lacks it, add it there.

- [ ] **Step 8: Rewrite the three comments** that say an `echo` can print a variable with no question. The one in `planLine`'s no-effect branch now applies only to a computed name: `echo $RANDOM` has no effect and one word that is not known in advance.

- [ ] **Step 9: Build and fill in the expected value.** `make > <file> 2>&1`, then grep the log for `error`, because `make` exits 0 on a type error in a stdlib file. Run the test, check each row against the table in Step 1 by eye, and copy the actual output into `safeBash.test.json`. A row that differs from the table is a bug to fix, not a value to copy.

- [ ] **Step 10: Write the run tests** in `tests/agency/safeBashSteps.agency`, using the helpers already there:
  - `aLineWithAVariableRuns`: `ranWithoutStop("pnpm --version; echo $HOME")` returns `[line, true, false]`.
  - `aVariableIsAskedOnce`: run `echo $HOME; echo $HOME` in the fixture under a handler that records `intr.effect` and `intr.data.name` and approves. Expected: one entry, `["std::env", "HOME"]`.
  - `aRejectedVariableRunsNothing`: run `pnpm --version > ran.txt && echo $HOME` under a handler that rejects `std::env` and approves the rest. Expected: the result is a failure and `ran.txt` does not exist.

- [ ] **Step 11: Run `safeBash`, `safeBashSteps`, `safeBash-corpus`, and `jobs`**, each to its own file. Expected: all pass, and `safeBash-corpus.json` is unchanged or changed only as Global Constraints allows. Any other existing row that changed is a question that moved; list each in the pull request with its before and after.

- [ ] **Step 12: Commit.**

### Task 2: `recommended` approves the harmless names

**Files:**
- Modify: `lib/runtime/builtinPolicies.ts` (`recommendedAutoApprovePolicy`)
- Test: `lib/runtime/builtinPolicies.test.ts`

**Interfaces:**
- Produces: in `recommendedAutoApprovePolicy`, `"std::env": [{ match: { name: "{HOME,PWD,USER,LOGNAME,SHELL,TERM,LANG,TMPDIR,PATH,HOSTNAME}" }, action: "approve" }]`, with a comment that says these names hold no secret and that the rule covers both the `env` tool and a shell line. `webReadRules` in the same file shows the brace form.

- [ ] **Step 1: Write the failing test.** In `builtinPolicies.test.ts`, following the tests already there for `recommended`: `std::env` with `name` `HOME` and with `name` `PATH` is approved; `GITHUB_TOKEN`, `HOMEX`, `MY_HOME`, and `home` are not decided by the policy; under `minimalAutoApprovePolicy`, `HOME` is not decided.
- [ ] **Step 2: Run it and see it fail.** `pnpm exec vitest run lib/runtime/builtinPolicies.test.ts > <file> 2>&1` from this worktree.
- [ ] **Step 3: Add the rule.**
- [ ] **Step 4: Run the test and see it pass.** Then `pnpm run typecheck`.
- [ ] **Step 5: Commit.**

### Task 3: documentation

**Files:**
- Modify: `docs/dev/stdlib/safe-bash.md`
- Modify: `docs/dev/agents/approval-policies.md`

- [ ] **Step 1: `safe-bash.md`.** Add a short section, "A variable in a word asks `std::env`": the rule, the computed names, why a command that asks `std::exec` adds nothing, and that the effect sits on the command's step so the check before the step matches. Correct the two passages near lines 1313 and 1828 that describe the gap as open. Name the test nodes from Task 1. Describe the mechanism and the rule only, with no history.
- [ ] **Step 2: `approval-policies.md`.** One paragraph: `recommended` approves `std::env` for the ten names, the same rule answers the `env` tool, and a saved `~/.agency-agent/policy.json` does not pick the rule up until `/policy` runs.
- [ ] **Step 3: `pnpm run lint:structure`**, then commit together with the `docs/site` pages `make` regenerated.

### Task 4: the pull request

- [ ] **Step 1: Read the diff against `docs/dev/contributing/anti-patterns.md`.**
- [ ] **Step 2: Open one pull request into main.** The description has the table "Lines whose question changes" from the spec, any other row that moved (Task 1, Step 11), and a paragraph on interrupts: the question is raised in `approvedPlan` with the others before anything runs, the runner raises nothing, and a rejection runs nothing. The owner merges.

## Not in this plan

- Running an `echo` that holds a variable in process, through the `env` tool. It belongs with ADI-360.
- Any change to what a program may read. `printenv X` asks `std::exec`.
