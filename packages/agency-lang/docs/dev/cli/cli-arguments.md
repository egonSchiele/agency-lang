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

## Rule 1: position decides agency vs. program

Agency's flags go **before** the filename. Everything after the filename
belongs to the program, unconditionally, no matter what the flag is named:

```
agency run --policy strict greet.agency --name alice
             agency's                     program's
```

This is the same rule `node` uses. In `node --inspect script.js --verbose`, the
`--inspect` configures node and the `--verbose` is passed to the script.

Routing never depends on what the program declares. A program adding a flag
named `max-cost` must never silently uncap a run, so agency does not look at
the program's schema when deciding. Position alone decides.

For `agency agent` the boundary falls immediately after the word `agent`.
Every following token belongs to the agent program. The agent's own
`parseArgs` schema is the single source of its flags, its help, and its
errors, budget flags included. See "The agent" below.

`--` is never required. A separator after the filename says "I meant the rest
for the program" and silences the warning below. A separator *before* the
filename ends agency's option parsing, but the next token is still the run
input: `agency run -- greet.agency --name alice` runs greet with
`--name alice`.

## Rule 2: within agency's territory, a flag is valid after its owner

**A flag may be written anywhere after the command that owns it — directly or
as an ancestor — and never before it.** Agency errors on flags no command on
the line owns.

```
agency run --max-cost 5 greet.agency    # OK: run owns --max-cost
agency run -c cfg.json greet.agency     # OK: the root owns -c, and -c is after "agency"
agency -c cfg.json run greet.agency     # OK: same reason
agency --max-cost 5 run greet.agency    # ERROR: --max-cost's owner (run) comes after it
                                        #   "--max-cost belongs to 'agency run'; write it after 'run'"
agency --nonsense greet.agency          # ERROR: unknown option (with suggestions)
```

The error names the owning command and the fix. The old behavior is gone: a
hidden fallback used to mistake the word `run` for a filename and report the
misleading `Error: Unknown command 'run'`.

Two precedence notes:

- Rule 1 beats rule 2: `agency run greet.agency -v` sends `-v` to the program
  even though the root owns it.
- A flag name declared on two commands of one path (a command and its
  ancestor) is a **registration-time error** in the vendored commander fork.
  Commander's stock behavior was parent-wins-silently, so the child received
  `undefined` as though the flag were never passed. That trap is now
  impossible to build (see `lib/cli/eval/labelCommand.ts` for the pattern that
  documented it, and the `logs view -f` duplicate the guard caught).
  See `lib/vendor/commander/duplicateNames.test.ts`.

## The shorthand IS run

`agency greet.agency` dispatches the real `run` command object via the fork's
`fallbackCommand("run")` — same options, same action, same help. There is no
second declaration to keep in sync. Run's action can tell the two spellings
apart (`command.invokedAsFallback()`), which is how `agency formt` reports
"unknown command 'formt' — did you mean format?" while `agency run formt`
only ever reports a missing file.

The same "invisible command" rule covers every `isDefault` command:
`agency remote projects --host …` answers with the default `list` child's
flags, and `trace`/`test` default to their `run` subcommands.

## How this is set up

There is no argv rewriting. The boundary and the ownership rule live inside
the vendored commander fork (`lib/vendor/commander/`, see
[`vendored-commander.md`](./vendored-commander.md)). The commands declare the
behavior in `scripts/agency.ts`:

- `run` declares `.passThroughOptions()` — its boundary falls after the first
  positional. Ancestors stop consuming options once a line dispatches into a
  boundary command, and inside one, options resolve by ownership (self or
  ancestor).
- `agent` declares `.passThroughOptions({ boundary: "immediate" })` and owns
  zero commander options. It also sets `.helpOption(false)`, so `--help`
  reaches the agent instead of commander.
- `program.fallbackCommand("run")` replaces the old hidden default command.
- The parser records `boundaryInfo()` on the boundary command: the original
  program tail, whether an explicit `--` drew the line, and the first
  agency-owned flag spelling in the tail. `lib/cli/commandLine.ts` is now
  presentation-only: it renders that record as the warning.

## The warning

Once the boundary is drawn, anything after it reaches the program — including
a flag agency also defines. That is rule 1 working as intended, but it means a
misplaced flag does nothing:

```
agency run f.agency --max-cost 5      # spend NOT capped; the program gets it
```

Every mainstream interpreter behaves this way and says nothing (`node s.js
--inspect` starts no debugger; `python s.py -v` is not verbose). Agency warns
anyway, because `--max-cost` fails the dangerous way: the run proceeds
uncapped and nothing downstream notices. The warning is suppressed when the
user wrote `--`, because that is how someone says "I meant this one for the
program". The parser records that provenance, which commander's normal parse
would have discarded.

All four flag spellings warn (`--policy strict`, `--policy=strict`,
`-cfile.json`, `-iv`), and a short token agency does not own (`-print`)
forwards silently. The fork's option consumer reads short groups the way
commander does, stopping at the first unknown letter.

## The agent

The commander `agent` command owns nothing; the agent's `parseArgs` schema
(`lib/agents/agency-agent/lib/args.agency`) is the single source of its flags
and help. A few flags must still take effect **before the child process
exists**, and the launcher (`lib/cli/runBundledAgent.ts`,
`resolveAgentLaunchArgs`) pre-scans the forwarded argv for exactly those:

- `--trace` / `--log`. A trace applied after startup would have a hole over
  the part you most need to see.
- `--max-cost` / `--max-time`. A spend cap set before the process exists is
  structural, not a promise about agent-code discipline. `resolveBudget`
  validates the values and the launcher refuses to spawn on garbage.
- `--config`. Static initialization consumes the configuration, and baked
  fields such as the model and the tool limits never cross the runtime
  override transport. An explicit config therefore triggers an isolated
  **staged recompile** in `lib/cli/stageConfiguredAgent.ts`. The launcher
  copies the agent source tree to an owned temp directory, compiles it with
  that config, spawns the child from there, and cleans up on child exit. The
  shipped `agent.js` is never written, so the next unconfigured run cannot
  inherit the config. A forwarded `agent --config` beats a root `-c`, because
  it is the more specific value. A bad explicit config refuses to launch
  rather than silently running unconfigured.
- `--workdir`. This is the child's working directory, passed as the spawn
  `cwd`. The launcher never calls `chdir` itself, so it keeps resolving its
  own files where they live. The directory must exist before the child does,
  because the agent's static initializers resolve paths and discover
  `agency.json` against cwd before `main()` could parse a flag. A path that is
  not a directory refuses to launch. The motivating case is an eval harness
  that seeds fixtures into a staged workdir. A command like
  `pnpm run agency agent` re-anchors cwd to the package root, so the agent
  loses the fixtures, and `--workdir` puts it back.
- `--agent-home`. This one is grandfathered, because the agent reads it in
  static initializers. It is a candidate to move into the agent, not a
  pattern to extend.

The pre-scan is one raw-token walk over one policy table. A required value is
never a following flag (`--max-time --help` leaves the value missing for the
agent's parser to report), but budget values may be negative numbers. The
child always receives the original argv unchanged; each pre-scanned flag is
also declared in the agent's schema so `agency agent --help` shows it and the
agent's parser accepts it.

## The `--` asymmetry, which still exists

`agency run greet.agency -- --name alice` strips the separator before the
program sees it. `node greet.js -- --name alice` does not — node passes
everything through, `std::args` reads `--` as end-of-flags, and the program
silently greets the world. That is node's contract, not an agency bug. Test
8c pins it precisely because it fails quietly.

## Testing

- `lib/vendor/commander/*.test.ts` — the fork's boundary, provenance,
  fallback, ownership, and duplicate-guard behavior in isolation.
- `lib/cli/commandLine.test.ts` — the warning presentation, driven through
  real parses.
- `lib/cli/runBundledAgent.test.ts` — the launcher pre-scan and budget
  validation.
- `tests/integration/cli/test.mjs` Tests 8–8e — the real binary. Test 8 covers
  the position rule and the warning spellings. Test 8c pins the `--`
  asymmetry. Test 8d is the ownership matrix, typo suggestions, and nested
  defaults. Test 8e covers the agent's full flag delegation and the staged
  recompile for an explicit `--config`.

The integration test needs a packed tarball and therefore a full `make` first:

```bash
make && npm pack && node tests/integration/cli/test.mjs ./agency-lang-*.tgz
```

Use `./node_modules/.bin/agency` in these tests rather than `npx agency`. `npx`
consumes `--` before agency ever sees it.
