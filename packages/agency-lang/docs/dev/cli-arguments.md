# Command line arguments

## The problem

One command line has to carry two sets of arguments. Some belong to `agency`
itself, and some belong to the Agency program being run:

```
agency run --policy strict greet.agency --name alice
```

`--policy strict` configures the run. `--name alice` is something `greet.agency`
wants to read with `parseArgs` from `std::args`. Nothing about the text says
which is which, so the CLI needs a rule.

## The rule: position decides

Agency's flags go **before** the filename. Everything after the filename belongs
to the program.

```
agency run --policy strict greet.agency --name alice
             agency's                     program's
```

This is the same rule `node` uses. In `node --inspect script.js --verbose`, the
`--inspect` configures node and the `--verbose` is passed to the script. `docker
run` and `ssh` work this way too, so most people already have the habit.

`--` still works for anyone who types it, and it is the escape hatch for the one
case position cannot resolve: a program that wants a flag agency also defines.

```
agency run greet.agency -- --policy mine
```

That hands `--policy mine` to the program instead of to agency.

## How this is set up

Two calls in `scripts/agency.ts`:

- `program.enablePositionalOptions()` — agency's top-level flags (`-v`, `-c`)
  must appear before the subcommand name.
- `.passThroughOptions()` on the `run` command — options that appear after the
  first positional argument (the filename) are treated as plain words and
  handed to the action instead of being parsed.

Three consequences are worth knowing, because none of them are obvious and all
three were found by probing commander rather than by reading its documentation.

### Commander stops removing the `--`

Normally commander consumes the separator. With pass-through it does not: the
action receives `["--", "--name", "alice"]`. If that literal `--` reached the
program, `std::args` would read it as "stop parsing flags", `--name` would
become a positional argument, and `name` would quietly fall back to its default.
The program would print `Hello, world!` and look like it worked.

So `resolveForwardedArgs` in `lib/cli/forwardedArgs.ts` removes exactly one
separator. A second `--` is left alone, since that one is the program's.

### Top-level flags must come before the subcommand

`agency run f.agency -c config.json` used to load `config.json`. It now forwards
`-c config.json` to the program, and agency reads the default config. Write
`agency -c config.json run f.agency` instead.

The codebase already assumed this ordering before the change — see
`findSubcommandIndex` in `scripts/agency.ts`, which walks past leading `-v` and
`-c` to locate the subcommand — so the change made the parser agree with an
assumption the surrounding code was already making.

### Unknown flags after the filename are no longer errors

This is the dangerous one, and it is why the guard exists.

Pass-through means commander no longer complains about a flag it does not
recognize after the filename. It forwards it. So a misplaced agency flag becomes
a silent no-op:

```
agency run f.agency --max-cost 5      # spend cap NOT applied, flag forwarded
```

`--max-cost` and `--max-time` are spend and runtime guards. A guard that stops
guarding because a flag moved four words to the right is worse than the
confusion the change set out to fix.

## The guard

`lib/cli/forwardedArgs.ts` holds both halves of the answer, because they are the
same question asked once: given the words after the filename, which ones does
the program get, and did any of them obviously belong to agency?

```ts
resolveForwardedArgs(nodeArgs, agencyFlags) -> { args, misplaced? }
```

Words before a `--` are checked against agency's own flag names. Words after a
`--` are not, because writing the separator is how a user says "I meant this one
for the program."

The flag names are read off the commander options at call time:

```ts
const agencyFlags = [...runCmd.options, ...program.options].flatMap(
  (option) => [option.short, option.long].filter((f) => f !== undefined),
);
```

**Do not replace this with a hand-written list.** A second list of flag names
would drift the moment someone adds an option to `addRunOptions`, and the way it
would fail is silent: the new flag would be forwarded to the program and quietly
do nothing.

`--max-cost=5` and `--max-cost 5` name the same flag, so the check compares the
part before any `=`.

## The `--` asymmetry, which still exists

The change removes the need for `--` with `agency run`. It does not change what
`--` means once the program is compiled, and the two are still not the same:

```
agency run greet.agency --name alice      # works
agency run greet.agency -- --name alice   # works, separator stripped
node greet.js --name alice                # works
node greet.js -- --name alice             # SILENTLY prints "Hello, world!"
```

The last line is not a bug in agency. `node` passes everything after the script
path through untouched, so the program really does receive a literal `--`, and
`std::args` really does treat that as end-of-flags. There is no layer between
`node` and the program where agency could strip it.

`tests/integration/cli/test.mjs` Test 8c pins this behavior precisely because it
fails quietly. If you are tempted to make `std::args` ignore a leading `--`, note
that doing so would break any program that legitimately wants positional
arguments beginning with a dash, which is the reason POSIX has the convention at
all.

## `agency agent` solves the same problem a different way

`agency agent` forwards its entire remaining command line to an agent program.
It does not use pass-through. Instead `injectAgentSeparator` in
`scripts/agency.ts` rewrites argv before commander sees it, inserting a `--`
after the subcommand.

It also has to skip past the agent command's own budget flags before inserting
the separator, so `agency agent --max-cost 5 -p task` becomes `agency agent
--max-cost 5 -- -p task`. Without that step the budget flags would be forwarded
and the cap would silently never apply — the same failure the `run` guard
prevents, solved by a different mechanism.

**These are two mechanisms for one problem.** They agree on the user-visible
rule (agency's flags first, the program's after), so nothing is broken, but if
you are touching either one, consider whether `agent` could move to pass-through
plus the shared guard and let `injectAgentSeparator` be deleted. The blocker is
that `agent` has no filename argument to act as the boundary, so "after the
first positional" does not mean anything there.

## Known limitation: the shorthand takes no program arguments

`agency greet.agency` is a shorthand for `agency run greet.agency`. It is a
hidden default command declaring only `[file]`, with no variadic argument, so it
cannot forward anything:

```
agency greet.agency --name bob      # error: unknown option '--name'
agency greet.agency bob             # error: too many arguments for 'default'
```

This predates the position rule and was not changed by it. Anyone who needs to
pass arguments must write `agency run` in full. Fixing it means giving the
default command the same `[nodeArgs...]` argument, pass-through, and guard that
`run` has.

## Testing

- `lib/cli/forwardedArgs.test.ts` — the splitting and detection logic in
  isolation. Fast, and the right place for a new edge case.
- `tests/integration/cli/test.mjs` Test 8 — the real binary, covering the new
  form, the separator form, an agency flag before the filename, a misplaced one,
  and one claimed with `--`.

That last case asserts on the *program's* "unknown flag" error rather than on a
success message. That is deliberate: `greet` does not declare `--max-cost`, so
its own parser rejecting the flag is proof the flag reached it instead of being
caught by the guard. An assertion that merely checked the guard stayed quiet
would also pass if the flag vanished entirely.

The integration test needs a packed tarball and therefore a full `make` first:

```bash
make && npm pack && node tests/integration/cli/test.mjs ./agency-lang-*.tgz
```

Use `./node_modules/.bin/agency` in these tests rather than `npx agency`. `npx`
consumes `--` before agency ever sees it.
