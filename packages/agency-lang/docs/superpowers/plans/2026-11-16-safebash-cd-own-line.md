# Plan: safeBash, a `cd` on its own line

Spec: `docs/superpowers/specs/2026-11-16-safebash-cd-own-line-design.md`
Review: `docs/superpowers/specs/2026-11-16-safebash-cd-own-line-design-review.md`

Build this only after the owner approves the spec. The change alters
what a user is asked, so the design is approved before code is written.
When the approval comes, change the spec's status line to say so.

Paths in this plan are relative to `packages/agency-lang` in the
worktree `.worktrees/safebash-cd-newline`, on the branch
`adit/safebash-cd-newline`. PR #1487 is open from that branch.

## What this plan builds

The model writes:

```
cd /Users/me/proj/packages/agency-lang
sed -n 480,560p lib/importPaths.ts
grep -n findPkgDir lib/importPaths.ts
```

Today this asks the broad `std::bash` question. After this plan,
safeBash asks one `std::exec` for `sed` and one `std::grep` for the
file, and runs:

```
cd '/Users/me/proj/packages/agency-lang' || exit 1; sed -n 480,560p lib/importPaths.ts; grep -n findPkgDir lib/importPaths.ts
```

The `cd '…' || exit 1` at the front is called the guard in this plan.
When the `cd` fails, `exit 1` ends the script, so no later command runs
in the wrong folder.

## Background

### How safeBash decides what to ask

`planFor(source, cwd)` in `stdlib/safeBash.agency` parses the command
string and returns a plan. A plan holds the effects to raise and the
text to run. `planLine` does the work, in this order:

1. It tries the in-process paths, which run no shell.
2. It runs the refuse wall and the delete refusal over every command.
3. It calls `classifyAll`, which returns the effects of every command
   and a rewritten command tree.
4. If `classifyAll` fails, the plan is broad: it asks `std::bash` and
   runs the original text.
5. If `classifyAll` returns no effects, the plan is also broad.
6. Otherwise the plan is narrow. `rebuild` renders the rewritten tree to
   text, joining the top-level commands with `; `, and that text runs.

### How a `cd` is handled today

`classifyAnd` handles `cd x && a`. It resolves `x` with `cdTarget`,
classifies `a` in the resolved folder, and rewrites the `cd` with `cdTo`
so that it names the absolute real path in single quotes.

A `cd` anywhere else reaches `execEffects`, which fails with "`cd` is a
bash builtin, not a program". That failure makes the whole line broad.

### What is on the branch now

The branch has one pushed commit, `b65c9cbec`. It is a spike of a
different design: `classifyAll` puts a copy of the `cd` in front of each
later command. This plan replaces that code with the guard. It keeps the
spike's test helpers where they still fit.

The new work goes in new commits on top of the spike. Do not amend the
spike commit and do not force push.

## Step 1: `classifyAll` and `cdOrExit`

File: `stdlib/safeBash.agency`.

### 1a. Replace the comment and body of `classifyAll`

The spike's version starts near line 4198. Replace the comment above the
function and the whole function with this:

```
// Classify the whole string. This walks the command tree, where the refuse
// wall reads the flat list, because a `cd` moves the working directory for
// the commands after it.
//
// A `cd` that is a whole command of the top-level list is run behind a
// guard, and every command after it is classified in the new directory:
//
//   cd x
//   a          =>   cd '/abs/x' || exit 1; a; b
//   b
//
// When the `cd` fails, `exit 1` ends the script. Bash would otherwise run
// `a` and `b` in the old directory, where their payloads would be false.
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

Three things differ from the spike:

1. The `carried` variable is gone. Nothing is copied in front of later
   commands.
2. The `cd` branch has no "not the last command" condition. A trailing
   `cd` gets a guard too.
3. A later command is pushed as `classify` returned it. It is never made
   the right side of a hand-built `&&`.

A line that is only `cd x` now comes back from `classifyAll` with no
effects. Step 5 of `planLine` in "Background" turns that into the broad
question, so the line still asks `std::bash`.

The comment above that branch in `planLine` says the case is "a string
of nothing but echoes". Change it to name both cases:

```
    // Everything recognized but nothing contributed an effect: a string
    // of nothing but echoes, or a `cd` with nothing after it that asks a
    // question. The audit rule makes this a std::bash question, so by
    // the same rule it runs the original text.
```

### 1b. Add `EXIT_WORD` and `cdOrExit`

Add a constant below `GIT_WORD`, near line 2472:

```
static const EXIT_WORD: LiteralWord = { tag: "literal", text: "exit" }
```

A command name has the type `ScriptName`, which is `LiteralWord |
PathWord`. `literalWordOf` returns the wider type `Word`, so it cannot
build a command name. `insideRepository` uses the constant `GIT_WORD`
for its command name for the same reason.

`cdTo` is near line 4343. Add this below it:

```
// The guard for a `cd` that is a whole command: `cd '/abs' || exit 1`.
// safeBash writes the `exit` itself, after classification, so it never
// reaches `execEffects`, which refuses a builtin the model wrote.
def cdOrExit(command: SimpleCommand, dir: string): Command {
  """
  Rewrite a cd command to name a resolved directory and to end the script when it fails.
  """
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

`literalWordOf` already exists near line 2543. An argument is a `Word`,
so it fits there. `insideRepository` uses it the same way for the
arguments of the `git rev-parse` check it writes.

Nothing else in the file changes.

## Step 2: tests

Files: `tests/agency/safeBash.agency` and
`tests/agency/safeBash.test.json`.

Every test below except the last two only plans. `planFor` runs nothing,
so the delete rows never run `rm`.

`cdSummary(source)` already exists. It plans the line in
`tests/agency/stdlib` and returns the outcome and, for each effect, its
name and the last part of the folder its payload names.

### 2a. Replace `cdOnItsOwnLineMovesTheRest` and its helper

Remove the spike's `rebuiltCdRunsBeforeEachCommand`. Replace the node
and add one helper:

```
// A `cd` that is a whole command moves every command after it. It runs
// behind a guard, `cd '/abs' || exit 1`, so a later command runs in the
// new folder or not at all.
node cdOnItsOwnLineMovesTheRest() {
  return [
    cdSummary("cd grep-fixtures; ls"),
    cdSummary("cd grep-fixtures\nls\ncat one.txt"),
    cdSummary("ls\ncd grep-fixtures\nls"),
    cdSummary("cd grep-fixtures\nls\ncd ../read-fixtures\nls"),
    cdSummary("cd grep-fixtures\ncd ../read-fixtures\nls"),
    cdSummary("cd grep-fixtures\nls || cat one.txt"),
    cdSummary("cd grep-fixtures; cd ../read-fixtures && ls"),
    cdSummary("cd grep-fixtures\n(cd ../read-fixtures && ls)\nls"),
    cdSummary("cd grep-fixtures\nls\ncd .."),
    rebuiltEndsWith("cd grep-fixtures\nls\ncat one.txt", "/stdlib/grep-fixtures' || exit 1; ls; cat one.txt"),
    rebuiltEndsWith("cd grep-fixtures\nls || cat one.txt", "/stdlib/grep-fixtures' || exit 1; ls || cat one.txt"),
  ]
}

// The rebuilt text holds one `cd`, at the front, and ends with the given
// text. The folder's path differs by machine, so only the end is compared.
// On a mismatch the text itself comes back, so the test output shows it.
def rebuiltEndsWith(source: string, ending: string): any {
  const command: string = executionCommandIn(source, STDLIB_TESTS)
  const oneCd = command.split("cd '/").length == 2
  if (command.startsWith("cd '/") && oneCd && command.endsWith(ending)) {
    return true
  }
  return command
}
```

The second `rebuiltEndsWith` row is the one the spike could not pass:
`ls || cat one.txt` is rendered with no parentheses around it.

The file already has a helper that does the same check for one fixed
ending, `rebuiltCdNamesTheResolvedFolder`. It has one caller, in
`cdMovesTheRestOfAnAndChain`. Change that call to the new helper and
delete the old one, so the file has one way to check rebuilt text:

```
    rebuiltEndsWith("cd grep-fixtures && ls", "/stdlib/grep-fixtures' && ls"),
```

The expected output of `cdMovesTheRestOfAnAndChain` does not change.
The row still returns `true`.

Expected output, in the order of the rows:

```
[
  ["narrow",[["std::ls","grep-fixtures"]]],
  ["narrow",[["std::ls","grep-fixtures"],["std::read","grep-fixtures"]]],
  ["narrow",[["std::ls","stdlib"],["std::ls","grep-fixtures"]]],
  ["narrow",[["std::ls","grep-fixtures"],["std::ls","read-fixtures"]]],
  ["narrow",[["std::ls","read-fixtures"]]],
  ["narrow",[["std::ls","grep-fixtures"],["std::read","grep-fixtures"]]],
  ["narrow",[["std::ls","read-fixtures"]]],
  ["narrow",[["std::ls","read-fixtures"],["std::ls","grep-fixtures"]]],
  ["narrow",[["std::ls","grep-fixtures"]]],
  true,
  true
]
```

Write it into `safeBash.test.json` on one line with no spaces and with
the quotes escaped, as the neighbouring entries are. Rows 1, 2, 3 and 5
are the values the spike's test already produced. The other rows are
worked out from the code and have not been run.

If a row comes back different, find out why before changing the
expected value. Do not paste the actual output in to make the test
pass.

Update the entry's description to:

> A cd that is a whole command moves every command after it: first on
> the line, after a command, twice, last on the line, before an ||
> chain, before a cd && chain, and before a subshell. The rebuilt text
> holds one cd behind `|| exit 1`, and the later commands are rendered
> as written.

### 2b. Replace `cdOnItsOwnLineStaysStrict`

```
// Lines that still ask std::bash: a `cd` that names no folder safeBash
// can resolve, a later command that moves again and is not last, a line
// where no command raises an effect, and `cd x && a; b`.
node cdOnItsOwnLineStaysStrict() {
  return [
    cdSummary("cd missing\nls"),
    cdSummary("cd -\nls"),
    cdSummary("cd $HOME\nls"),
    cdSummary("cd grep-fixtures\ncd ../read-fixtures && ls\nls"),
    cdSummary("cd grep-fixtures\necho hi"),
    cdSummary("cd grep-fixtures && ls; cat one.txt"),
  ]
}
```

Expected output: six copies of `["broad",[["std::bash",""]]]` in one
array. Update the entry's description to name the six cases.

### 2c. `removeAfterCd` and `cdAnywhereElseIsBroad`

Both are already right on the branch. The spike added the two
own-line rows to `removeAfterCd` and took `cd grep-fixtures; ls` out of
`cdAnywhereElseIsBroad`. Leave them and their expected outputs as they
are.

`cd grep-fixtures` alone stays in `cdAnywhereElseIsBroad`. It is still
broad, now because the line raises no effect.

### 2d. Add `cdOnItsOwnLineRunsInTheNewFolder`

Put it below `cdRunsInTheNewFolder`:

```
node cdOnItsOwnLineRunsInTheNewFolder() {
  // Approved by the test file: one std::read for one.txt in grep-fixtures.
  const result = safeBash("cd grep-fixtures\ncat one.txt | head -1", cwd: STDLIB_TESTS)
  if (result is failure(why)) {
    return "FAILED: ${why}"
  }
  return result.value.trim() == "hello world"
}
```

`hello world` is the first line of
`tests/agency/stdlib/grep-fixtures/one.txt`.

Its `safeBash.test.json` entry is a copy of the `cdRunsInTheNewFolder`
entry: expected output `true`, and one `interruptHandlers` item with
`"action": "approve"` and `"expectedMessage": "Are you sure you want to
read this file?"`.

This test fails if the read happens anywhere but `grep-fixtures`.

### 2e. Add `guardEndsTheScript`

```
// The guard depends on `exit 1` ending the whole script. Bash always does
// that for a `bash -c` script, so this test is about the host. It fails
// if the host ever runs a script inside a function, sources it, or adds
// text after it, because then `ran` would print.
node guardEndsTheScript() {
  const result = bash("cd '/no-such-folder-xyz' || exit 1; echo ran", cwd: STDLIB_TESTS) with approve
  return [result.stdout.includes("ran"), result.exitCode]
}
```

Expected output: `[false,1]`.

Add a `safeBash.test.json` entry for it with that expected output. The
entry needs no `interruptHandlers`, because the `with approve` in the
node answers the interrupt.

The planner cannot produce this text, because `cdTarget` refuses a
folder that does not exist. So the test writes the text by hand and
runs it with the `bash` tool. The `with approve` answers the `std::bash`
question the `bash` tool raises.

## Step 3: the dev doc

File: `docs/dev/stdlib/safe-bash.md`.

Dev docs describe the mechanism and the rule. Leave out the spike, the
trace, and how the design was reached.

### 3a. The section "`cd` on the left of `&&`"

Rename it to "`cd`", since it now covers both forms. Check for links to
the old heading with a search for `on the left of` in `docs/` and
`stdlib/`, and update each one.

The paragraph that starts "The rule rests on `&&`" ends by saying that
no payload is true for a command after `;`. The guard makes that false
for `;`. Replace the paragraph with:

```
The `&&` form needs no help from safeBash. When the `cd` fails, bash
runs nothing to its right, so the commands there only ever run in the
new directory, and a payload that names it is true. After `;` or a
newline, bash runs the next command even when the `cd` failed, so
safeBash adds a guard that ends the script instead. After `||` the next
command runs only when the `cd` failed, so that line is broad.
```

Remove the spike's paragraphs, from "A `cd` alone before `;` or a
newline is turned into the `&&` form" through "because the commands are
classified there." Put this in their place:

````
A `cd` that is a whole command of the top-level list runs behind a
guard:

```
cd /Users/me/proj/packages/agency-lang
sed -n 480,560p lib/importPaths.ts
grep -n findPkgDir lib/importPaths.ts
```

runs as

```
cd '/Users/me/proj/packages/agency-lang' || exit 1; sed -n 480,560p lib/importPaths.ts; grep -n findPkgDir lib/importPaths.ts
```

The `cd` raises nothing. `classifyAll` classifies every command after it
in the new directory. When the `cd` fails, `exit 1` ends the script, so
a later command runs in the new directory or it does not run. Bash
would run it in the old directory, so the line is stricter than it was
written. `cdOrExit` builds the guard.

The guard depends on `exit 1` ending the whole script. Every shell line
runs as `bash -c <text>` with nothing around the text, on the foreground
path and on the job path. `guardEndsTheScript` fails if that changes.

A line where no command raises an effect is still broad. `cd x` alone
and `cd x; echo hi` both ask `std::bash` and run the original text.
````

In the list of tree nodes, replace the "top-level list" item with:

```
- **the top-level list**: a `cd` that is a whole command moves every
  command after it, behind the guard. Any other command that ends in
  another directory must be the last one, so `cd x && a; b` is broad and
  `a; cd x && b` is not.
```

In the paragraph that starts "`cdTarget` accepts one literal argument",
the last two sentences list where a `cd` is still refused as a builtin.
Replace them with:

```
A `cd` in any other position is a simple command like any other, and
`execEffects` refuses it as a builtin. That covers a `cd` on the right
of `&&` or `||`, a `cd` in a pipeline, and `cd x && cd y && a`, where the
second `cd` is the right side of the inner `&&`.
```

### 3b. "The rules", the item "Rebuilt text when narrow"

It says three commands in the tree are written by the classifier. Add
the fourth: the `exit 1` of a guard.

### 3c. Generated docs

Do not edit `docs/site/stdlib/safeBash.md` by hand. `make` regenerates
it, and its line-number links will change.

## How to test

Make every change in steps 1 to 3 first. Then build once and run each
command once, saving the output:

```
make > "$OUT/make.out" 2>&1
pnpm run agency test tests/agency/safeBash.agency --check-capabilities > "$OUT/safebash-test.out" 2>&1
pnpm test:run lib/stdlib/safeBash.test.ts > "$OUT/safebash-unit.out" 2>&1
pnpm run lint:structure > "$OUT/lint.out" 2>&1
```

`$OUT` is the session's scratch folder, outside the repository. Read a
failure from the saved file. Do not run a command a
second time to see what failed.

`lib/stdlib/safeBash.test.ts` tests no new code. It checks that every
command family still renders and parses back to the same tree, and it
is cheap, so it runs as a safety check.

Do not run the whole agency suite. CI runs it on the PR.

No hand-written TypeScript changes, so `pnpm run fmt:ts` and
`pnpm run typecheck` have nothing to check. Do not run `agency fmt` on
`stdlib/safeBash.agency` or `tests/agency/safeBash.agency`. Both files
existed before this PR, and formatting them would bury the diff.

## Before the commit

1. Read the diff against `docs/dev/contributing/anti-patterns.md`.
2. Read the new comments and the dev doc text against
   `~/.claude/skills/simplify-speech/verbal-tics.md`.
3. Confirm `git status` shows only the files this plan names, plus the
   regenerated `docs/site/stdlib/safeBash.md`, the spec, the review, and
   this plan.
4. Confirm the branch is `adit/safebash-cd-newline`.

## Commit and PR

1. Write the commit message to a file and pass it with `git commit -F`.
   A message with an apostrophe on the command line fails.
2. Make a new commit. Do not amend.
3. Push only when all four commands in "How to test" exited 0.
4. Rewrite the PR description from a file with
   `gh pr edit 1487 --body-file`. The current description explains the
   copy-per-command design, which this plan removes. The new one
   describes the guard, the table of lines from the spec, and the tests.
   It does not call the work a spike, because the design is approved by
   then. Keep the title.
5. Watch CI on the head commit. Stop there. The owner merges.

## Not in this plan

These are listed in the spec under "Not in this change", and none of
them is built here:

- `cd x && a; b`
- a `cd` as a step of the in-process chain
- `pwd` and `git -C dir`
- the `cwd` in the payload of `make -C dir`
- a hard refusal of a delete after a `cd`
