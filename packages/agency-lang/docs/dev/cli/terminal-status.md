# The terminal tab status

Terminals name a tab after its foreground job, so every Agency command showed up
as `node`. Each command now names its own tab and drives the tab's progress
indicator: a spinner while it runs, cleared on success, red on failure.

`lib/cli/terminalStatus.ts` is the only file that knows the escape sequences.
`runCli` hooks it onto the program with a commander `preAction` hook, which
covers every subcommand because commander walks the ancestor chain.

## The sequences

`ESC ] 1 ; <text> BEL` sets the tab title. `begin` first pushes the old title
onto the terminal's title stack with `CSI 22 t`, and `end` pops it back with
`CSI 23 t`.

`ESC ] 9 ; 4 ; <state> ; <percent> ST` is ConEmu's progress protocol, which
iTerm2, WezTerm, Ghostty and Windows Terminal all draw in the tab. State 3 is a
spinner, 0 clears it, and 2 is red. Terminals that do not understand a sequence
ignore it, so there is nothing to detect.

## When it stays quiet

Nothing is written unless stdout is a TTY and neither `NO_COLOR` nor
`AGENCY_NO_TERM_STATUS` is set. This is deliberately not `autoUseColor()`, whose
`FORCE_COLOR` branch enables output on a non-TTY. That is right for color in a
captured log and wrong here, because a pipe has no tab.

Nesting is handled with `AGENCY_TERM_STATUS_OWNED`. The first process to name
the tab sets it on its own `process.env`, and children inherit it and stay
silent. So `eval run --agent-cmd` and spawned agents leave the tab to whoever
owns it. `end` deletes the variable again.

## Writes go through `fs.writeSync`

`end` runs from an `exit` handler, so its bytes must land before the process is
gone. Node's stdout is synchronous to a TTY on POSIX but asynchronous on
Windows, where the write would be dropped.

`fs.writeSync` throws where `process.stdout.write` swallows, so
`writeToTerminal` catches and does nothing. Close the window during an
`agency eval run` and fd 1 starts failing with `EIO`; unguarded, that throw
escapes the `exit` handler and ends a clean run with a stack trace. The empty
catch is the one place here that earns an exception to the repo's log-in-catch
rule, because the failure is that the terminal is unreachable.

## There is no signal handler

Cleanup hangs off `exit` alone. Registering any JS `SIGINT` listener takes the
signal off its default disposition and defers it to the event loop, so
`agency compile` on a big file would stop dying on the first Ctrl-C. Parsing is
synchronous and is the front-end bottleneck, so that is the case where an
instant Ctrl-C matters most.

A signal is not a verdict either. The eval runner treats the first Ctrl-C as
non-fatal and keeps working for minutes afterwards. A handler here would have
reported that run as failed while it was still going. Only `exit` knows how a
command ended, so `commandFailed` reads the exit code, treating 130 and 143 as
normal ways to stop.

The cost lands on a hard Ctrl-C, which kills the process before any cleanup
runs. The spinner clears on the next Agency command in that tab. The title does
not, because only `end` pops the stack, so the tab keeps the dead command's name
and gains an unbalanced stack entry. Keeping the pair is still better than
dropping it, which would leave every command's name behind permanently.

## Two small rules

An operand is shortened to its basename only when it looks like a path, meaning
it has a separator and no whitespace. `agency agent` forwards a free-form
prompt, and `agency agent "fix lib/parsers/foo.ts"` would otherwise be shortened
to `agency agent foo.ts`.

Interactive commands keep spinning. Neither `agency agent` nor `agency logs`
gets a special case, because the agent's work happens in a spawned child and the
parent cannot tell thinking from waiting.
