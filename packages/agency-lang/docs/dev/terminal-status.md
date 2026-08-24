# The terminal tab status

Every Agency CLI command names the terminal tab it runs in and drives that
tab's progress indicator. Without it, iTerm2 and most other terminals name a
tab after its foreground job, so every command shows up as `node`, and a tab
you are not looking at gets the ordinary "there is unread output here" dot
rather than anything that says work is still going.

The whole feature lives in `lib/cli/terminalStatus.ts`. It is the only file in
the repo that knows these escape sequences.

## The sequences

Two unrelated families do the work.

**The title.** `ESC ] 1 ; <text> BEL` sets the tab (or icon) title. Its
siblings are `ESC ] 2` for the window title and `ESC ] 0` for both; we want
just the tab. To avoid leaving the tab renamed after the command exits, the
title goes on the terminal's title stack first — `ESC [ 22 ; 0 t` pushes the
current title, `ESC [ 23 ; 0 t` pops it back.

**The indicator.** `ESC ] 9 ; 4 ; <state> ; <percent> ST` is ConEmu's progress
protocol, which iTerm2, WezTerm, Ghostty and Windows Terminal all draw in the
tab. We use three of its states: `3` means "working, no percentage known" and
shows as a spinner, `0` clears it, and `2` is the error state and shows as red.
State `1` would be a real percentage, which no Agency command can report yet.

Terminals that do not understand a sequence ignore it, so there is nothing to
detect: we either write to a TTY or we write nothing at all.

## When it stays quiet

`createTerminalStatus` writes nothing unless all of these hold:

- stdout is a TTY,
- `NO_COLOR` is unset or empty — someone who wants plain bytes wants this off,
- `AGENCY_NO_TERM_STATUS` is unset or empty, which is the dedicated opt-out,
- `AGENCY_TERM_STATUS_OWNED` is unset.

That last one is how nesting is handled. The first `agency` process to name the
tab sets `AGENCY_TERM_STATUS_OWNED=1` on its own `process.env`, which every
child inherits. So when `eval run --agent-cmd` spawns Agency processes, or an
agent spawns a subprocess, only the outermost one writes — one tab, one owner,
no fighting over the name.

There is also an internal guard: `end` and `stopProgress` do nothing unless a
`begin` actually wrote something. Otherwise a skipped `begin` would still pop a
title nobody pushed, clobbering the shell's own title.

## The wiring

`installTerminalStatus(program, status)` is called from `runCli` in
`scripts/agency.ts` — not from `createProgram`, because tests construct
programs many times over and the process-level listeners must not pile up.

It registers a commander `preAction` hook on the root program. Commander walks
the ancestor chain when it fires hooks (`_chainOrCallHooks` in
`lib/vendor/commander/command.js`), so one hook on the root covers every
subcommand, including the shorthand that falls back to `run`.

The title is `commandTitle(actionCommand)`: the command names from the root
down, plus the command's first operand, so you get `agency eval run fib` and
`agency run investment.agency`. A path operand is shortened to its basename,
because a tab has room for a filename but not a directory tree. The result is
sanitized — control characters stripped, length capped — since an operand is
usually a filename and a filename can contain anything.

## Signals, and why we do not exit

Cleanup runs from `process.on("exit")`, whose handlers must be synchronous;
`process.stdout.write` to a TTY is, so that holds.

The `SIGINT` and `SIGTERM` handlers deliberately do **not** call
`process.exit`. Other parts of the CLI install their own signal handling for
graceful shutdown — the eval runner (`lib/eval/run/runSuite.ts`), the logs
viewer (`lib/cli/logsView.ts`) — and since our listener is registered first, it
would preempt them. Instead each handler cleans up, removes itself, and
re-raises the signal only when no other listener remains. If someone else is
handling the signal, we have stepped out of their way; if nobody is, removing
ourselves restores Node's default termination, so Ctrl-C still works.

## The logs viewer

`agency logs` takes over the whole screen and then sits waiting for keys, which
is not "busy". It calls `terminalStatus.stopProgress()` before starting, which
drops the spinner but keeps the tab's name.

## Known behavior: a failed command leaves the tab red

`end(false)` sets the error state and does not clear it, so a long `eval` that
fails while you are in another tab is still visibly failed when you come back.
Nothing clears that automatically — the next Agency command will, or you can do
it by hand:

```bash
printf '\e]9;4;0;0\e\\'
```
