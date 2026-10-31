# Review: safeBash filter stages (a `grep` at the end of a pipe)

Date: 2026-10-31.

Plan: `docs/superpowers/plans/2026-10-31-safebash-filter-stages.md`

I checked the plan against the code on `adit/safebash-grep`. Paths are relative to `packages/agency-lang`. The plan is small and its main rule is right. A `-r` check comes first, because grep with `-r` and no path reads the working directory even when a pipe feeds it. That was the payload lie in round 1 of the grep plan's review, and this plan closes it. The stage flags in Task 1's test are correct for every shape listed, including a group as the first stage and a group as a later stage.

There are two fixes, one note that comes from the grep plan's review, and two small additions.

## Must fix

### 1. `GrepCall.target` cannot express "no path"

In the grep plan, `readGrep` always resolves a path and returns `target: SearchTarget`, which is never null. With no path and no `-r`, it fails. This plan says a filter stage "returns from `grepEffects` with no effect before the directory check". But `readGrep` is where the missing path is decided, and its return type has no slot for "this stage reads stdin and names no file".

Choose one shape and write it into Task 2's Interfaces:

- `GrepCall.target: SearchTarget | null`, where null means "reads stdin". `grepEffects` returns `success([])` on null. `tryShellFreeGrep` treats null as a failure, which cannot happen anyway, because it passes `readsStdin: false`.
- Or `readGrep` takes `readsStdin` and returns a small result type, `{ kind: "filter" } | { kind: "search"; call: GrepCall }`.

The first is the smaller change. Either one stops the executor from guessing at a type the grep plan fixed.

### 2. The background describes the first stage's stdin wrongly

The plan says a first-position `grep fix` reads "whatever safeBash's shell was started with, which holds nothing useful". The real situation: safeBash calls `_bash(command, cwd, 0, "", {})`. An empty `stdin` leaves `input` unset (`lib/stdlib/shell.ts`, `buildSpawnOptions`), and the child's stdin pipe is closed at once (`lib/host/node/nodeSubprocess.ts:134-137`). So a first-position grep with no path reads an empty stream, and it reads no file either.

Keeping that case unrecognized is fine. A lone `grep fix` does nothing useful, and an `&&` chain with one is rare. But the sentence should say what is true, because the next slice will reason from it. Suggested wording: "As the first command, its stdin is empty, because safeBash closes the shell's stdin. It reads no file, but the line does nothing useful, so it stays unrecognized."

## Note from the grep plan's review

Finding 1 in the grep plan's round 2 review makes a flag after the first positional word unrecognized on the bash path. BSD grep, and GNU grep with `POSIXLY_CORRECT` set, read every word after the first operand as a file name. In a filter stage the first positional is the pattern. So `git log | grep fix -i` would read a file named `-i` on BSD grep, and it should stay broad. If the owner accepts that finding, add this row to `grepFilterStages`:

```
grepNames("git status | grep hello -i")
```

It expects `[["std::bash"],{"kind":"unrecognized","detail":<the grep plan's message>}]`.

## Small additions

- **A test row for `-e` in a filter stage.** `git status | grep -e hello` has no positional at all, so `readGrep` takes the `e` branch with zero paths. Add it to `grepFilterStages`, expecting `[["std::git::status"],null]`. That pins the second route into the filter rule.
- **Say which grep the stdin claim was checked against.** "A `grep` with no path in a later stage reads only its stdin" holds for GNU grep, BSD grep, and ugrep when stdin is a pipe. ugrep switches to a recursive search only when stdin is a terminal. One sentence in the dev doc's "Stages that read a pipe" section saves the next reader from re-checking it.

## Checked and correct

- **Stage flags.** `a | b && c` parses as `(a | b) && c`, so `c` reads the shell's stdin. In `a | (b && c)` both `b` and `c` read the pipe, because the group's stdin is the pipe and `c` reads what `b` left. In `(a | b) | c`, `a` reads the shell's stdin. All six expected rows in Task 1 match.
- **Callers.** `flattenCommands` and `flattenOne` have no callers outside `stdlib/safeBash.agency`, which uses them at line 790. `effectsFor` has one test caller (`tests/agency/safeBash.agency:55`), which the plan updates. The six `verbNames` call sites the plan lists are at the lines it gives.
- **Unchanged rules.** A filter stage still goes through `splitFlags`, so `-R`, `-f`, and `--filter` stay unrecognized. Its redirect still adds `std::write` (row 5). A stage of nothing but filters still hits the `noEffects` audit rule (row 8), which `planFor` enforces at `stdlib/safeBash.agency:820-825`.
