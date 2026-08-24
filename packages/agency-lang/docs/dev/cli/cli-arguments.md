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
the program's schema when deciding — position alone decides.

For `agency agent` the boundary falls immediately after the word `agent`:
every following token belongs to the agent program, whose own `parseArgs`
schema is the single source of its flags, help, and errors (budget flags
included — see "The agent" below).

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

The error names the owning command and the fix. The old behavior — the
misleading `Error: Unknown command 'run'`, produced by a hidden fallback
mistaking the word `run` for a filename — is gone.

Two precedence notes:

- Rule 1 beats rule 2: `agency run greet.agency -v` sends `-v` to the program
  even though the root owns it.
- A flag name declared on two commands of one path (a command and its
  ancestor) is a **registration-time error** in the vendored commander fork.
  Commander's stock behavior was parent-wins-silently — the child received
  `undefined` as though the flag were never passed. That trap is now
  impossible to build (see `lib/cli/eval/labelCommand.ts` for the pattern that
  documented it, and the `logs view -f` duplicate the guard caught).

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
`docs/dev/cli/vendored-commander.md`):

- `run` declares `.passThroughOptions()` — its boundary falls after the first
  positional. Ancestors stop consuming options once a line dispatches into a
  boundary command, and inside one, options resolve by ownership (self or
  ancestor).
- `agent` declares `.passThroughOptions({ boundary: "immediate" })` and owns
  zero commander options.
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
program" — provenance the parser records and commander's normal parse would
have discarded.

All four flag spellings warn (`--policy strict`, `--policy=strict`,
`-cfile.json`, `-iv`), and a short token agency does not own (`-print`)
forwards silently — the fork's option consumer reads short groups the way
commander does, stopping at the first unknown letter.

## The agent

The commander `agent` command owns nothing; the agent's `parseArgs` schema
(`lib/agents/agency-agent/lib/args.agency`) is the single source of its flags
and help. A few flags must still take effect **before the child process
exists**, and the launcher (`lib/cli/runBundledAgent.ts`,
`resolveAgentLaunchArgs`) pre-scans the forwarded argv for exactly those:

- `--trace` / `--log` — a trace applied after startup would have a hole over
  the part you most need to see;
- `--max-cost` / `--max-time` — a spend cap set before the process exists is
  structural, not a promise about agent-code discipline. The launcher
  validates the values (`resolveBudget`) and refuses to spawn on garbage;
- `--config` — configuration is consumed by static initialization, and baked
  fields (model, tool limits) never cross the runtime override transport. An
  explicit config therefore triggers an isolated **staged recompile**
  (`lib/cli/stageConfiguredAgent.ts`): the agent source tree is copied to an
  owned temp directory, compiled with that config (`freshness: "always"`, no
  manifest state near the install), spawned from there, and cleaned up on
  child exit — the shipped `agent.js` is never written, so the next
  unconfigured run cannot inherit the config. A forwarded `agent --config`
  beats a root `-c` (the more specific value); a bad explicit config refuses
  to launch rather than silently running unconfigured;
- `--workdir` — the child's working directory, passed as the spawn `cwd`
  (never a parent `chdir`, so the launcher keeps resolving its own files
  where they live). It must exist before the child does: the agent's static
  initializers resolve paths and discover `agency.json` against cwd before
  `main()` could parse a flag. A path that is not a directory refuses to
  launch. The motivating case: an eval harness seeds fixtures into a staged
  workdir, but a command like `pnpm run agency agent` re-anchors cwd to the
  package root, so the agent loses the fixtures — `--workdir` puts it back;
- `--agent-home` — grandfathered: the agent reads it in static initializers.
  A candidate to move into the agent, not a pattern to extend.

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
silently greets the world. That is node's contract, not an agency bug;
Test 8c pins it precisely because it fails quietly.

## Testing

- `lib/vendor/commander/*.test.ts` — the fork's boundary, provenance,
  fallback, ownership, and duplicate-guard behavior in isolation.
- `lib/cli/commandLine.test.ts` — the warning presentation, driven through
  real parses.
- `lib/cli/runBundledAgent.test.ts` — the launcher pre-scan and budget
  validation.
- `tests/integration/cli/test.mjs` Tests 8–8d — the real binary: the position
  rule, the warning spellings, the ownership matrix, typo suggestions, nested
  defaults, and the budget cap reaching the child process.

The integration test needs a packed tarball and therefore a full `make` first:

```bash
make && npm pack && node tests/integration/cli/test.mjs ./agency-lang-*.tgz
```

Use `./node_modules/.bin/agency` in these tests rather than `npx agency`. `npx`
consumes `--` before agency ever sees it.
