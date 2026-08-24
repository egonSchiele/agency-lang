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
no fighting over the name. `end` deletes the variable again, so a process that
runs the CLI twice over is not silently mute the second time.

There is also an internal guard: `end` and `stopProgress` do nothing unless a
`begin` actually wrote something. Otherwise a skipped `begin` would still pop a
title nobody pushed, clobbering the shell's own title.

## The wiring

`installTerminalStatus(program, status)` is called from `runCli` in
`scripts/agency.ts`. It hooks every program it is handed, but registers its one
process-level `exit` listener only once per process — `runCli` itself is called
repeatedly inside `scripts/agency.test.ts`, and without the latch those
listeners would pile up.

It registers a commander `preAction` hook on the root program. Commander walks
the ancestor chain when it fires hooks (`_chainOrCallHooks` in
`lib/vendor/commander/command.js`), so one hook on the root covers every
subcommand, including the shorthand that falls back to `run`.

The title is `commandTitle(actionCommand)`: the command names from the root
down, plus the command's first operand, so you get `agency eval run fib` and
`agency run investment.agency`. The result is sanitized — control characters
stripped, length capped — since an operand is usually a filename and a filename
can contain anything.

An operand is shortened to its basename only when it *looks like* a path: it
has a separator and no whitespace. Both halves earn their keep. `agency agent`
forwards free-form arguments, so its first operand is normally a prompt, and
`agency agent "fix lib/parsers/foo.ts"` would otherwise be shortened to
`agency agent foo.ts` — the prompt cut at its last slash. Real paths on a
command line rarely contain spaces; prompts nearly always do.

The separator test is `/[/\\]/` rather than `path.sep`, because a
forward-slash path works on Windows too, where `path.sep` is a backslash.
`path.basename` itself is already the per-platform one, so it shortens a
backslash path on Windows and leaves it alone on POSIX, where a backslash is an
ordinary character in a filename.

## Writes must be synchronous

The status writes through `fs.writeSync(1, …)`, not `process.stdout.write`.
`end` runs from an `exit` handler, so the bytes have to land before the process
is gone, and Node's stdout is synchronous to a TTY only on POSIX — on Windows a
TTY write is asynchronous and would simply be dropped, leaving the tab named and
spinning after the command finished. `fs.writeSync` is synchronous on both, and
this seam only writes twice per command, so there is nothing to interleave badly
with the buffered stream.

That swap changes the failure mode, which is why `writeToTerminal` wraps it in a
bare `try`/`catch`. `process.stdout.write` never throws — the stream emits
`error`, and Node's stdout swallows `EPIPE` for you — while `fs.writeSync`
throws synchronously. Picture an `agency eval run` over SSH, or in a window the
user closes while it works: stdout was a TTY at `begin`, so the status is
claimed, but by exit time the pty is gone and fd 1 fails with `EIO` or `EPIPE`
(or `EAGAIN` on a busy non-blocking shared tty). Unguarded, that throw escapes
the `exit` handler and ends a clean run with a stack trace and a changed exit
code, over a tab title.

The empty catch is deliberate, and it is the one place in this file where the
repo's usual "log it" rule does not apply: the failure *is* that the terminal is
unreachable, so there is nowhere to log.

## Signals, and why there are none

Cleanup hangs off `process.on("exit")`, whose handlers must be synchronous —
see the section above on why the write goes through `fs.writeSync`. What the
exit code means is
one predicate, `commandFailed`: zero is success, and so are 130 and 143 — the
shell's "ended by SIGINT/SIGTERM" codes — because Ctrl-C is the normal way out
of `compile --watch` or the log viewer, not a failure. Everything else is red.

There is deliberately **no `SIGINT` handler here**, and adding one later would
be a mistake for two separate reasons.

The first is about Ctrl-C itself. With no JS listener, Node leaves SIGINT at its
default disposition and the kernel ends the process at once. The moment any
listener exists, libuv defers the signal to the event loop, so the handler
cannot run until the current synchronous block finishes. `agency compile` on a
big file is largely synchronous, and parsing is the known front-end bottleneck —
a listener would turn its instant Ctrl-C into one that waits for the parse to
finish. The same goes for `ast`, `typecheck` and `fmt`. That is a real
regression in a core behavior, traded for a cosmetic one.

The second is about what a signal means. A signal is not a verdict. The eval
runner (`lib/eval/run/runSuite.ts`) treats the first Ctrl-C as non-fatal: it
folds the in-flight test into the run directory and keeps going, possibly for
minutes. A handler here would fire first and report that run as failed while it
was still working, then leave `claimed` false so nothing could put the spinner
back. Only `exit` knows how the command actually ended.

The cost is that a hard Ctrl-C on a command that installs no signal handler of
its own kills the process before any cleanup runs, and the two halves are not
stranded equally.

The **spinner** clears itself the next time any Agency command runs in that tab.
The **title** does not. `begin` pushes onto the terminal's title stack and only
`end` pops, so the tab keeps the dead command's name once you are back at the
shell prompt, and each interrupted command leaves one more unbalanced entry on
that stack. Terminals cap the stack's depth, so this accumulates to a limit
rather than without bound, but it accumulates. Ctrl-C on a slow `compile` is
both the case the no-signal-handler decision protects and the case that strands
a title.

The push/pop pair stays anyway. Dropping it, and simply setting the title at
`begin` without restoring anything, would trade a rare stranded title for a
permanent one on every command — restoring the previous title is the entire
reason the stack exists.

The commands most likely to be interrupted — the eval runner, `compile --watch`,
the log viewer — all handle their own signal and leave through `process.exit`,
which does run the exit handler, so none of them strand anything.

## Interactive commands keep spinning

`agency agent` and `agency logs` hold the terminal for a whole session, and
neither gets a special case: an open viewer or a live agent session is a command
in progress, and the spinner says so.

For the agent this is a deliberate call rather than an oversight. A spinner is
arguably right while the agent is thinking and wrong while it waits on you, but
the work happens in a spawned child, so the parent cannot tell those apart
without new plumbing between them. An indicator that is sometimes early is worth
more than that machinery, and the session's end clears it either way.

## Known behavior: a failed command leaves the tab red

`end(false)` sets the error state and does not clear it, so a long `eval` that
fails while you are in another tab is still visibly failed when you come back.
Nothing clears that automatically — the next Agency command will, or you can do
it by hand:

```bash
printf '\e]9;4;0;0\e\\'
```
