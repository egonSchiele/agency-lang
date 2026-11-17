# Review: plan for safeBash, a `cd` on its own line

Plan: `docs/superpowers/plans/2026-11-16-safebash-cd-own-line.md`
Spec: `docs/superpowers/specs/2026-11-16-safebash-cd-own-line-design.md`

## Verdict

The plan is ready to build after two fixes. The first is a type error in
`cdOrExit`, which the spec has too. The second is a paragraph in the dev
doc that the plan leaves in place and that would contradict the new
text.

The plan matches the spec. It also takes every point from the spec
review: the trailing `cd`, the `echo hi` row, the word helpers, and a
comment on the `exit` test that says what makes it fail.

I checked the plan's claims about the code on the branch. The results
are in "What I checked" at the end.

## Must fix

### 1. `literalWordOf` returns a `Word`, and a command name must be a `ScriptName`

Step 1b writes:

```
command: literalWordOf("exit"),
```

`literalWordOf` is declared to return `Word` (`stdlib/safeBash.agency:2543`).
`SimpleCommand.command` is a `ScriptName`, which is `LiteralWord | PathWord`
(`stdlib/safeBash.agency:130`). `Word` is wider: it includes variables,
quoted words, and flags. So the type checker should reject this line.

`insideRepository` does not hit this, because its command name is
`GIT_WORD`, a constant declared as `LiteralWord` (`stdlib/safeBash.agency:2472`).
It uses `literalWordOf` only for arguments.

Do the same here. Add a constant next to `GIT_WORD`:

```
static const EXIT_WORD: LiteralWord = { tag: "literal", text: "exit" }
```

and write `command: EXIT_WORD`. Keep `args: [literalWordOf("1")]`,
because an argument is a `Word`.

The spec's sketch at line 209 has the same line. Fix it there too, so
the two documents agree.

### 2. The dev doc keeps a paragraph that says `;` after a `cd` is always broad

Step 3a replaces the dev doc from "A `cd` alone before `;` or a newline"
onward. The paragraph just before that stays:

> The rule rests on `&&`. When the `cd` fails, bash runs nothing to its
> right, so the commands there only ever run in the new directory, and a
> payload that names it is true. After `;` or `||` the next command runs
> whether or not the `cd` worked, in a directory that depends on which,
> so no payload for it would be true in both cases.

After this change, the second half of that paragraph is wrong for `;`.
The guard is exactly what makes a payload after `;` true. A reader who
stops at that paragraph learns the old rule.

Suggested edit: end the paragraph after "a payload that names it is
true." Then add one sentence that leads into the new text, such as:
"After `;` or a newline, bash runs the next command even when the `cd`
failed, so safeBash adds a guard that ends the script instead."

## Should fix

### 3. Build only after the owner approves the spec

The spec's status line still says "design, waiting for a yes." The plan
does not mention that. Under the rule for safety changes, the owner
approves the design before code is written, and approval of the spec is
that step. Add one line at the top of the plan: build only after the
owner approves the spec.

When that approval comes, also update the spec's status line. The PR
description that step 4 of "Commit and PR" rewrites should stop calling
the work a spike.

### 4. Make `rebuiltEndsWith` show the text when it fails

When a row fails, `rebuiltEndsWith` returns `false`, and the test output
does not say what the rebuilt text was. The rows that "have not been
run" are the ones most likely to fail. Returning the text on a mismatch
saves a second run:

```
def rebuiltEndsWith(source: string, ending: string): any {
  const command: string = executionCommandIn(source, STDLIB_TESTS)
  const oneCd = command.split("cd '/").length == 2
  if (command.startsWith("cd '/") && oneCd && command.endsWith(ending)) {
    return true
  }
  return command
}
```

The expected output stays `true`.

### 5. Check the first line in `cdOnItsOwnLineRunsInTheNewFolder`

The test checks that the output is not empty. The first line of
`tests/agency/stdlib/grep-fixtures/one.txt` is `hello world`, so the
test can compare against it exactly:

```
return result.value.trim() == "hello world"
```

An empty check passes on any output that has text in it. The exact check
fails if the read happens anywhere but `grep-fixtures`.

## Small points

- The comment above the `noEffects` branch in `planLine` says "a string
  of nothing but echoes." A line that is only `cd x` now reaches that
  branch too. Add it to the comment, so a reader looking for where
  `cd x` turns broad can find it.
- Step 2e gives the expected output `[false,1]` but does not say
  `guardEndsTheScript` needs a `safeBash.test.json` entry. Say so, as
  step 2d does. Its entry needs no `interruptHandlers`, because the
  `with approve` in the node answers the interrupt.
- "How to test" runs `pnpm test:run lib/stdlib/safeBash.test.ts`, but
  the plan changes no TypeScript. The run is cheap and harmless. The
  plan should say it is there as a safety check, so nobody reads it as a
  test of new code.

## What I checked

- The spike's expected values in `safeBash.test.json` match the four
  rows the plan says it reuses. Rows 1, 2, 3 and 5 of the new node are
  the spike's rows 1, 2, 4 and 3, in that order.
- I worked out the rows that have not been run from the code, and they
  match the plan:
  - Row 6, `ls || cat one.txt`, goes through `classifyOr`. Both sides
    are classified in `grep-fixtures`.
  - Row 8, the subshell, goes through `classifyGroup`. That keeps
    `grep-fixtures` for the `ls` after it.
  - Row 9 ends in a trailing `cd ..`, which now gets a guard.
- The six "stays strict" rows all reach `broadPlan`:
  - `cd missing`, `cd -` and `cd $HOME` fail in `cdTarget`.
  - The `&&` row that is not last fails the `index < length - 1` check.
  - `echo hi` reaches `noEffects`.
  - Each broad plan's only effect is `std::bash` with no folder, which
    `cdSummary` prints as `["std::bash",""]`.
- A line that is only `cd x` still reaches `classifyAll`.
  `tryAgencyPlan` and `tryShellFreeStep` have no rule for `cd`, and
  `tryShellFreeChain` needs two links. `classifyAll` then returns no
  effects, so the line is broad.
- `rebuild` joins with `"; "`. The spike's helper shows that `ls` and
  `cat one.txt` render as written, so the endings in step 2a are the
  right strings.
- `bash` returns an `ExecResult` with `stdout` and `exitCode`, and
  `bashImpl` does not throw on a nonzero exit. So `guardEndsTheScript`
  can read `exitCode` as 1. Bash's `cd` error goes to stderr, so
  `stdout` will not hold `ran` by accident.
- `bash` is already imported in `tests/agency/safeBash.agency`, and
  other nodes there call it `with approve`.
- No dev doc or stdlib file links to the heading "`cd` on the left of
  `&&`". The only other mentions are prose in an older spec and the
  `classifyAll` comment that step 1a replaces. Renaming the heading
  breaks nothing.
