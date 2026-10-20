# Attaching the debugger to a running program

Linear: ADI-10, in the project "Attach to a running Agency program".

## The problem

Today the debugger can only see a program it started. `agency debug` loads
the compiled module, installs a `DebuggerState` on its runtime context
through the module's `__setDebugger` export, and runs the node with the
terminal UI in the same process. A program started with `agency run` has
no debugger, and there is no way to add one later.

That is the wrong shape for the runs people want to look at. An agent run
that goes wrong does so forty minutes in, after a hundred tool calls, in a
terminal nobody was planning to debug. By the time it looks stuck, the only
tools are the log and Ctrl-C. The goal of this spec is:

```
$ agency debug --attach 48213
```

opens the full debugger, every pane it has today, on a run that was started
with a plain `agency run`, with no flag given in advance and no id printed
by every run.

## What the runtime already does

Three facts make attach cheap. They are stated here because the design
below depends on all three and adds nothing to them.

**A normal run pays nothing for debuggability.** Every compiled statement
calls `debugStep`, since `instrument` defaults to true. The runner's
`recordsStepCheckpoints()` decides whether that call builds a checkpoint,
and it says yes only when a debugger is installed, a trace writer is
attached, or something registered for `onCheckpoint`. A plain run has none
of those, so each statement pays one function call that returns at once.
The expensive part of debugging, the deep copy of the stack and the stores
at every statement, starts when a debugger is installed and stops when it
is removed. Trace mode (`--trace`) is a separate consumer of the same gate
and is not needed for attach.

**A debugger can be installed while the program runs, with one change.**
`__setDebugger` sets `debuggerState` on the module's global context, and
the in-process TUI calls it before the node starts. Today that order is
required: a run copies the field into its own execution context when a
leg starts, and every resume starts a new leg with a new copy, so a state
installed later reaches nothing. The change is small: the context keeps
the state in a holder object that every execution context of the module
shares by reference, so an install or a detach is seen at the next
`debugStep` of every live and future leg.

**The debugger is already split in two.** `DebuggerDriver` owns the logic:
the checkpoint window, the stepping depth, batch answers, resume, rewind.
It touches the terminal only through the `DebuggerIO` type, and the
headless tests already swap in a scripted `DebuggerIO`. So the question
"how does a debugger in another process drive this run" has one answer:
give the driver a `DebuggerIO` whose every method is a message over a
channel.

## The design in one paragraph

The run registers a trigger that means "someone wants to attach". On
Node the trigger is `SIGUSR2`, in the spirit of the `SIGUSR1` that makes
a Node process open its inspector; `SIGUSR1` itself is reserved by Node
for that inspector, whose port any local user can reach, so Agency does
not touch it. When the trigger fires, the runtime opens a Unix socket in
a per-user directory named after the process id, installs a
`DebuggerDriver` in the running process, and gives it a `DebuggerIO` that
forwards each call over the socket. `agency debug --attach <pid>` sends
the signal, connects, and runs the existing terminal UI as the other end
of that channel. The panes, commands, rewind, and interrupt answering are
the code that exists; the new code is the trigger, the socket, and the
message per `DebuggerIO` method. Detaching removes the driver, and the
run goes back to paying nothing.

## The user's view

### Attaching

```
$ agency run agent.agency        # in one terminal, no flags
$ agency debug --attach 48213    # in another
```

The debugger opens stopped at the run's next step, wherever it is,
inside a tool call included, and from there `step`, `next`, `step in`,
`step out`, `continue`, `rewind`, and the inspection commands mean what
they mean today. The status line says `attached to 48213 agent.agency`.
The checkpoint window starts filling at the moment of attach, so rewind
reaches back as far as the attach and no further; the status line says
so while the window is shorter than the configured size.

`continue` lets the program run until its next `debugger()` statement, a
question, or the end. While it runs the debugger waits and reads no keys;
to stop it, use the program's own terminal. A watch mode, where the panes
follow a running program and a key stops it, is a later version: it
needs a throttled feed of checkpoints to the debugger and a key loop
while no command is pending, and the first version does without both.

One cost of the signal: `nodemon` restarts a child with `SIGUSR2`, so a
program run under `nodemon` would open its debug socket instead of
restarting. The docs say so.

### Finding the pid

`agency debug --attach` with no argument lists the attachable runs:

```
  PID    PROGRAM          NODE   STARTED
  48213  agent.agency     main   4m12s ago
  51002  research.agency  main   38s ago
```

Each run writes a small record at startup, `<pid>.json` in the sessions
directory, `~/.agency/debug-sessions/`, and removes it on exit. That is
Agency's own per-user directory, the one `std::oauth` already uses, and
not the agent home: `~/.agency-agent` belongs to the built-in `agency
agent`, and attach is for any program. The debugger can be started from
any directory. The listing reads the records, drops
the ones whose process is gone (`processState` from `runDirectory/lock.ts`
already answers that), and prints the rest. The record holds the pid, the
program path, the node name, and the process start time, nothing else.
The start time is a guard: a run that crashes leaves its record behind,
and the operating system may later give that pid to an unrelated process,
which `SIGUSR2` would kill. Before signalling, the debugger reads the live
process's start time and refuses, removing the stale record, when it does
not match. A run that
exits by signal leaves a stale record; the next listing removes it, the
way the logs viewer's registry does.

### Detaching

`q` in the debugger detaches: the UI closes, the socket closes, the run
removes its `DebuggerState` and continues. If the debugger was stopped at a
step when the user quits, detaching first answers that stop with
`continue`, so the run is never left frozen by a debugger that is gone.
The same happens when the socket drops for any other reason: the debugger
process was killed, or its terminal closed. A run must never wait on a
debugger that is not there.

Ctrl-C in the debugger is detach, not kill. Killing the run is the run's
terminal's job, where Ctrl-C keeps meaning what it means today.

### Interrupts

A run keeps its own interrupt rule while attached. Whatever `agency run`
was told, a policy file, `--approve` and `--reject` flags, `--interactive`,
or nothing, still answers the program's interrupts, and an interrupt that
goes to a person goes to the run's terminal as before. The debugger sees
the interrupt's checkpoint pass through its window and shows it in the
panes, the same as any other checkpoint, but does not answer it.

This is the simplest rule and it is deliberately the first one. The
alternative, the debugger taking over interrupt answering while attached,
is a switch in the run's interrupt loop and can be added if watching a
rejection happen with no way to intervene turns out to hurt. Both terminal
and debugger answering the same interrupt needs an arbiter and is not
planned.

The one interrupt the debugger does answer is its own. A debug stop is an
interrupt raised at `debugStep` with `DebugStopData` as its data, and the
driver answers it with the user's command, in process, through the
module's `respondToInterrupts`. A debug stop never goes through the
handler chain, so no policy sees one. What must not happen is a stop
reaching the caller: `agency run`'s loop, a TypeScript program's `await
main()`, or a parent process over IPC, none of which know what a stop
is. So the runtime answers stops before a node call returns, and the
caller sees only the program's interrupts and the final value.

### Running from TypeScript

A program started from TypeScript (`import { main } from "./main.js"`,
then `await main("Adit")`) is attachable too, with nothing for the caller
to do. The hooks live in the runtime's node invocation, which a
TypeScript call reaches the same way `agency run` does. The caller's
interrupt handling is unchanged: `main()` still returns the program's
interrupts and the caller still answers them with `respondToInterrupts`.

One rule makes this work. Today a debug stop makes the node function
return, and the debugger resumes it; that is fine when the debugger is
the caller and wrong when a TypeScript program is. So the run side answers
debug stops inside the runtime, before the node returns, and the caller
sees only the program's interrupts and the final value. When one batch
holds both a stop and a program interrupt, the stop is dropped from what
the caller sees: a resume never reads an answer for a debug stop, the
stopped branch carries on from the flag in its frame, and if the user
was stepping it stops again at that branch's next step. The same rule
is what makes `agency run` and `node dist/main.js` work, so TypeScript
costs nothing extra.

The debugger resumes the program with the options the caller started it
with: its policy, host, budget, callbacks, and cancel signal. A resume
does not remember them, so the runtime hands them to the debugger with
each stop, and the debugger passes them back. A caller's policy that
rejects an effect still rejects it after a step. No new access concern:
the process gets the same socket and the same rules as any other run.

### Program output

The program's stdout and stderr stay on the program's terminal. The
debugger does not mirror them in this version. The in-process TUI captures
stdout because it owns the terminal; an attached debugger does not, and
duplicating output over the socket is work with no user asking for it.

## The runtime's view

### Registration lives behind `#platform`

The runtime's hooks that differ by platform and are not the host's
business live behind the `#platform` import: `platform.node.ts` and
`platform.browser.ts` export the same names (`docs/dev/runtime/host.md`).
Attach is one of them: it is Agency's own machinery, not something the
platform offers a program, and the code behind it (the socket, the
driver, the record file) may not be imported by `lib/runtime` directly,
which the browser bundle reaches. So `platform.node.ts` exports
`registerAttach`, which installs the signal listener and writes the
record, and `platform.browser.ts` exports one that does nothing. It is
not a capability: a capability is something a program needs and a host
may refuse, and no program needs to be debuggable. If a browser debugger
is ever wanted, the browser platform file would register a trigger from
`postMessage` and a channel from `MessageChannel`, and nothing above it
changes.

`Channel` is the smallest thing a message can cross: `send(message)`,
`onMessage(fn)`, `onClose(fn)`, `close()`. The socket is one implementation
of it; a test uses an in-memory pair.

### What the run does at startup

When a node is invoked through the runtime's public `runNode`, the
runtime writes the session record and registers the trigger. This
happens in the runtime, not in the `run` command, so a compiled program
started with `node dist/main.js` or imported from TypeScript is
attachable too. The registration costs one signal handler and one small
file, and it does not happen when: the host is not the Node host, so a
test on a memory host writes nothing; a debugger is already installed,
so `agency debug` does not register its own process and a second
debugger cannot attach over the first; the process is an IPC child
started by `std::agency`'s `run`, which the first version leaves out so
the listing shows the runs a person started; or the node is run by
`agency serve`, which runs many invocations in one process and is out of
scope with hosted runs.

### What the run does when the trigger fires

1. Open the channel: listen on `<pid>.sock` in the sessions directory,
   removing a leftover socket at its own pid's path first, and `chmod`
   it `0600`. The server and every accepted connection are `unref`ed,
   so an open session never keeps a finished program alive.
2. On the first connection, build a `DebuggerDriver` in this process in
   attached mode, with the runtime's resume, rewind, and checkpoint
   functions bound to the module's context, and a `DebuggerIO` whose
   methods send messages on the channel and wait for the reply.
3. Install the driver's `DebuggerState` through the holder. It starts in
   stepping mode, so the run stops at its next step.
4. A second connection while one is attached is refused with "already
   attached since <time>" and closed. One debugger per run.
5. On close, for any reason: answer any pending stop with `continue`,
   remove the `DebuggerState`, drop the driver, close the socket, and keep
   the trigger registered so a later attach works. When the program
   finishes while attached, the run sends `finished` and closes.

The driver is built from the `RuntimeContext`, not from the module's
exports: `respondToInterrupts`, `rewindFrom`, `__setDebugger`, and
`__getCheckpoints` are each a one-line wrapper over a runtime function
that takes the context, so the run side calls those functions directly.

### The messages

One request type per `DebuggerIO` method, with the method's arguments as
the payload and the method's return value as the reply:

| Message            | Payload                               | Reply              |
| ------------------ | ------------------------------------- | ------------------ |
| `render`           | checkpoint, stop, interruptId         | none               |
| `waitForCommand`   | none                                  | `DebuggerCommand`  |
| `showRewindSelector` | checkpoints (the window)            | index or null      |
| `answerGuardTrip`  | `GuardTripData`                       | `InterruptResponse`|
| `showCheckpointsPanel` | checkpoints (the window)          | none               |
| `promptForInput`   | prompt                                | string             |
| `appendStdout`     | text                                  | none (unused here) |
| `renderActivityOnly`, `startSpinner`, `stopSpinner` | none | none          |

Plus three that are not `DebuggerIO` methods: `hello` from the run on
connect, carrying the program path, node, and pid; `finished` from the
run when the program ends; and `refused` when a debugger is already
attached. There is no detach message: closing the channel, from either
side, is the detach. The rewind selector and the checkpoints panel are
sent the whole window of checkpoints: the first draft said summaries,
but both panels show the state at each checkpoint as the selection
moves, so a summary would not do. They are sent only when the person
opens a panel, and the per-message cap is sized for them. The
checkpoints themselves stay in the run's process, where the rewind
happens.

A checkpoint crosses the channel in its serialized form, the one the
checkpoint store already writes to a trace file, so the UI side rebuilds a
`Checkpoint` the same way the trace replay does. The driver keeps the
window in the run's process, where rewind needs it; the UI side keeps only
what it is showing.

Messages are newline-delimited JSON, one object per line, with a request id
so a reply matches its request, and a per-message size cap large enough
for an agent's checkpoint. The logs viewer's session protocol in
`lib/logsViewer/session/` is the house style for the shapes, but its
framing (one request per connection, a small cap, a timeout) is not
reused, because this is one long-lived two-way connection.

### The debugger's side

`agency debug --attach <pid>`:

1. Read the session record; refuse with a clear message if there is none
   or the process is gone.
2. Check the sessions directory is owned by the user with no group or
   world bits, and that the record's start time matches the live
   process's within two seconds (`ps -o lstart=` has one-second
   resolution). Send `SIGUSR2` and connect to `<pid>.sock`, retrying for
   a short time since the socket appears after the signal.
3. Build the `DebuggerUI` on the real terminal as today, and a
   `ChannelDebuggerIO` server that turns each incoming request into the
   matching `DebuggerUI` call and sends the result back.
4. On `q`, Ctrl-C, or the channel closing: send `detach`, tear down the UI,
   exit.

The driver does not exist in this process. Every key is a
`DebuggerCommand` the driver asked for through `waitForCommand`, as now,
except `q`, which detaches, and `print`, which the UI answers itself
from the frame it is showing.

## Access

Whoever can connect to the socket can do what the program's owner can do:
read every local and global as the panes show them, including values the
program holds in variables; `set` a variable, which is the "checkpoint is
the program" attack from `CLAUDE.md` with a convenient tool; and rewind.
In a later version with interrupt takeover, approve an interrupt, which is
the language's safety boundary. The socket is a credential, not a
convenience, and the spec says so rather than leaving it implied.

What limits it on a single-user machine: any process that can reach the
socket is already running as the user and can already read the user's
files, keys, and the agent's environment. The socket adds no new class of
attacker; it adds a more convenient door for the attacker the user already
had, such as a malicious package in another project. Three rules close
most of that door:

- The socket lives in `~/.agency/debug-sessions/`, a directory the run
  and the debugger both check before use: owned by the user, no group or
  world bits. That check is what the safety argument rests on. The
  socket is also `chmod 0600` after it is opened, a second layer with a
  short window at the umask's mode. So another user on a shared machine
  cannot connect and cannot plant a record.
- The debugger signals only a pid whose record's start time matches the
  live process, so a stale record never sends a signal to the wrong
  process.
- The socket exists only after the owner sent the signal, and only a
  process running as the same user can send it. An unsignalled run has no
  door at all.

With those three the remaining risk is accepted for a local developer
tool. Hosted runs are out of scope: a program served from statelog has no
terminal, no local user, and no socket, and attaching there would need a
different authorization story that nobody is asking for.

## Not goals

**A stdlib `attach` function.** `std::agency` exposes `compile`, `run`,
and `cli` to programs, and an `attach` beside them would let one agent
supervise another by debugging it. It was considered and set aside. The
power is wrong for a program: a debugger session is the owner's power,
read and set anything, and handing it to an LLM-driven program against a
run that did not ask to be supervised is the checkpoint attack with a
tool. The grain is wrong too: a supervisor wants the program's view, what
it is doing and whether it is stuck, not statements and locals read out of
someone else's source. `run` already supervises at the right grain, since
the parent's handler chain reaches every interrupt the child raises and
the parent sets its limits; a progress stream over the same IPC channel
would cover "is it stuck"; and collaboration between peers wants a message
primitive, not a debugger. Revisit only with a concrete supervisor in
hand, and check `run` plus a progress stream first.

**Hosted runs**, as above.

**Interrupt takeover**, for now, as above.

**Watch mode**, for now: the first version opens stopped and reads no
keys while the program runs.

**Mirroring program output** in the debugger.

**Attaching a program started before this change**, since it has no
trigger registered. The listing shows only runs that registered.

## Testing

Headless tests in the style of `docs/dev/cli/debugger-tests.md`, in two
layers. The first installs an attached driver on a fixture's context
while a TypeScript caller runs it, with no channel: it checks that the
caller never sees a stop, that a driver attached after the run started
stops at the next statement, that the caller's policy still rejects an
effect after a step, that a mixed batch reaches the caller with the stop
dropped, and that detaching resumes a stopped run and clears the
debugger. The second puts an in-memory channel pair between the run side
and a scripted `DebuggerIO`: `hello` arrives, the first stop renders,
`step` advances, `set` changes a local the program then prints, closing
the channel resumes a stopped run, a second connection is refused, and
`finished` arrives when the program ends; and the same against a
fixture stopped inside a tool call. One Node test opens a real socket in
a temporary sessions directory, checks its mode, the leftover cleanup,
and that a finished program exits with a session open. The built CLI is
smoked against a real `agency run` and against a program started from
TypeScript with a rejecting policy before the PR is opened.

## Files

New: `lib/runtime/attachedDebugger.ts` (the attached driver's type and
the settle in the public entry points); `lib/debugger/attach/` with
`channel.ts` (the `Channel` type and the in-memory pair),
`lineChannel.ts` (a channel over a socket), `protocol.ts` (the message
types), `channelIO.ts` (a `DebuggerIO` that sends), `serveIO.ts` (the
UI side that answers), `server.ts` (the run side: socket, driver,
install and remove), and `registry.ts` (records and the directory
check); `lib/cli/attach.ts` (the command). Changed:
`lib/runtime/state/context.ts` for the holder;
`lib/runtime/platform.node.ts` and `platform.browser.ts` for
`registerAttach`; `node.ts` and `interrupts.ts` for the settle in their
public entry points; `lib/debugger/driver.ts` for attached mode;
`lib/cli/debug.ts` and `scripts/agency.ts` for `--attach`;
`docs/dev/cli/debugger.md` for the user's view and a new
`docs/dev/cli/debugger-attach.md` for this design, with the `CLAUDE.md`
index and the `agency-cli-docs` skill updated together.
