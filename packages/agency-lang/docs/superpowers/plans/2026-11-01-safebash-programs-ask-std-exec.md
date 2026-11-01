# Programs with no rule of their own ask `std::exec` (ADI-243)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline, in this session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm test`, `make`, `pytest tests`, `tsc --noEmit`, and every other program safeBash has no rule for raise `std::exec`, the question the `exec` tool asks, in place of the broad `std::bash`. So "approve always here" on `pnpm test` saves `{ command: "pnpm", subcommand: "test" }`, and every later `pnpm test` runs with no prompt, alone or in a line such as `make 2>&1 | tail -100`.

**Architecture:** One new step at the end of `otherVerbEffects`, where today a verb with no rule fails with "no rule for". A verb that reaches that point is not owned by any rule, so it raises `std::exec` with the payload the `exec` tool would raise. A few cases stay broad:
- **Bash builtins** (`cd`, `export`, `hash`, `true`, ...), listed in `BUILTIN_VERBS`. The exec tool can't run a builtin, and some of them change what later commands do.
- **Programs that run other programs**, listed in `NO_EXEC_PROGRAMS`: the wrappers (`sh`, `xargs`, `env`, `sudo`, ...), the package runners (`npx`, ...), and `agency`.
- **A program fed by a pipe or `<`**, refused by `pipedProgram`, a helper placed beside `stdinStage`. Nothing else in the classifier moves. The line still runs through bash, as every narrow plan does.

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

### Bash builtins reach the same spot

Every bash builtin with no arm of its own also ends at "no rule for" today: `cd`, `export`, `hash`, `enable`, `set`, `shopt`, `test`, `true`, `false`, and the rest. None of them may become `std::exec`, for two reasons:

1. **The exec tool can't run a builtin.** There's no program to spawn (`spawn("cd")` fails with ENOENT). So no payload of the exec tool's shape can describe one.
2. **Some builtins change what later commands do.**
   - `cd .. && cat one.txt` reads the parent folder's `one.txt`, while the `std::read` payload names the one in the current folder. ADI-245 handles `cd` with care for this reason.
   - `hash -p /tmp/x git; git status` makes `git` run `/tmp/x`. `recommended` approves the git half, and the only other question would be about `hash`.
   - `enable -f /tmp/x.so git` loads a shared object as a builtin named `git`.
   - `export NODE_OPTIONS=--require=x; pnpm test` does what the leading-assignment rule refuses, but spread over two commands.

The rule: a bash builtin never raises `std::exec`. The list is what `bash -c 'compgen -b'` prints on bash 3.2 (58 names, checked on macOS), plus the three bash 5 adds (`mapfile`, `readarray`, `compopt`).

`echo` is a builtin too, but its own arm in `effectsFor` handles it first, so it never reaches this check. Keeping `true` and `false` broad also means the test rows that use them to keep a line broad don't change.

### Where the safeBash payload differs from the exec tool's

There are three differences, and the dev doc names all three:

1. **A glob argument** (`pytest tests/*.py`) is carried unexpanded, and bash expands it. The exec tool passes its arguments through as they are.
2. **An unquoted `~` in an argument** (`node ~/x.js`) is carried as written, and bash expands it. `literalWordText` accepts it as text.
3. **The environment.** The exec tool spawns its program with the process's environment. safeBash's bash runs with `shellEnvironment(env)`, which removes `BASH_ENV`, the `BASH_FUNC_*` variables, `POSIXLY_CORRECT`, and the rest. So a program approved through safeBash runs with slightly less than the same program approved through the exec tool. That's the safe direction.

### Why a lone program line still runs through bash

The dev doc's rule is that a lone command that translates exactly runs its stdlib tool in process. A lone `pnpm test`, with no glob, no `~`, no redirect, and no pipe, would translate exactly to `exec("pnpm", ["test"])`. This plan still runs every `std::exec` plan through bash. The two paths differ only in the environment scrub, so nothing is gained by switching. The dev doc's table row for `pnpm test` must say this is a deliberate exception to the rule, so a later reader doesn't "fix" it.

### Earlier checks

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
5. **`echo a; agency --version` and `pnpm build && agency test x.test.json`.** Expected: `std::bash`. `recommended` approves `std::exec` for `agency` with its safe subcommands, which were chosen for the `exec` tool. A lone `agency` line already runs in process through `tryAgencyPlan`. A bash spelling of it must not become an auto-approved `std::exec`.
6. **`pnpm test > out.log`.** Expected: `std::exec` and `std::write`. The redirect is classified as it is today.
7. **`cd .. && cat one.txt`, `hash -p /tmp/x git; git status`, `export X=1; pnpm test`.** Expected: `std::bash`, with "`cd` is a bash builtin, not a program" (or `hash`, or `export`). The `cd` row is what keeps the design space open for ADI-245.
8. **`npx -y foo`.** Expected: `std::bash`. Its subcommand would be `-y`, so "approve always" would save `{ npx, -y }`, which covers every package.
9. **`pnpm test | grep -v warn` and `cat one.txt | pnpm test`.** Expected: the first is narrow with `std::exec` alone, because the grep reads the pipe and adds nothing. The second is broad, because `pnpm` reads the pipe.

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

**The effect contract.** The comment above the imports at the top of `safeBash.agency` says an effect's declaration comes with an import from its module, and without one, a raise site's payload isn't checked. `safeBash.agency` already imports `bash, grep, ls, glob` from `std::shell`, where `std::exec` is declared, so the declaration should already be in scope. Check it once: temporarily misspell a field in the new raise (`subcomand: ...`), run `pnpm run agency typecheck stdlib/safeBash.agency`, and confirm it reports the field. Then remove the misspelling. Only if it doesn't report it, import the tool under another name, `import { exec as execTool } from "std::shell"` (`safeBash` has a local named `exec`), and check again. Record the result in the ledger.

- [ ] **Step 1:** Add the type, `execEffect`, the `Effect` variant, the `raiseOne` arm, and the `raises` entry. Run the contract check above.
- [ ] **Step 2:** `make`, then `pnpm run agency typecheck stdlib/safeBash.agency stdlib/safeBash/actions.agency`. Expected: no type errors. Nothing raises `std::exec` yet, so the safeBash test is unchanged. Run it once to confirm that it is still green.
- [ ] **Step 3:** Commit. Message: `safeBash: the std::exec effect and its raise site`.

---

### Task 2: A verb with no rule asks `std::exec`

**Files:**
- Modify: `stdlib/safeBash.agency` (`otherVerbEffects`, new `BUILTIN_VERBS`, `NO_EXEC_PROGRAMS`, `execEffects`, `execArgs`, and `pipedProgram` beside `stdinStage`)
- Modify: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**

```agency
/** Bash builtins. The exec tool cannot run one, so no std::exec payload
 * can describe it, and some change what later commands run (`cd`,
 * `hash -p`, `enable -f`, `export`). `bash -c 'compgen -b'` on bash 3.2,
 * plus mapfile, readarray, and compopt from bash 5. */
static const BUILTIN_VERBS: string[] = [
  ".", ":", "[", "alias", "bg", "bind", "break", "builtin", "caller", "cd",
  "command", "compgen", "complete", "compopt", "continue", "declare",
  "dirs", "disown", "echo", "enable", "eval", "exec", "exit", "export",
  "false", "fc", "fg", "getopts", "hash", "help", "history", "jobs", "kill",
  "let", "local", "logout", "mapfile", "popd", "printf", "pushd", "pwd",
  "read", "readarray", "readonly", "return", "set", "shift", "shopt",
  "source", "suspend", "test", "times", "trap", "true", "type", "typeset",
  "ulimit", "umask", "unalias", "unset", "wait"
]

/** Programs that never become std::exec. They ask std::bash. */
static const NO_EXEC_PROGRAMS: string[] = [
  // Programs that exist to run another program. A payload for one would
  // name the wrapper, while what runs is in its arguments, so a rule
  // `{ command: "sh" }` would approve anything.
  "sh", "bash", "zsh", "dash", "fish", "xargs", "env", "sudo", "doas",
  "nohup", "time", "timeout", "watch", "nice", "script",
  // Package runners. `npx -y foo` has subcommand `-y`, so a saved
  // `{ npx, -y }` would cover every package. (`pnpm dlx` and `npm exec`
  // are keyed on a subcommand that names the behaviour, so they stay.)
  "npx", "bunx", "uvx", "pipx",
  // A lone `agency` line runs in process through std::agency, and
  // recommended approves std::exec for agency's safe subcommands, which
  // were chosen for the exec tool. A bash spelling must not pick that up.
  "agency"
]
```

There are two lists because they give two different answers. A builtin is refused with a message that says what it is. The programs keep today's "no rule for" text.

```agency
def execEffects(verb: string, command: SimpleCommand, cwd: string, readsStdin: boolean, redirects: Effect[]): Result<Effect[]>
```

`otherVerbEffects`'s last line, today `return failure("no rule for `${verb}`")`, becomes `return execEffects(verb, command, cwd, readsStdin, redirects)`. `execEffects` checks these in order:

1. If the verb is in `BUILTIN_VERBS`, fail with `"`${verb}` is a bash builtin, not a program"`.
2. If the verb is in `NO_EXEC_PROGRAMS`, fail with `"no rule for `${verb}`"`. That's the same text as today, on purpose. Four expected outputs pin it: `planReasons`, `rejectedBroadSaysWhy`, the `git log | xargs echo` row, and the agency-js fixture `tests/agency-js/safe-bash-user-rejection/fixture.json`. The sentence is still true, because safeBash has no rule for a wrapper.
3. `pipedProgram(verb, readsStdin, command)` fails when the program's stdin is a pipe or an input redirect.
4. `execArgs(verb, command.args)` turns the words into text, or fails.
5. Return `success([execEffect(payload), ...redirects])`, with this payload:
   - `command: verb`
   - `args`
   - `subcommand`: `args[0]`, or `""` when there are no arguments. Write it as a small def, so there's no if-else inside the record.
   - `cwd`
   - `timeout: 0`
   - `stdin: ""`

```agency
def pipedProgram(verb: string, readsStdin: boolean, command: SimpleCommand): Result
```

`pipedProgram` sits right after `stdinStage` and is its counterpart, for a program that std::exec describes. The `std::exec` payload's `stdin` is `""`, so a program fed by a pipe or by `<` would be misdescribed. It fails with `"`${verb}` reads a pipe, and std::exec cannot say what it reads"` when `readsStdin` is true. It fails with `"`${verb}` reads an input redirect, and std::exec cannot say what it reads"` when a redirect on the command has op `"<"`. Read the command's own `redirects` field for that, not the effects. By this point the `<` has already become a `std::read` effect, and an effect doesn't say which command it came from. Put that reason in the def's doc comment.

The dev doc ("Stages that read a pipe") says `stdinStage` is the only place that reads the pipe flag. After this plan there are two, side by side, one per kind of command: `stdinStage` for a verb whose rule can read stdin, and `pipedProgram` for a program `std::exec` describes. Change that sentence to name both, and keep every other reader out.

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
    grepNames("cd .. && cat one.txt"),
    grepNames("hash -p /tmp/x git; git status"),
    grepNames("export X=1; pnpm test"),
    grepNames("true"),
    grepNames("npx -y foo"),
    grepNames("pnpm test | grep -v warn"),
    grepNames("cat one.txt | pnpm test"),
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
20. `U("`cd` is a bash builtin, not a program")`
21. `U("`hash` is a bash builtin, not a program")`
22. `U("`export` is a bash builtin, not a program")`
23. `U("`true` is a bash builtin, not a program")`
24. `U("no rule for `npx`")`
25. `X`
26. `U("`pnpm` reads a pipe, and std::exec cannot say what it reads")`

A payload node. `lsPayloads` and `globPayloads` each repeat the same loop: plan the line, keep the effects with one name, and read their payloads. Don't add a third copy. Add one generic helper and use it here. It reads each effect through an `any` local, the way `payloadValuesAreCorrect` does, because a name held in a variable doesn't narrow the union:

```agency
/** The payloads of the effects named `name` in the plan for `source`. */
def payloadsNamed(source: string, name: string): any[] {
  let out: any[] = []
  for (effect in planFor(source, FIXTURES).effects) {
    const each: any = effect
    if (each.name == name) {
      out.push(each.payload)
    }
  }
  return out
}

def execFields(source: string): any {
  return [[p.command, p.args, p.subcommand, p.cwd == FIXTURES, p.timeout, p.stdin] for p in payloadsNamed(source, "std::exec")]
}

node execPayloadFields() {
  return [
    execFields("pnpm run build --filter=web"),
    execFields("make"),
    execFields("pytest tests/*.py -k fast"),
  ]
}
```

Leave `lsPayloads` and `globPayloads` as they are. They work, and switching them isn't part of this ticket.

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

**Rows that change meaning.** `true` and `false` are builtins, so they stay broad. The rows that use them to keep a line broad don't change: `nonZeroExitIsAFailure`, `sequenceRunsThroughBash`, `echoIsTheSameAloneAndInAChain`, and the `echo a; true` row of `chainsOfInProcessCommands` keep their strings, expectations, and comments. Two rows change, and they're the ones the ticket is about:

- `newShapes` has the row `make 2>&1 | tail -100`. Its expectation becomes `["bash",["std::exec"]]`. This row is the ticket's own acceptance line.
- `grepUnrecognized` has the row `rg hello .`. It becomes `[["std::exec"],null]`. Add a sentence to that node's description: rg is not grep and has no row, so it asks std::exec like any other program.

Before running anything, grep the test file once more for strings whose first word is a program with no rule and isn't a builtin (`make`, `node`, `python3`, `rg`, `tee`, `date`, and so on). Record every row you find in the ledger, as kept or swapped, with the old and new string. `git log | tee log.txt` stays broad, because `tee` reads the pipe. Check that the row still expects that.

- [ ] **Step 2: Run to verify they fail**

Run the agency test into `$SCRATCH/t2.txt`. Expected:
- every `std::exec` row says `std::bash` with "no rule for";
- the payload node returns empty lists;
- `programAsksOneQuestion` fails on an unmatched `std::bash` interrupt.

The two changed rows (`make` and `rg`) fail for the same reason. The builtin rows fail on their message: today they say "no rule for", and after the change they say "is a bash builtin". The `npx` row and the pipe-fed rows already pass, which is expected.

- [ ] **Step 3: Implement**

The interfaces above. Put `BUILTIN_VERBS`, `NO_EXEC_PROGRAMS`, `execEffects`, and `execArgs` right after `otherVerbEffects`, and `pipedProgram` right after `stdinStage`.

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
  - "In process when it translates", the table: add the row `pnpm test` | real pnpm, through bash | `std::exec`, as the exec tool does. Under the table, add one sentence saying this row is a deliberate exception to the lone-command rule: a lone program line would translate to `exec`, but the two paths differ only in the environment scrub, so it runs through bash.
  - New section "Programs with no rule", after "Listings". It covers:
    - the rule: a verb no arm or table owns raises `std::exec`, built in `execEffects`;
    - the payload: the exec tool's fields, `line` for the full command, `cwd` resolved, `timeout` 0, and `stdin` empty;
    - the three ways it differs from the exec tool's: an unexpanded glob, an unexpanded `~`, and the scrubbed environment;
    - why ownership needs no list: the arms and tables fail inside themselves, so `git push`, `find . -delete`, and `tail -f` never reach the new step;
    - the exceptions and the reason for each:
      - `BUILTIN_VERBS`: the exec tool can't run a builtin, and `cd`, `hash`, `enable`, and `export` change what later commands do;
      - `NO_EXEC_PROGRAMS`: the wrappers, the package runners, and `agency`;
      - a program fed by a pipe or `<`, through `pipedProgram`;
      - from earlier checks, a leading assignment and a command word that isn't literal;
    - why the wrapper message is still "no rule for";
    - what a saved rule covers: `@always(command, subcommand)` covers the program with that first argument in any folder, with any later arguments, the same as for the exec tool;
    - interpreters: `node -e '...'` is as broad as `sh -c`, so a rule for an interpreter should be keyed on `subcommand`;
    - that `rg --pre=<program>` runs another program per file, so a saved rule for `rg` covers that too.
  - In "Stages that read a pipe", the sentence that names `stdinStage` as the only reader of the pipe flag now names `stdinStage` and `pipedProgram`.
  - Wherever the doc says a verb missing from the tables is unrecognized, change it to say it raises `std::exec`.

- [ ] **Step 2: `docs/dev/agents/approval-policies.md`**

Beside the paragraph that says "A `std::grep` rule also covers a bash `grep` that safeBash recognized", add one paragraph:
- A `std::exec` rule for a program now also covers that program's bash spelling through safeBash.
- From safeBash, `args` may carry an unexpanded glob.
- A rule for an interpreter (`node`, `python3`) should be keyed on `subcommand`.
- "Approve always here" pins only `command` and `subcommand`. Approving `pnpm test` in one folder alone needs a hand-written rule with a `cwd` glob. From safeBash, `cwd` is always the resolved absolute folder, while from the exec tool it's whatever the model passed, often `""`. So a `cwd` rule written for safeBash matches the exec tool only when the model passes an absolute cwd.

- [ ] **Step 3: Spec Part 6**

Add a "Departures (ADI-243)" note:
- `agency` never becomes `std::exec` through bash.
- A bash builtin never becomes `std::exec`, and is refused with its own message.
- The package runners `npx`, `bunx`, `uvx`, and `pipx` join the wrapper verbs.
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
- a before/after table for `pnpm test`, `make 2>&1 | tail -100`, `pnpm test | grep -v warn`, `git push --force`, `cd .. && cat one.txt`, `sh -c x`, `npx -y foo`, `git log | python3 x.py`, `pnpm test > out.log`, and `echo a; agency --version`;
- where to look: `execEffects`, `BUILTIN_VERBS`, `NO_EXEC_PROGRAMS`, and `pipedProgram`;
- the rows that changed meaning, with old and new strings;
- what's left out:
  - leading assignments (`AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm ...`), which needs an `env` field on the payload;
  - program paths (`./gradlew`);
  - `cd dir && pnpm test`, which is ADI-245.

Link ADI-243 and end with the attribution line. The owner merges.
