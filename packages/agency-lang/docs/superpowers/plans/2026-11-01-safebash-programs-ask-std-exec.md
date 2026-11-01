# Programs with no rule of their own ask `std::exec` (ADI-243)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline, in this session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm test`, `make`, `pytest tests`, `tsc --noEmit`, and every other program safeBash has no rule for raise `std::exec`, the question the `exec` tool asks, in place of the broad `std::bash`. So "approve always here" on `pnpm test` saves `{ command: "pnpm", subcommand: "test" }`, and every later `pnpm test` runs with no prompt, alone or in a line such as `make 2>&1 | tail -100`.

**Architecture:** One new step at the end of `otherVerbEffects`, where today a verb with no rule fails with "no rule for". A verb that reaches that point is not owned by any rule, so it raises `std::exec` with the payload the `exec` tool would raise. A short list of exceptions stays broad: wrapper verbs that run another program (`sh`, `xargs`, `env`, `sudo`, ...), `agency`, a command that reads a pipe, and a command with an input redirect. Nothing else in the classifier moves. The line still runs through bash, as every narrow plan does.

**Tech Stack:** Agency (`stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`), the Agency test runner, `make`.

**Spec:** `docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`, Part 6 ("Project scripts raise `std::exec`") and Part 7 ("What this round makes weaker"). Ticket ADI-243.

## Background for the implementer

Read these first:

- `docs/dev/stdlib/safe-bash.md`, whole. The sections that matter most here are "The rules", "Outcomes", "Why a plan went broad", "What the model reads on a rejection", "Stages that read a pipe", and "Why a bash call is never destructive".
- `docs/dev/agents/approval-policies.md`, "What 'approve always here' pins".
- The guide pages on interrupts, handlers, and policies, as `CLAUDE.md` says.

Then the code:

- In `stdlib/safeBash.agency`: `effectsFor`, `otherVerbEffects`, `redirectEffect`, `stdinStage`, `literalWordText`, `renderFlag`, `raiseOne`, `safeBash`'s `raises` clause, and `tryAgencyPlan`.
- In `stdlib/safeBash/actions.agency`: `Effect`, `ReadPayload`, `readEffect`, and `LsPayload`, which this plan copies the shape of.
- In `stdlib/shell.agency`: the `exec` tool and the `std::exec` effect declaration.

### What the `exec` tool asks

`stdlib/shell.agency` declares:

```agency
@always(command, subcommand)
effect std::exec {
  command: string;
  args: string[];
  subcommand: string;
  cwd: string;
  timeout: number;
  stdin: string
}
```

The `exec` tool raises it as `std::exec("Are you sure you want to run this command?", { command, args, subcommand, cwd, timeout, stdin })`. Here `subcommand` is `args[0]`, or `""` when there are no arguments. Because of `@always(command, subcommand)`, "approve always here" saves a rule keyed on those two fields only. A saved rule for `pnpm test` covers `pnpm test` in any folder, with any later arguments. That's how the tool behaves today, and this plan doesn't change it.

`recommended` (`lib/runtime/builtinPolicies.ts`) has `std::exec` rules for `agency` with the subcommands in `AGENCY_SAFE_SUBCOMMANDS`, and nothing else. So under `recommended`, `pnpm test` still asks. The saving comes from the answer a person gives once.

### Where a verb with no rule goes today

`effectsFor` matches `echo`, `grep`, `git`, `tr`, and `find` by name. Every other verb goes to `otherVerbEffects`, which looks it up in `LIST_VERBS`, then `READ_VERBS`, and otherwise fails with "no rule for `<verb>`". That failure makes the line broad.

That structure already gives the spec's ownership rule. A verb with a rule is owned by it: `git push`, `find . -delete`, and `tail -f x` fail inside their own arm or row and never reach the end of `otherVerbEffects`. So the new step goes exactly where "no rule for" is today, and an owned verb can never fall through to `std::exec`. Don't add a list of owned verbs. The arms and tables are that list.

Two earlier checks also stay in front of the new step, both in `effectsFor`:
- A command word that isn't literal is unrecognized, so `./gradlew test` and `/usr/bin/make` stay broad.
- A leading assignment is unrecognized, so `NODE_OPTIONS=--require=x pnpm test` stays broad. A rule for `pnpm test` must not cover that line.

The refuse wall runs before all of this, in `planFor`.

## Global Constraints

- Never force-push or amend. Commit messages and PR bodies go in a file and are passed with `-F`.
- Run `make` after any `.agency` edit, and commit the regenerated `docs/site/stdlib/safeBash.md` and `docs/site/stdlib/safeBash/actions.md`. Never hand-edit `docs/site`.
- Save test output to a file and read it. Run `pnpm run agency test tests/agency/safeBash.agency` and the vitest files named here, not the whole suite.
- Dev docs state the mechanism and the rule, with no history or dates.
- Agency syntax: no lambdas. An `isFailure` guard doesn't narrow a `Result` over a union, so match on it through a helper def. A `!=` on a tag doesn't narrow, so use `is`. A record copy is built field by field. A literal union used as a field type needs a name (`type X = "a" | "b"`), or the checker widens it to `string` when the value comes out of a `Record`.
- `.claude/skills/agency-stdlib-docs/SKILL.md` and `.claude/skills/agency-agent-docs/SKILL.md` are tracked but gitignored. `git add -f` each one in a command of its own.
- Use objects, arrays, and types. Never maps, sets, or interfaces.

## Review Focus

1. **`git push --force`.** Expected: `std::bash`, never `std::exec { command: "git", subcommand: "push" }`. The git arm owns `git`. A saved rule for an innocent git subcommand must not start covering a push. Test in Task 2.
2. **`find . -delete` and `tail -f log.txt`.** Expected: `std::bash`, for the same reason. The listing and read rows own those verbs.
3. **`env FOO=1 pnpm test`, `sh -c "pnpm test"`, `xargs pnpm test`, `sudo make install`.** Expected: `std::bash`. A wrapper's payload would name the wrapper, while what runs is in its arguments.
4. **`git log | python3 count.py`.** Expected: `std::bash`. `python3` reads the pipe, and the `std::exec` payload's `stdin` field is `""`, so it would misdescribe the command. The same goes for `pnpm test < input.txt`.
5. **`echo a; agency --version` and `true && agency test x.test.json`.** Expected: `std::bash`. `recommended` approves `std::exec` for `agency` with its safe subcommands, which were chosen for the `exec` tool. A lone `agency` line already runs in process through `tryAgencyPlan`. A bash spelling of it must not become an auto-approved `std::exec`.
6. **`pnpm test > out.log`.** Expected: `std::exec` and `std::write`. The redirect is classified as it is today.

---

### Task 1: The `std::exec` effect and its payload

**Files:**
- Modify: `stdlib/safeBash/actions.agency` (`Effect`, new `ExecPayload`, `execEffect`)
- Modify: `stdlib/safeBash.agency` (imports, `raiseOne`, `safeBash`'s `raises` clause)

**Interfaces:**

In `actions.agency`, beside `LsPayload`:

```agency
/** The fields the exec tool's own std::exec interrupt carries. From
 * safeBash, `cwd` is safeBash's resolved working directory, `timeout` is
 * 0 and `stdin` is empty, which is how safeBash runs the line, and an
 * argument may be an unexpanded glob that bash expands. */
export type ExecPayload = {
  command: string;
  args: string[];
  subcommand: string;
  cwd: string;
  timeout: number;
  stdin: string
}

export def execEffect(payload: ExecPayload): Effect
```

`Effect` gains `{ name: "std::exec"; payload: ExecPayload }`.

In `safeBash.agency`, `raiseOne` gains a `"std::exec"` arm:

```agency
    "std::exec" => {
      raise std::exec("Are you sure you want to run this command?", {
        command: effect.payload.command,
        args: effect.payload.args,
        subcommand: effect.payload.subcommand,
        cwd: effect.payload.cwd,
        timeout: effect.payload.timeout,
        stdin: effect.payload.stdin,
        line: fullCommand
      })
      return success(null)
    }
```

The full command line goes in `line`, not `command`. The other arms put it in `command`, but `std::exec` already uses `command` for the program, and `@always` pins that field. `safeBash`'s `raises` clause gains `std::exec`.

**The effect contract.** The comment above the imports at the top of `safeBash.agency` says an effect's declaration comes with an import from its module, and without one, a raise site's payload isn't checked. `ls` and `glob` are imported from `std::shell` for that reason. Check whether `std::exec` needs an import of its own:

1. Temporarily misspell a field in the new raise (`subcomand: ...`).
2. Run `pnpm run agency typecheck stdlib/safeBash.agency`. If it reports the field, the declaration is already in scope, and you can remove the misspelling.
3. If it doesn't, import the tool under another name, `import { exec as execTool } from "std::shell"`. `safeBash` has a local named `exec`, so an unaliased import would clash with it. Then run the misspelling check again. Record which way it went in the ledger.

- [ ] **Step 1:** Add the type, `execEffect`, the `Effect` variant, the `raiseOne` arm, and the `raises` entry. Run the contract check above.
- [ ] **Step 2:** `make`, then `pnpm run agency typecheck stdlib/safeBash.agency stdlib/safeBash/actions.agency`. Expected: no type errors. Nothing raises `std::exec` yet, so the safeBash test is unchanged. Run it once to confirm that it is still green.
- [ ] **Step 3:** Commit. Message: `safeBash: the std::exec effect and its raise site`.

---

### Task 2: A verb with no rule asks `std::exec`

**Files:**
- Modify: `stdlib/safeBash.agency` (`otherVerbEffects`, new `WRAPPER_VERBS`, `NOT_EXEC_VERBS`, `execEffects`, `execArgs`)
- Modify: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**

```agency
/** Programs that exist to run another program. A std::exec payload for
 * one would name the wrapper, while what runs is in its arguments, so a
 * rule `{ command: "sh" }` would approve anything. These ask std::bash. */
static const WRAPPER_VERBS: string[] = [
  "sh", "bash", "zsh", "dash", "fish", "eval", "exec", "source", ".",
  "xargs", "env", "sudo", "doas", "nohup", "time", "timeout", "watch",
  "command", "builtin", "nice", "script"
]

/** Verbs with a path of their own that a bash spelling must not bypass.
 * A lone `agency` line runs in process through std::agency, and
 * recommended approves std::exec for agency's safe subcommands, which
 * were chosen for the exec tool. */
static const NOT_EXEC_VERBS: string[] = ["agency"]
```

```agency
def execEffects(verb: string, command: SimpleCommand, cwd: string, readsStdin: boolean, redirects: Effect[]): Result<Effect[]>
```

`otherVerbEffects`'s last line, today `return failure("no rule for `${verb}`")`, becomes `return execEffects(verb, command, cwd, readsStdin, redirects)`. `execEffects` checks these in order:

1. If the verb is in `WRAPPER_VERBS` or `NOT_EXEC_VERBS`, fail with `"no rule for `${verb}`"`. That's the same text as today, on purpose. Four expected outputs pin it: `planReasons`, `rejectedBroadSaysWhy`, the `git log | xargs echo` row, and the agency-js fixture `tests/agency-js/safe-bash-user-rejection/fixture.json`. The sentence is still true, because safeBash has no rule for a wrapper.
2. If `readsStdin` is true, fail with `"`${verb}` reads a pipe, and std::exec cannot say what it reads"`.
3. If any redirect on the command has op `"<"`, fail with `"`${verb}` reads an input redirect, and std::exec cannot say what it reads"`. Read the command's own `redirects` field for this, not the effects.
4. `execArgs(verb, command.args)` turns the words into text, or fails.
5. Return `success([execEffect(payload), ...redirects])`, with this payload:
   - `command: verb`
   - `args`
   - `subcommand`: `args[0]`, or `""` when there are no arguments. Write it as a small def, so there's no if-else inside the record.
   - `cwd`
   - `timeout: 0`
   - `stdin: ""`

```agency
def execArgs(verb: string, words: Word[]): Result<string[]>
```

`execArgs` turns each word into text:
- A `flag` word becomes `renderFlag(word)`, so `--noEmit` and `--filter=web` come through as written.
- A `glob` word becomes its text, unexpanded. The spec allows a glob in the arguments, and the payload carries what the person reads.
- A word `literalWordText` accepts becomes its text.
- Any other word fails with `"the ${verb} arguments are not literal"`. That covers a variable, an interpolated variable, and a double-quoted word with a variable inside.

`execEffects` needs no `@capabilities` tag, because it touches no files. `otherVerbEffects` keeps its `fileRead` tag for the read rows.

- [ ] **Step 1: Write the failing tests**

```agency
node programsAskStdExec() {
  return [
    grepNames("pnpm test"),
    grepNames("pnpm run build"),
    grepNames("tsc --noEmit"),
    grepNames("pytest tests/*.py"),
    grepNames("pnpm test > out.log"),
    grepNames("make 2>&1 | tail -100"),
    grepNames("git status && pnpm test"),
    grepNames("git push --force"),
    grepNames("find . -delete"),
    grepNames("tail -f one.txt"),
    grepNames("sh -c x"),
    grepNames("env FOO=1 pnpm test"),
    grepNames("sudo make install"),
    grepNames("FOO=1 pnpm test"),
    grepNames("pnpm test $X"),
    grepNames("./gradlew test"),
    grepNames("git log | python3 count.py"),
    grepNames("pnpm test < one.txt"),
    grepNames("echo a; agency --version"),
  ]
}
```

Expected, row by row, where `X` is `[["std::exec"],null]` and `U(d)` is `[["std::bash"],{"kind":"unrecognized","detail":d}]`:

1. `X`
2. `X`
3. `X`
4. `X`
5. `[["std::exec","std::write"],null]`
6. `X`
7. `[["std::git::status","std::exec"],null]`
8. `U` with the git arm's message. Pin it from the first run; it's whatever the git arm says today.
9. `U("find does not take `-delete`")`
10. `U("tail does not take `-f`")`
11. `U("no rule for `sh`")`
12. `U("no rule for `env`")`
13. `U("no rule for `sudo`")`
14. `U("a leading assignment changes what the command does")`
15. `U("the pnpm arguments are not literal")`
16. `U("the command word is not a literal")`
17. `U("`python3` reads a pipe, and std::exec cannot say what it reads")`
18. `U("`pnpm` reads an input redirect, and std::exec cannot say what it reads")`
19. `U("no rule for `agency`")`

A payload node, with the for-and-if shape `lsPayloads` uses so that `payload` narrows:

```agency
def execPayloads(source: string): any {
  let out: any[] = []
  for (effect in planFor(source, FIXTURES).effects) {
    if (effect.name == "std::exec") {
      out.push([effect.payload.command, effect.payload.args, effect.payload.subcommand, effect.payload.cwd == FIXTURES, effect.payload.timeout, effect.payload.stdin])
    }
  }
  return out
}

node execPayloadFields() {
  return [
    execPayloads("pnpm run build --filter=web"),
    execPayloads("make"),
    execPayloads("pytest tests/*.py -k fast"),
  ]
}
```

Expected:

```
[[["pnpm",["run","build","--filter=web"],"run",true,0,""]],
 [["make",[],"",true,0,""]],
 [["pytest",["tests/*.py","-k","fast"],"tests/*.py",true,0,""]]]
```

End to end, with `node --version`. Node is on every machine that runs this suite, it writes nothing, and it prints a version that starts with `v`.

- `programAsksOneQuestion`: `safeBash("node --version", cwd: FIXTURES)`, with one approve handler for "Are you sure you want to run this command?" in the `.test.json`. Return `result.value.startsWith("v")`. Expected: `true`. A `std::bash` prompt would fail the run on an unmatched interrupt.
- `programUnderRecommendedIsUndecided`: `planFor("pnpm test", FIXTURES)`, then pass the first `std::exec` effect through `checkPolicy(recommendedAutoApprovePolicy, intr)`, as `readOutsideTheLaunchDirIsUndecided` does. Expected: `"propagate"`.
- `programUnderASavedRuleRuns`: `safeBash("node --version", cwd: FIXTURES)` inside a handler that approves only what a policy with one rule approves: `{ "std::exec": [{ "match": { "command": "node", "subcommand": "--version" }, "action": "approve" }] }`. Write the policy the way `tests/agency/structured-interrupts/policy-reject-message.agency` writes its own, and leave the `.test.json` with no handler entry. Return whether the output starts with `v`. Expected: `true`.

**Rows that change meaning.** These rows used a verb with no rule to make a line broad, so after this task they raise `std::exec`:

- `nonZeroExitIsAFailure` runs `safeBash("false")`. It now asks `std::exec`. Keep the string and change its handler's `expectedMessage` to "Are you sure you want to run this command?". The point of the test, that a non-zero exit is a failure, holds either way.
- `sequenceRunsThroughBash` uses `echo hi && echo bye && true`. The `true` is there to keep the line broad. Make it `env true`, which runs `true` through a wrapper and stays broad. Update the node's comment.
- `echoIsTheSameAloneAndInAChain` uses `echo 'a\tb'; echo x; true`. Same swap, to `env true`, and the same comment update.
- `chainsOfInProcessCommands` has the row `echo a; true`, expecting `["broad","bash",["std::bash"]]`. The row shows that a command the step planners refuse ends the chain. Keep the string, and change the expectation to `["narrow","bash",["std::exec"]]`.
- `newShapes` has the row `make 2>&1 | tail -100`. Its expectation becomes `["bash",["std::exec"]]`. This row is the ticket's own acceptance line.
- `grepUnrecognized` has the row `rg hello .`. It becomes `[["std::exec"],null]`. Add a sentence to that node's description: rg is not grep and has no row, so it asks std::exec like any other program.

Before running anything, grep the test file once more for strings whose first word is a program with no rule (`true`, `false`, `make`, `node`, `python3`, `rg`, `tee`, `date`, and so on). Record every row you find in the ledger, as kept or swapped, with the old and new string. `git log | tee log.txt` stays broad, because `tee` reads the pipe. Check that the row still expects that.

- [ ] **Step 2: Run to verify they fail**

Run the agency test into `$SCRATCH/t2.txt`. Expected:
- every `std::exec` row says `std::bash` with "no rule for";
- the payload node returns empty lists;
- `programAsksOneQuestion` fails on an unmatched `std::bash` interrupt.

The changed rows (`false`, the `true` rows, `make`, `rg`) fail for the same reason. The swaps to `env true` still pass, because `env` stays broad.

- [ ] **Step 3: Implement**

The interfaces above. Put `WRAPPER_VERBS`, `NOT_EXEC_VERBS`, `execEffects`, and `execArgs` right after `otherVerbEffects`.

- [ ] **Step 4: `make`, run, verify pass**

Run `make`, then the agency test. Expected: all pass. Then run `pnpm vitest run lib/stdlibCapabilities.test.ts`. Expected: pass.

- [ ] **Step 5: Commit**

Message: `safeBash: a program with no rule asks std::exec`.

---

### Task 3: Docs, index lines, checks, PR

**Files:**
- Modify: `docs/dev/stdlib/safe-bash.md`, `docs/dev/agents/approval-policies.md`, the spec's Part 6, `CLAUDE.md`, `.claude/skills/agency-stdlib-docs/SKILL.md`, `.claude/skills/agency-agent-docs/SKILL.md`

- [ ] **Step 1: `docs/dev/stdlib/safe-bash.md`**
  - "Outcomes", the narrow list: add "a program safeBash has no rule for (`std::exec`)".
  - "In process when it translates", the table: add the row `pnpm test` | real pnpm, through bash | `std::exec`, as the exec tool does.
  - New section "Programs with no rule", after "Listings". It covers:
    - the rule: a verb no arm or table owns raises `std::exec`, built in `execEffects`;
    - the payload: the exec tool's fields, `line` for the full command, `cwd` resolved, `timeout` 0, `stdin` empty, and an argument that may be an unexpanded glob;
    - why ownership needs no list: the arms and tables fail inside themselves, so `git push`, `find . -delete`, and `tail -f` never reach the new step;
    - the exceptions and the reason for each: the wrapper verbs; `agency`; a command that reads a pipe or an input redirect; and, from earlier checks, a leading assignment and a command word that isn't literal;
    - why the wrapper message is still "no rule for";
    - what a saved rule covers: `@always(command, subcommand)` covers the program with that first argument in any folder, with any later arguments, the same as for the exec tool;
    - interpreters: `node -e '...'` is as broad as `sh -c`, so a rule for an interpreter should be keyed on `subcommand`;
    - that `rg --pre=<program>` runs another program per file, so a saved rule for `rg` covers that too.
  - Wherever the doc says a verb missing from the tables is unrecognized, change it to say it raises `std::exec`.

- [ ] **Step 2: `docs/dev/agents/approval-policies.md`**

Beside the paragraph that says "A `std::grep` rule also covers a bash `grep` that safeBash recognized", add one paragraph:
- A `std::exec` rule for a program now also covers that program's bash spelling through safeBash.
- From safeBash, `args` may carry an unexpanded glob.
- A rule for an interpreter (`node`, `python3`) should be keyed on `subcommand`.

- [ ] **Step 3: Spec Part 6**

Add a "Departures (ADI-243)" note:
- `agency` never becomes `std::exec` through bash.
- A command that reads a pipe or an input redirect stays broad, because the payload's `stdin` cannot describe it.
- The wrapper verbs keep the "no rule for" message.

- [ ] **Step 4: Index lines**

In `CLAUDE.md` and `.claude/skills/agency-stdlib-docs/SKILL.md`, the `safe-bash.md` line gains "programs with no rule (`std::exec`, the wrapper verbs, and what a saved rule covers)". In `CLAUDE.md` and `.claude/skills/agency-agent-docs/SKILL.md`, the `approval-policies.md` line gains "what a `std::exec` rule covers through safeBash". Each skill file goes in with `git add -f`, in a command of its own.

- [ ] **Step 5: Checks**

Run each of these, save the output to a file, and confirm it's green:
- `pnpm run typecheck`
- `pnpm run lint:structure`
- `pnpm vitest run lib/stdlibCapabilities.test.ts`
- the safeBash agency test
- `pnpm run agency test js tests/agency-js/safe-bash-user-rejection`, which pins the "no rule for `xargs`" text that must not change
- `make`, with no drift in `docs/site`

- [ ] **Step 6: Commit and PR**

Commit the docs and the index lines, then push. Put the PR body in a file, with:
- a before/after table for `pnpm test`, `make 2>&1 | tail -100`, `git push --force`, `sh -c x`, `git log | python3 x.py`, `pnpm test > out.log`, and `echo a; agency --version`;
- where to look: `execEffects` and `WRAPPER_VERBS`;
- the rows that changed meaning, with old and new strings;
- what's left out:
  - leading assignments (`AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm ...`), which needs an `env` field on the payload;
  - program paths (`./gradlew`);
  - `cd dir && pnpm test`, which is ADI-245.

Link ADI-243 and end with the attribution line. The owner merges.
