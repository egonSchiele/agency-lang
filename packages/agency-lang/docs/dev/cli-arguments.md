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

Commander cannot express the position rule directly, and the way it *looks*
like it can is a trap worth recording.

### What does not work: pass-through mode

`passThroughOptions()` on the `run` command does exactly the right thing — it
treats options after the first positional as plain words. But it requires
`enablePositionalOptions()` on the **root** command, and that setting is not
scoped to `run`. It changes option parsing for the whole CLI:

- `agency run -c custom.json greet.agency` stops working. Root flags would have
  to move before the subcommand (`agency -c custom.json run greet.agency`),
  which is a second boundary nobody asked for and the rule above does not
  describe.
- `agency label ingest --store x` fails with `unknown option '--store'`.
  `--store` is declared on `label` and read by its subcommands, a pattern
  documented in `lib/cli/eval/labelCommand.ts`. Every nested command that reads
  a parent's option breaks the same way.

This was tried and reverted. If you find yourself reaching for
`enablePositionalOptions`, that is why it is not there.

### What is used: draw the boundary before commander runs

`lib/cli/runCommandLine.ts` inserts `--` after the filename, then hands the
rewritten argv to commander, which parses it normally. Commander removes the
separator itself, so the program never sees it.

`agency agent` already worked this way (`injectAgentSeparator` in
`scripts/agency.ts`), so this is the mechanism the CLI already owned rather than
a second one. The difference is only where the boundary falls: for `agent` it is
right after the subcommand, and for `run` it is after the filename.

Finding the filename means walking past agency's flags, which means knowing
which ones take a value — `--policy strict` covers two tokens, `-i` covers one.
That arity comes from commander's own option metadata, read in `runCli`:

```ts
const flags = [...(runCmd?.options ?? []), ...program.options].map((option) => ({
  short: option.short ?? undefined,
  long: option.long ?? undefined,
  takesValue: option.required || option.optional,
}));
```

**Do not replace this with a hand-written list.** A second list would drift the
moment someone adds an option to `addRunOptions`, and it would fail silently in
both directions: the walk would mistake a flag's value for the filename, and the
guard below would forward the new flag to the program where it does nothing.

## The guard

Once the boundary is drawn, anything after it reaches the program. That makes a
misplaced agency flag a silent no-op:

```
agency run f.agency --max-cost 5      # spend cap NOT applied
agency run f.agency -c config.json    # config NOT loaded
```

`--max-cost` and `--max-time` are spend and runtime guards. A guard that stops
guarding because a flag moved four words to the right is worse than the
confusion this change set out to fix, so `insertProgramSeparator` refuses
instead, naming the flag and both fixes.

The check runs only when the user did **not** write `--`. Writing the separator
is how someone says "I meant this one for the program", so a claimed flag passes
through unexamined. This is why the check lives at argv-rewriting time rather
than in the `run` action: by the time commander has parsed, it has removed the
separator and that distinction is gone.

### Four spellings, not one

Commander accepts a flag four ways, and a check that only understands the
plainest one lets the rest through silently:

```
--policy strict     --policy=strict     -c file.json     -cfile.json     -iv
```

The last two are the easy ones to miss. `-cfile.json` attaches the value to the
short flag, and `-iv` is a cluster of two boolean short flags. `flagNamesIn`
handles them by naming every letter of a short token, so any letter matching an
agency flag is caught. `lib/cli/runCommandLine.test.ts` pins all four.

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

## `agency agent`, the same mechanism with a different boundary

`agency agent` forwards its entire remaining command line to an agent program.
`injectAgentSeparator` in `scripts/agency.ts` inserts `--` right after the
subcommand, because `agent` takes no filename and so has no natural boundary
token.

It has its own version of the misplaced-flag problem, solved differently: it
skips past the agent command's budget flags before inserting the separator, so
`agency agent --max-cost 5 -p task` becomes `agency agent --max-cost 5 -- -p
task`. Without that step the cap would silently never apply.

The two run in sequence in `runCli` — `injectAgentSeparator` first, then
`insertProgramSeparator` — and each is a no-op for the other's subcommand. They
share the idea and the user-visible rule but not the code, because the boundary
and the skip logic differ. If a third command ever needs this, that is the point
to factor out the walk rather than add another special case.

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
