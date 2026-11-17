# safeBash: a `cd` on its own line

Status: approved by the owner on 2026-11-16, and built in PR #1487. That
PR began as a spike of a different design for the same problem. This
spec replaces that design, and the branch and its tests were reused.

## The problem

Models often start a shell call like this:

```
cd /Users/me/proj/packages/agency-lang
sed -n 480,560p lib/importPaths.ts
grep -n findPkgDir lib/importPaths.ts
```

safeBash understands a `cd` only on the left of `&&`. A `cd` followed by
a newline or `;` is a bash builtin with no rule, so the whole line asks
the broad `std::bash` question. No policy can approve `std::bash` in
advance, so a person has to answer every time.

In one `agency agent` session (trace `ilrJs0iv`), 10 of the 13 broad
prompts came from this shape. The commands after the `cd` were a plain
`sed` and a plain `grep`, which safeBash can describe with narrow
questions.

## Background: why `;` after a `cd` is broad today

```
cd packages/agency-lang && pnpm test
```

This line is narrow today. It asks one `std::exec` whose `cwd` is the
real `packages/agency-lang`. When the `cd` fails, bash runs nothing to
its right. So `pnpm test` only ever runs in the new folder, and a
payload that names that folder is true.

```
cd packages/agency-lang; pnpm test
```

Here bash runs `pnpm test` whether or not the `cd` worked. After a
failed `cd` it runs in the old folder. No payload for `pnpm test` is
true in both cases, so safeBash asks `std::bash`.

The first rule of safeBash is that a narrow payload describes what bash
is about to do. Any design for this line has to keep that rule.

## The design

safeBash rewrites a lone `cd` so that a failed `cd` ends the script. The
commands after it stay as the model wrote them.

The model writes:

```
cd /Users/me/proj/packages/agency-lang
sed -n 480,560p lib/importPaths.ts
grep -n findPkgDir lib/importPaths.ts
```

safeBash runs:

```
cd '/Users/me/proj/packages/agency-lang' || exit 1; sed -n 480,560p lib/importPaths.ts; grep -n findPkgDir lib/importPaths.ts
```

The questions it asks are one `std::exec` for `sed` and one `std::grep`
for the file. Both name the new folder. The `cd` raises nothing, as it
raises nothing on the left of `&&` today.

Every line that reaches a shell runs under `bash -c`
(`lib/host/node/nodeSubprocess.ts:158`). In a `bash -c` script, `exit 1`
at the top level ends the script. So each command after the guard runs
in the new folder, or it does not run. That is the same promise
`cd x && a` makes.

Bash would run the later commands in the old folder after a failed
`cd`. The rewritten line is stricter than the line as written. The
folder exists when the plan is made, because `cdTarget` checks it, so a
failure when the line runs means the folder went away in between.

### Where the rule applies

The rule applies to a `cd` that is a whole command in the top-level
list. The top-level list is the commands joined by `;` or a newline.
The `cd` may be first, in the middle, or last.

| Line | Result |
|---|---|
| `cd x; a` | narrow: `cd '/abs/x' \|\| exit 1; a` |
| `cd x` newline `a` newline `b` | narrow: one guard, then `a; b` |
| `a; cd x; b` | narrow: `a` is classified in the launch folder and `b` in `x` |
| `cd x; a; cd y; b` | narrow: two guards. `y` is resolved from `x` |
| `cd x; cd y; a` | narrow: two guards in a row. `y` is resolved from `x` |
| `cd x; a \|\| b` | narrow: `cd '/abs/x' \|\| exit 1; a \|\| b` |
| `cd x; cd y && b` | narrow: the guard, then today's `&&` rule |
| `cd x; (cd y && a); b` | narrow: the parentheses are a subshell, so `b` is classified in `x` |
| `cd x; a; cd ..` | narrow: a guard at each end, and `a` is classified in `x` |

The last row is a shape models write often: move in, run something, move
back. The trailing `cd` gets a guard like any other. It is resolved from
`x`, so it must name a folder that exists. No command runs after it, so
its guard changes only the line's exit code when the `cd` fails.

### What stays broad

Each of these asks `std::bash`, as it does today:

- A line where no command raises an effect. `cd x` as the whole line is
  one, and so is `cd x; echo hi`. Each command is recognized, but
  safeBash asks `std::bash` for every shell it starts, so a line with no
  narrow question asks the broad one. The original text runs, with no
  guard.
- A `cd` that `cdTarget` refuses: no argument, `cd -`, a variable, two
  arguments, a redirect, an assignment, a folder that does not exist, a
  file, or a resolved path that holds a single quote.
- `cd x || a`, `a && cd x`, and `cd x | a`.
- `cd x && a; b`. See "Not in this change".

## Why this design and not a copy of the `cd` per command

PR #1487 puts a copy of the `cd` in front of every later command:

```
cd '/abs/x' && sed -n 480,560p lib/importPaths.ts; cd '/abs/x' && grep -n findPkgDir lib/importPaths.ts
```

The guard design is preferred for four reasons.

1. **The later commands render as the parser built them.** In the PR, a
   later command that holds `||` becomes the right side of a hand-built
   `&&`:

   ```
   cd '/abs/x' && (ls || cat one.txt)
   ```

   The parentheses are needed. Without them bash would run
   `cat one.txt` in the old folder after a failed `cd`. They come from
   `chainOperandToBash` in tarsec's `astToBash`, in a branch its comment
   says the parser never produces. With the guard, `ls || cat one.txt`
   is a top-level command of its own and is rendered as written.
2. **The folder is resolved once when the line runs.** In the PR, an
   approved program can replace the folder with a symlink before the
   next copy of the `cd` runs. Then the next command runs somewhere
   else, under a payload that names the old folder. With one `cd`, the
   shell is already inside the folder.

   The guard closes the swap of the folder only. An approved command can
   still replace a file inside the folder with a link before a later
   command reads it, because each file payload is resolved when the plan
   is made. That gap exists today for `cd x && a && b`, and this change
   leaves it as it is.
3. **A failed `cd` prints one error.** The PR prints one per later
   command.
4. **The text is shorter.** A long absolute path appears once.

## Changes

All of the code change is in `classifyAll` in `stdlib/safeBash.agency`,
plus one small helper.

```
@capabilities(fileRead)
def classifyAll(commands: Command[], cwd: string, origin: GhRepo | null): Result<ClassifiedAll> {
  """
  Return the effects of every command and the tree to run, or the first reason one needs the broad Bash approval.
  """
  let effects: Effect[] = []
  let rewritten: Command[] = []
  // The directory the next command is classified in.
  let dir = cwd
  for (command, index in commands) {
    const cd = asCd(command)
    if (cd != null) {
      const moved = cdTarget(cd, dir)?
      rewritten.push(cdOrExit(cd, moved))
      dir = moved
      continue
    }
    const classified = classify(command, dir, origin, false)?
    // `cd x && a; b`: `b` runs in `x` only when the `cd` worked, so no
    // payload for `b` would be true in both cases.
    if (classified.cwd != dir && index < commands.length - 1) {
      return failure("a command after `;` follows a `cd`, and its directory depends on whether the `cd` worked")
    }
    effects = [...effects, ...classified.effects]
    rewritten.push(classified.command)
  }
  return success({ effects: effects, commands: rewritten })
}
```

`dir` is the folder the next command is classified in. A lone `cd`
moves it and adds the guard to the tree that will run. The function
keeps its `@capabilities(fileRead)` tag and its docstring. The comment
above it is rewritten to describe the guard.

The `cd` branch has no "not the last command" condition. A line that is
only `cd x` comes back with no effects, and `planLine` already turns an
empty effect list into the broad question.

```
def cdOrExit(command: SimpleCommand, dir: string): Command {
  const exit: SimpleCommand = {
    tag: "simpleCommand",
    assignments: [],
    command: EXIT_WORD,
    args: [literalWordOf("1")],
    redirects: []
  }
  return { tag: "or", left: cdTo(command, dir), right: exit }
}
```

`EXIT_WORD` is a new constant beside `GIT_WORD`:

```
static const EXIT_WORD: LiteralWord = { tag: "literal", text: "exit" }
```

A command name is a `LiteralWord` or a `PathWord`. `literalWordOf`
returns the wider type `Word`, so it builds the argument and the
constant is the command name. `insideRepository` does the same for the
`git rev-parse` check it writes.

`cdTo` already exists. It rewrites the `cd` to name the resolved folder
as an absolute real path in single quotes. The reasons for that are in
"`cd` on the left of `&&`" in `docs/dev/stdlib/safe-bash.md`, and they
apply here unchanged.

`exit` is a bash builtin, and a model that writes `exit` still gets
`std::bash`. The guard's `exit` is written by safeBash after
classification, like the `git rev-parse` check safeBash writes in front
of `git diff`. It never goes through `execEffects`.

Nothing else changes: the refuse wall, the delete refusal, the
in-process chain, `rebuild`, and the executors stay as they are.

## How the existing checks see the new lines

**The refuse wall.** It reads the flat list of the model's commands
before `classifyAll` runs, so it is unchanged. `cd x; shred f` is
refused.

**The delete refusal.** `removeEffects` checks each `rm` target against
the folder its command is classified in. That folder now follows a lone
`cd`. So `cd ..` followed by `rm -rf proj`, run from `proj`, gets no
`std::remove` and asks `std::bash`, as `cd .. && rm -rf proj` does
today.

**The `gh` repository lookup.** A `gh` read that names no repository is
looked up in the folder it is classified in. A line whose `gh` commands
need lookups in two folders still has no rule.

**The in-process chain.** `tryShellFreeChain` runs before `classifyAll`
and does not take a `cd` as a step. So `cd x` followed by `cat one.txt`
runs real `cat` through bash under `std::read`. See "Not in this
change".

**What the model reads on a failure.** The rewritten text is never
shown, which is the existing rule. When the guard ends the script, the
model reads bash's `cd` error and `Command exited with code 1`.

## What a policy sees

No new effect and no new payload field. A later command asks the
question it would ask after `cd x &&`, with the moved folder in `dir`
or `cwd`.

Every line this change makes narrow can already be written narrow
today, by putting each command in parentheses with its own `cd`:

```
(cd x && a); (cd x && b)
```

So a policy is not asked anything it could not be asked before. A saved
`std::exec` rule for `pnpm test` covers `pnpm test` in any folder
today, and that scope does not change.

## Not in this change

- **`cd x && a; b`.** The guard could cover it, by rewriting the line
  to `cd '/abs/x' || exit 1; a; b`. That rewrites the `&&` the model
  wrote, which is a second rule. It stays broad until a trace shows the
  shape is common.
- **A `cd` as a step of the in-process chain.** `cd x` followed by
  `cat one.txt` could run the read tool with no shell, by handing the
  moved folder to the steps after the `cd`.
- **`pwd` and `git -C dir`.** Both are broad today and both are common.
- **`make -C dir`.** It is narrow today with a `cwd` that names the
  launch folder while make runs in another. That is a separate fix.
- **A hard refusal of a delete after a `cd`.** `cd /` followed by
  `rm -rf usr` asks `std::bash` instead of being refused. This is true
  of `cd / && rm -rf usr` today.

## Why `exit 1` ends the script on both paths

The guard works only if `exit 1` ends the whole script. It does on the
foreground path and on the job path, because both hand the text to the
host as a shell script with nothing around it:

- The foreground path: `runBash` calls `_bash`, which calls
  `abortableShell` (`lib/stdlib/abortable.ts:123`).
- The job path: `_startJob` calls `addJob`, which calls
  `host.subprocess.start` (`lib/runtime/jobs/jobTable.ts:104`).
- Both end at `spawn(bash, ["-c", command.script])`
  (`lib/host/node/nodeSubprocess.ts:158`).

The text is never wrapped in a function and never sourced.

A function named `exit` cannot replace the builtin either. The host
removes `BASH_ENV` and every `BASH_FUNC_*` variable before bash starts.
The rewritten `cd` relies on the same removal today.

## Tests

All in `tests/agency/safeBash.agency`, and all but two only plan.

1. `cdOnItsOwnLineMovesTheRest`: each row of the "Where the rule
   applies" table, checking the outcome, the effect names, and the
   folder each payload names.
2. The rebuilt text for `cd grep-fixtures` followed by `ls` and
   `cat one.txt`: it starts with `cd '/`, holds
   `/stdlib/grep-fixtures' || exit 1; ls; cat one.txt`, and holds one
   `cd`.
3. The rebuilt text for `cd grep-fixtures` followed by
   `ls || cat one.txt`: it ends with `|| exit 1; ls || cat one.txt`,
   with no parentheses.
4. `cdOnItsOwnLineStaysStrict`: each row of "What stays broad",
   including `cd grep-fixtures` followed by `echo hi`.
5. `removeAfterCd`: the two existing rows again with the `cd` on its
   own line. These only plan and never run `rm`.
6. `cdAnywhereElseIsBroad`: move `cd grep-fixtures; ls` out, since it
   is now narrow. `cd grep-fixtures` alone stays in and stays broad.
7. One row that runs: `cd grep-fixtures` followed by
   `cat one.txt | head -1` through `safeBash`, checking the file's
   first line comes back. The test approves one `std::read`.
8. One row that runs the guard's failing side. It runs the text
   `cd '/no-such-folder-xyz' || exit 1; echo ran` with the `bash` tool
   and checks that `ran` is not printed and the exit code is 1. The
   planner cannot produce this text, because `cdTarget` refuses a
   missing folder, so the test writes it by hand. The `bash` tool raises
   `std::bash`, so the test approves it.

   Test 8 checks the executor. Bash itself always passes it. The test
   fails if someone later changes how the host runs a script, for
   example by wrapping the text in a function, sourcing it, or adding
   text after a subshell. In each of those, `exit 1` would stop ending
   the script and `ran` would print. The test's comment says this.

## How to test

Make every change first, then run `make` once and these once, saving
the output to a file:

```
pnpm run agency test tests/agency/safeBash.agency --check-capabilities
pnpm test:run lib/stdlib/safeBash.test.ts
pnpm run lint:structure
```

CI runs the rest of the agency suite.

## Docs

Update "`cd` on the left of `&&`" in `docs/dev/stdlib/safe-bash.md`: the
guard form with one example, the top-level list rule, and `exit` in the
list of text safeBash writes itself under "Rebuilt text when narrow".
`docs/site/stdlib/safeBash.md` is generated by `make`.
