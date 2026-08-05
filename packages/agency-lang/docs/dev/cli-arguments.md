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

`--` is never required. It survives only as a way to silence the warning below,
for a program that genuinely owns a flag name agency also uses:

```
agency run greet.agency -- --policy mine
```

Position would have sent `--policy mine` to the program anyway; the separator
just says it was deliberate.

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

`lib/cli/commandLine.ts` inserts `--` after the filename, then hands the
rewritten argv to commander, which parses it normally. Commander removes the
separator itself, so the program never sees it.

`agency agent` already worked this way, so this is the mechanism the CLI already
owned rather than a second one. Both commands now share `splitCommandLine`; see
"One splitter, two policies" below for how they differ.

Finding the filename means walking past agency's flags, which means knowing
which ones take a value — `--policy strict` covers two tokens, `-i` covers one.
That arity comes from commander's own option metadata, read in `runCli`:

```ts
function optionsOf(command: Command | undefined): CliOption[] {
  return (command?.options ?? []).map((option) => ({
    short: option.short ?? undefined,
    long: option.long ?? undefined,
    arity: option.required ? "required" : option.optional ? "optional" : "none",
  }));
}
```

**Do not replace this with a hand-written list.** A second list would drift the
moment someone adds an option to `addRunOptions`, and it would fail silently in
both directions: the walk would mistake a flag's value for the filename, and the
warning below would stay quiet about the new flag.

### The three arities are not interchangeable

`arity` is `"none" | "required" | "optional"`, and the walk has to honour all
three because commander does:

| written              | commander gives            | tokens covered |
| -------------------- | -------------------------- | -------------- |
| `--policy --verbose` | `policy="--verbose"`       | 2, always      |
| `--trace --verbose`  | `trace=true`, verbose set  | 1              |
| `--trace out.tr`     | `trace="out.tr"`           | 2              |
| `--trace -5`         | `trace="-5"`               | 2              |

A required value takes whatever follows, even another flag. An optional value
steps over something that looks like a flag but still takes `-5`, because
commander reads a digit after the dash as a negative number. `looksLikeOption`
copies that test; getting it wrong makes the walk miscount and put the boundary
in the wrong place.

Because an optional value does swallow a plain next word, an optional-valued
option cannot sit before a required positional. That is why `--trace [file]`
became two flags:

```
--trace              write to <input>.trace
--trace-file <path>  write here
```

The old shape had no working spelling under the position rule, and in fact had
none before it either: `agency run --trace foo.agency` failed with "missing
required argument" on main as well, even though `docs/dev/trace.md` documented
it. Only `agency run foo.agency --trace` worked, and the position rule sends
that to the program.

An option that takes `[an optional value]` and sits before a required positional
is ambiguous by construction. Prefer two flags.

## The warning

Once the boundary is drawn, anything after it reaches the program — including a
flag agency also defines. That is the rule working as intended, but it means a
misplaced flag does nothing:

```
agency run f.agency --max-cost 5      # spend NOT capped; the program gets it
agency run f.agency -c config.json    # config NOT loaded; the program gets it
```

Every mainstream interpreter behaves this way and says nothing. `node s.js
--inspect` starts no debugger, `python s.py -v` is not verbose, and
[Deno documents the same trap](https://docs.deno.com/runtime/getting_started/command_line_interface/)
rather than fixing it in code. Cargo has had
[an open issue](https://github.com/rust-lang/cargo/issues/10535) proposing a
warning since 2022 with no implementation.

Agency warns anyway, because its misplaced flags fail differently. In the
precedents above the mistake announces itself: no debugger appears, or Deno's
missing permission kills the script at the first socket. `--max-cost` fails the
other way — the run proceeds uncapped and nothing downstream notices. So
`splitCommandLine` forwards the flag as the rule requires and returns a warning
alongside it.

The warning is suppressed when the user wrote `--`, because that is how someone
says "I meant this one for the program." This is why the check lives at
argv-rewriting time rather than in the `run` action: by the time commander has
parsed, it has removed the separator and that distinction is gone.

### Four spellings, not one

Commander accepts a flag four ways, and a check that only understands the
plainest one stays quiet for the rest:

```
--policy strict     --policy=strict     -c file.json     -cfile.json     -iv
```

The last two are the easy ones to miss. `-cfile.json` attaches the value to the
short flag, and `-iv` is a cluster of two boolean short flags.

`parseShortToken` reads a short token **left to right, stopping early**, the way
commander does. Do not go back to naming every letter:

- an unknown *first* letter means the whole token is the program's, so `-print`
  forwards silently. Naming every letter would find the `i` and warn about
  agency's `-i`;
- an unknown *later* letter is the attached value of the option before it;
- a value-taking option ends the bundle, because the rest of the token is its
  value.

`lib/cli/commandLine.test.ts` pins all four spellings and the `-print` case.

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

## One splitter, two policies

`agency agent` needs the same boundary for a different shape: it takes no
filename, and it forwards its whole command line to an agent that has its own
flag parser. It used to have its own copy of the walk, with a hand-written list
of the flags to keep on agency's side.

Both now go through `splitCommandLine` with a policy each:

```ts
{ command: "run",   ownedPositionals: 1, options: run + root, warnOnCollision: true  }
{ command: "agent", ownedPositionals: 0, options: agent only, warnOnCollision: false }
```

`ownedPositionals` is the difference that matters: `run` owns the filename, so
the line falls after it; `agent` owns nothing, so the line falls at the first
token that is not one of agency's own flags.

Two details of the agent policy are deliberate. Root options are absent, because
`agency agent -c x` has always given `-c x` to the agent. And it never warns,
because forwarding a flag agency also defines is the entire point of the
command, not a mistake.

The walk itself — arity, attached values, short bundles — lives in one place, so
a fix to short-option parsing reaches both.

## The shorthand is `run` with the word left out

`agency greet.agency` is a hidden default command. It carries the same options
as `run` and the same boundary policy, so everything on this page applies to it
unchanged:

```
agency greet.agency --name alice
agency --policy strict greet.agency --name alice
agency greet.agency --max-cost 5     # same warning as run
```

Two things make it different from a named command, and both are in the policy
rather than in the walk.

**It has no command word to step over.** Its `command` is `null`, and the walk
starts on the filename itself rather than one token later.

**Its flags sit at the top level.** In `agency --policy strict greet.agency`,
`--policy` appears where a root flag would. So the scan that locates the
subcommand is given every option agency owns anywhere, not just the root's —
otherwise it stops on `strict` and treats that as the filename.

That second point is why `splitCommandLine` also takes the list of command
names: without it, the shorthand policy would claim real commands, and
`agency compile a.agency b.agency` would get a separator pushed into its file
list. Aliases are included, so `agency fmt x.agency -i` stays a format run.

## Testing

- `lib/cli/commandLine.test.ts` — the splitting and detection logic in
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
