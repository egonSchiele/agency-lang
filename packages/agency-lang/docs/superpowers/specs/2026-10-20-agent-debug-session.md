# `agency debug session`: the debugger an agent drives

Linear: ADI-11, in the project "Attach to a running Agency program",
milestone "An agent can attach to a running program". Builds on the attach
spec, `2026-10-20-attach-to-a-running-program.md`, which shipped as #1228,
#1229, #1230, and #1232.

## The problem

A person can now attach the full debugger to a running program with
`agency debug --attach <pid>`. An agent cannot. The debugger is a terminal
UI that reads keys and draws panes, and an agent such as Claude Code works
by running one command, reading what it printed, and running the next.
The run that goes wrong forty minutes in is exactly the one a person hands
to an agent: "it looks stuck, what is it doing?" Today the agent can grep
the log. It cannot look at the live program, see which tool it is inside,
read the thread the model is looping on, or step it forward.

The goal of this spec:

```
$ agency debug session attach 48213
attached to 48213 agent.agency · node main · started 4m12s ago
stopped in search ("in search") · agent.agency:8
  const url = "https://example.test/" + query
stack   main › llm (round 3 of 20; tools search, writeUp, confirm) › search
threads main (12 messages) · search#2 (3 messages, active)
guards  research · cost $0.42 of $0.50 · root · time 4m10s of 30m
usage   31k tokens · $0.42
next    step, next, continue, frame, thread, branches, guards, detach
```

and from there `agency debug session step`, `thread`, `continue`, `wait`,
`detach`, one command per decision, each printing what the agent needs to
decide the next one. Readable text by default, `--json` on request,
refusals that say the way forward. The pattern is `agency logs session`
(PR #1214), the CLI an agent uses to talk to an open logs viewer.

## What exists, and the one thing missing

The attach work put the whole debugger on the run side. `DebuggerDriver`
runs inside the program's process: the checkpoint window, the stepping
depth, resume, rewind, `set`, the one-run-at-a-time rule. The terminal UI
on the other side of the socket is thin on purpose: it answers each
`DebuggerIO` request the driver sends (`render`, `waitForCommand`, the
selectors) and keeps only what it is showing. The protocol is one
long-lived connection, and closing it, from either side, is the detach.

That last rule is the one thing in the way. An agent's commands are
separate processes. Between `step` and `thread` nothing is connected. If
the connection is the session, the program is detached, and resumes, the
moment `step` exits.

So the design is: **the run holds the session; a command is a visit.**
The driver, the window, and the pending request already live in the run.
What changes is that a session opened by the CLI survives the connection
closing. A visit connects, is told where the program is, answers the
pending request or just reads, and disconnects. The next visit picks up
where the last one left off. Nothing moves across processes that does
not already cross the socket today, and `agency debug --attach` for a
person is unchanged: its connection still is its session.

The second decision follows from the first: **a person and an agent can
be on one run at the same time, and either one drives.** Since the run
holds the session, a terminal debugger and a CLI session are two parties
on the same state, not two sessions. Both see every stop; whichever
answers first moves the program; the other is told who answered and
with what. The log viewer's session works this way already (a request
from the CLI and a key from the person are applied in the order they
arrive, and the screen shows the result), and the one thing a debugger
adds, that a stop takes exactly one answer, is handled by the request
ids the channel already has. The rules are in "Two parties, one answer".

## The user's view

### Finding and attaching

```
$ agency debug session list
  PID    PROGRAM          NODE   STARTED    SESSION
  48213  agent.agency     main   4m12s ago  none
  51002  research.agency  main   38s ago    held, last visit 12s ago
```

`list` is the `--attach` listing with one more column: who is on the
run: `none`, `terminal`, `held, last visit 12s ago`, or `terminal +
held`. It reads
the records in the sessions directory, drops the stale ones, and for a
run whose socket exists sends a `probe` visit, which the run answers with
its session state and nothing else.

```
$ agency debug session attach 48213
```

does what `--attach 48213` does up to the connection: checks the sessions
directory, reads the record, checks the live process's start time
(`checkedRecord` in `lib/cli/attach.ts`, reused as it is), sends
`SIGUSR2` unless the socket already exists, connects. Its first message
says it is a CLI visit, and the run opens a held session: it installs the
driver in stepping mode, and the program stops at its next step. The
visit waits for that stop and prints the summary above. `attach` on a run
that already holds a CLI session is a plain visit and prints the summary.
`attach` on a run a terminal debugger is attached to joins it: the
program is already stopped, or running under the person's `continue`,
and the summary says `a terminal debugger is attached too`; the person's
screen says the same. The skill's ask-first rule covers this case.

Every other command needs a pid. `--pid <pid>` names it; with one held
session and no flag, that one is meant, the way `agency logs session`
picks the one open viewer. With none, or more than one and no flag, the
command is refused with the list.

### Where the program is

`where` prints the summary again, from the stop the run is at. It is the
first thing an agent should run and the thing it runs after every step.
The summary is one screen, and its lines are, in order:

- **The stop.** The scope, the stop's label when a `debugger("...")`
  statement made it, the source location, and the statement's text when
  the file is on disk at the path the location names.
- **The stack**, from the checkpoint's frames, innermost last. A frame
  that is a tool loop says its round and its tools.
- **Threads**, each by label with its message count; the active one
  marked.
- **Branches**, only when there are any: the tool calls, fork branches,
  and parallel items running under the stopped frame, each with its
  state (running, stopped at this stop, interrupted, done).
- **Guards**, from the stack: each guard's label, kind, spent, and limit;
  disarmed ones say so.
- **Usage**: the run's tokens and cost.
- **The program's own interrupt**, when the stop is beside one: "the
  program raised std::env (name: HOME); its caller answers it, not the
  debugger".
- **Next**: the commands that make sense from here.

When the program is running (after `continue`, or before the attach
stop), `where` prints `running since <time>; wait stops here at the next
stop` and exits 0.

### Reading deeper

Each reader prints one part of the checkpoint at the stop. None of them
moves the program.

| Command                      | Prints                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `frame [n]`                  | The stopped frame, or frame `n` of the stack: its args, locals, and the statement. `--globals` adds the module's globals. Values are printed as JSON, long ones cut with the length said. |
| `stack`                      | Every frame, numbered, with scope, module, and for a tool loop its round and tools.       |
| `threads`                    | Every thread: label, parent, message count, active or not.                              |
| `thread [label] [--last n]`  | A thread's messages, the active one by default, the last ten unless `--last` says otherwise. Each message as the logs viewer prints it: role, the tool name for a tool call, the text, cut at a length with the cut said. |
| `branches`                   | The branches under the stopped frame, each with key, label, and state.                  |
| `branch <key>`               | One branch's stack, as `stack` prints the main one, and its interrupt or result.          |
| `guards`                     | Every guard, with spent against limit, and the tool loop's state when the stop is inside one: round, removed tools. |
| `checkpoints`                | The rolling window: id, scope, location, one per line, the current one marked.          |
| `source [--context n]`       | The statement and `n` lines around it, when the file is on disk.                        |

Each reader is a pure function of a `Checkpoint` and its arguments, in a
module the terminal UI's panes could call too; the UI's `UIState` already
has `listThreads`, `listBranches`, `listGuards`, `loopState`, and
`getCallStack`, and those move into that module so the two views cannot
drift. The CLI never imports the program's compiled module: a location
names a file, and the CLI reads that file when it exists, which is the
fix `debugger-future-work.md` lists for the UI side's source-map import.

### Moving the program

| Command                 | Does                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `step`                  | One statement, stepping into calls. Prints `where` at the new stop.                                      |
| `next`                  | One statement, over calls.                                                                               |
| `in`, `out`             | Step in, step out.                                                                                       |
| `continue`              | Run until the next `debugger()` statement, the next stop a person's breakpoint makes, or the end. Prints `running` and exits at once. |
| `wait [--for <duration>]` | Block until the program stops or ends, up to the duration (default 5 minutes), then print `where`, or `still running` with exit code 3 at the deadline. |
| `pause`                 | Ask a running program to stop at its next statement, as `s` does while it runs in the terminal debugger: the `pause` message on the channel. Prints `pausing at the next statement` and exits at once; a model call in flight is not interrupted. `wait` then returns at that stop. |
| `back`                  | Step back one checkpoint, as `stepBack` does; refused at the earliest with the reason.                   |
| `rewind <id>`           | Rewind to a checkpoint from `checkpoints`.                                                               |
| `set <name> <json>`     | Queue a local's new value for the next resume, as the debugger's `set`; printed back with the frame.     |
| `checkpoint [label]`    | Pin the current checkpoint with a label, as the debugger's `checkpoint`.                                 |
| `save <path>`, `load <path>` | The debugger's `:save` and `:load`; the path resolves in the program's process, as attached today.   |
| `detach`                | End the session: the stop is answered with `continue`, the driver is removed, the program runs on at no cost. |

A moving command answers the stop and then waits for the next request
from the driver, which is the `render` of the next stop, so it can print
`where` before it exits. If the program ends instead, the command prints
`Program finished. Return value: ...` or `Program threw: ...` and exits 0,
and the session is over. If the leg hands the program's own interrupt to
its caller, the command prints that and that the program is waiting on
its caller; `wait` then returns at the next stop after the caller answers.

Every moving command, and `set`, `checkpoint`, `save`, `load`, `back`,
and `rewind`, is an answer to the stop the visit was shown: the reply
carries the request id the visit received on connecting. If a terminal
debugger answered that stop first, the command is refused with what
happened and where the program is now: `the stop you saw was answered by
the terminal (continue); now at research.agency:52, running`. The agent
runs `where` or `wait` and decides again. Readers answer nothing and are
never refused this way.

Every command's text is what a person would want to read; `--json` gives
the same facts as fields. The exit codes: 0 for an answer, 1 for a
refusal (with the way forward in the message), 2 when the program ended,
3 when `wait` ran out.

### A person and an agent together

A person at `agency debug --attach` and an agent at `agency debug
session` can be on one run at once. Both are shown every stop. Either
answers it, and the other is told: the terminal's activity pane reads
`cli: step`, and the agent's next `where` lists `terminal: continue`
among the lines since its last visit. The terminal's status line says
`with agency debug session` while a CLI session is held, and the CLI's
`where` says `a terminal debugger is attached too`.

What the person sees when the agent moves the program: the panes redraw
at the new stop, as after their own step, and the activity line says who
did it. A picker or form the person had open when the agent answered
closes, with the same line. What the agent sees when the person moves
the program: its moving command is refused as above, and its readers
read the new stop.

Either party can pause a running program (space in the terminal, `pause`
from the CLI), since a pause only asks the run to stop at its next
statement, and either sees the stop. Either party can `detach`; the
other stays, and the session ends when the last party leaves.

The program's own interrupts are not a conflict, because an attached
debugger answers none of them: they go to the program's caller, as the
attach spec says, and both parties see them go by.

### What the debugger does not touch

The rules from the attach spec hold. A run keeps its own interrupt rule:
its policy, flags, or terminal answer the program's interrupts, and the
agent sees them go by in `where` but does not answer them. The program's
stdout stays on the program's terminal. One run at a time is debugged in
a process that runs several. `set` and `rewind` are the owner's powers
and the skill says when an agent may use them.

## The runtime's view

### A session with parties

`attachOverChannel` today ties the session to the channel: `onClose`
detaches. The change is one state on the run side, in `server.ts`: one
session per run, with up to two parties on it.

```
type Session = {
  terminal: Channel | null;           // a person's debugger, at most one
  cli: {                              // held by the CLI, or null
    visit: Channel | null;            // the visit connected now, if any
    lastVisit: number;
    lease: Timer;
  } | null;
  pending: Request | null;            // the request waiting for an answer
  lastRender: RenderArgs | null;      // what a joining party is shown
  recent: string[];                   // the last twenty activity lines
};
```

A connection's first message is `client`, new in `protocol.ts`:
`{ type: "client", kind: "terminal" | "cli" | "probe" }`. The terminal UI
sends `terminal` (one line added to `serveDebuggerIO`). `cli` opens the
CLI's hold on the first visit, and on a later visit joins it. `probe` is
answered with `{ type: "status", ... }` and the connection closed, with
no driver installed and nothing else sent, so `list` costs a run nothing.
The session is created when the first party joins, and the driver is
installed then; it ends, and the driver is removed, when the last party
leaves (below).

Every party joining is sent the same three things: the run's `hello`,
the last `render` (the stop's checkpoint, which a reader needs and a
terminal draws), and the pending request if there is one. For a visit
that is the whole handshake; for a terminal joining a held session it is
what makes its screen show the stop the agent is at.

The driver's `ChannelDebuggerIO` sends each request to every connected
party, and keeps it as `pending` while no party has answered. A party
that closes without answering leaves the request pending, which is the
normal end of a reader visit, and the normal end of a terminal while a
CLI hold is live. `DebuggerDetached`, which the IO throws today when the
channel closes with a request pending, is thrown only when the session
ends.

Notices (`log`, `setMode`, `setOverrides`, `setBusy`, the spinner) go to
every connected party, and the activity lines are also kept, the last
twenty, so `where` can print what happened since the last visit: "the
program raised std::env; passed to its caller", "terminal: continue".

### Two parties, one answer

A request has an id, and a reply carries it; that is the channel today.
The one rule added: **the first reply to a pending request is the
answer, and a later reply to the same id is refused.** The IO answers the
driver with the first reply, logs one activity line naming the party
and the command (`cli: step`, `terminal: continue`), and sends every
other party `{ type: "answered", id, by, command }`. A reply that
arrives for an id that is no longer pending is answered with the same
`answered` message and nothing else happens.

Each side does one thing with `answered`. The CLI prints the refusal in
"Moving the program" and exits 1. The terminal UI drops the read it was
blocked on for that request: a `waitForCommand` stops waiting for a
key, and a picker or form open for a selector closes, with the activity
line saying who answered. That is a rejected `readKey`, the path
`TerminalInput.nextKey` already takes when the line reader takes the
terminal, so the UI has the mechanism; the driver's next `render` then
arrives at a UI that is waiting for nothing.

Two requests that want different handling:

- `render` is sent to every party and waits for all of them to
  acknowledge, since each must have drawn or stored the stop before it
  is asked for a command; a party that closes mid-render is dropped
  from the wait.
- Every other request resolves on the first reply.

`pause` is not a request and needs no rule: either party may send it,
and it sets stepping mode on the run.

There is no merging anywhere in this. The run applies one command at a
time to one state and tells both parties the result; a party that acted
on an old picture is refused, not reconciled. The invariant that keeps
it so: a command is one visit and one reply, and the run owns everything
between. No command may keep state on the client across round trips.

### The lease

A program must never wait on a debugger that is not there. With a person,
closing the terminal is the detach. With an agent, the agent may crash,
be killed, or forget. So a held session has a lease: ten minutes from the
last visit's close. When it runs out the run logs one line on its stderr,
`debug session: no visit for 10 minutes, releasing the CLI's hold`, and
drops the CLI as a party. A `wait` is a visit for as long as it is
connected, so an agent waiting on a long `continue` keeps its lease. The
lease is on the run side and needs no process on the CLI side to be
alive, which is the point.

The session ends when no party is left: the terminal has closed, and
the CLI's hold is gone, by `detach` or by the lease. Then the run
detaches the way a closed channel does today: the stop is answered with
`continue`, the driver is removed, and the program runs on at no cost.
A terminal closing while the CLI's hold is live ends nothing, and a
lease running out while a terminal is attached ends nothing; a person
at the keyboard is a party that needs no lease.

### Who is attached

One terminal and one CLI hold per run. A second terminal is refused as
today, `already attached since <time>, by a terminal debugger`. Two CLI
visits at the same time, two agents or one agent running commands in
parallel, are refused with `another visit is in progress`: a hold has
one visit, so that an agent's own commands cannot race each other. The
skill tells an agent to run its debugger commands one at a time. Both
parties are told when the other joins or leaves (`parties`, a notice
with who is on the run), which is what the status line and `where`
print.

### Program end

When the program ends, the run sends `finished` to every connected
party, keeps the fact for the next visit if the CLI's hold has none
(`where` then prints `Program finished` and exits 2), closes the socket,
and removes the driver as today. The record is removed at exit as today,
so a visit after the process is gone is refused by `checkedRecord`.

## The command's side

`lib/cli/debugSession/`, three files on the pattern of
`lib/cli/logsSession/`:

- `register.ts`: the `session` subcommand under `debug`, one leaf per
  verb, the shared `--pid` and `--json` flags declared on each leaf (the
  vendored commander refuses a flag an ancestor declares).
- `commands.ts`: one function per verb, each a function of a `Visit` and
  its arguments, returning `{ text, json, exitCode }`. No verb touches a
  flag or a file; the readers are pure functions of the checkpoint.
- `index.ts`: resolve the target (the pid, the record, the start-time
  check), open the visit, run the verb, print, exit. The only file with
  a socket in it, through `lineChannel`.

A `Visit` is one connection: `open(socketPath)` sends `client cli`, reads
`hello`, the `render`, the `parties` notice, and the pending request, and
returns them; `answer(reply)` sends the reply with the pending request's
id and waits for the next request, an `answered` (the refusal), or
`finished`; `close()`.
It is the CLI's `DebuggerIO` turned inside out, and it is the only new
protocol logic on the CLI side. The `where` text is built by one function
of (`hello`, checkpoint, stop, activity lines), tested on fixtures.

Refusals name the way forward: no record → "no run with pid N is
registered; `agency debug session list` shows the runs that are"; a run
the agent did not attach → "no session on N; `agency debug session attach
N` opens one"; a program not stopped → "N is running; `wait` stops here at
its next stop"; a reader with no file on disk → the location alone and
"the source is not at <path> from here; run from the program's directory
to see it"; a stale answer → "the stop you saw was answered by the
terminal (continue); now at <location>", exit 1.

## The skill

`.claude/commands/debug-run.md`, the companion of `debug-logs.md`. It
says, in this order:

1. **When to attach.** A run the person says is stuck, slow, or doing the
   wrong thing while it is still running. A run that has ended is a log
   question; use `/debug-logs`. Attaching stops the program at its next
   statement, so it is never a free look.
2. **Ask first.** Before attaching to a program a person is watching or
   interacting with, say that attaching stops it and ask. The exception
   is a program the person just asked the agent to look at, which is
   the ask. Never attach to a run another person started.
3. **What to look at**, from `where`: a tool loop's round against its
   limit says whether the model is looping; `thread` on the active
   thread shows what it keeps saying; `branches` shows a tool call that
   has been running the whole time; `guards` says what it has spent.
4. **Keep it moving.** Think with the program running, not stopped:
   `continue` and `wait` between looks, `detach` the moment the question
   is answered, and never leave a program stopped while writing a long
   reply. The run detaches itself after ten minutes without a visit, and
   that is a safety net, not a plan.
5. **One command at a time.** The session has one pending question;
   parallel commands are refused.
6. **A person may be driving too.** `where` says when a terminal
   debugger is attached. Then the person's moves show up as `terminal:
   ...` lines, a moving command can be refused because the person got
   there first, and the answer is to look again, not retry. Do not
   `continue` or `detach` a run a person is stepping through without
   saying so.
7. **Do not change the run without asking.** `set`, `rewind`, `back`, and
   `load` change what the program will do. Report what you would change
   and why, and do it only when the person says so. The program's own
   interrupts are the person's to answer, in the program's terminal.
8. **Report.** Where it was, what it was doing, what it had spent, and
   what the agent changed, if anything, with the exact commands.

## Access

Nothing new is opened. The socket, the directory check, the record and
start-time check, and the signal are the attach spec's, and the CLI
reaches the run the way `agency debug --attach` does. What is new is
that a program can now be stopped and read by software the person did
not watch type each key, and that a held session outlives the process
that opened it. The lease bounds the second; the skill's ask-first rule
bounds the first, and a person who is attached sees every command the
agent sends, as it is sent. An agent runs as
the user and had the user's powers already; the socket still adds no new
class of attacker.

## Not goals

**A stdlib `attach` function**, so an Agency program could debug another
from inside. The attach spec set it aside and nothing here changes that;
the CLI is for an agent such as Claude Code outside any Agency program.

**A view-only party.** A terminal that watches and cannot drive would be
a party whose replies are always refused; nothing here needs it, and it
can be a flag on `--attach` later.

**A timing guard on `continue`.** The one unintended outcome left is a
`c` typed in the instant between the other party's step and the redraw,
which lands on the new stop. Every single-user debugger has the same
race between a redraw and a key. If it bites, the terminal UI can refuse
a `c` typed within a fraction of a second of a new stop and ask again;
not in these PRs.

**Interrupt takeover**, **watch mode**, **output mirroring**, and
**hosted runs**, as in the attach spec.

**A streaming or long-lived CLI mode** (`agency debug session repl`). An
agent runs commands; a REPL would be a second terminal UI.

## Testing

Three layers, headless, saving no real records (`AGENCY_HOME` points at
the test's temporary directory as the attach tests arrange).

1. **The held session, on a memory pair** (`lib/debugger/attach/held.test.ts`):
   a CLI visit opens a session and closes; the program stays stopped; a
   second visit is sent the render and the pending request; its answer
   steps the program; a visit that reads and closes leaves it stopped; a
   second visit during one is refused; the lease, with a fake clock,
   detaches and the program finishes; `finished` reaches the next visit
   when no visit was connected.
   **Two parties** (`lib/debugger/attach/parties.test.ts`): a terminal
   client and a CLI visit on one run are both sent the stop; the CLI
   answers first and the terminal gets `answered` with the command, and
   its late reply is refused; the terminal answers first and the visit
   is refused; a terminal joining a held session is sent the last render
   and the pending request; either party's pause stops the program;
   the terminal closing leaves the hold live and the program stopped;
   the lease running out with a terminal attached ends nothing; the
   last party leaving detaches; both are sent `finished`; the activity
   lines name the party.
2. **The verbs and readers, on fixtures** (`lib/cli/debugSession/commands.test.ts`):
   the `where` text for the agent-shaped fixture stopped inside `search`,
   with its stack, threads, branches, and guards lines; each reader on a
   checkpoint taken from the same fixture; the refusal messages; `--json`
   shapes.
3. **End to end, on a real socket** (`lib/cli/debugSession/index.test.ts`):
   a fixture compiled into `.agency-tmp` and started with `node`, `list`,
   `attach`, `where`, `step`, `thread`, `continue`, `wait`, `detach`, and
   the child exits 0, the way `lib/cli/attach.test.ts` runs its session.

## The PRs

1. **The held session**: the `client` message, the session state in
   `server.ts`, the pending request and kept notices in
   `ChannelDebuggerIO`, the lease, the probe, and the terminal UI
   declaring itself. Tests in layer 1. No CLI yet; `--attach` behaves as
   before, and a terminal is still refused while a hold is live.
2. **Two parties**: requests and notices to every party, first answer
   wins, `answered` and `parties`, the activity line per answer, the
   terminal UI dropping a withdrawn read and showing the other party,
   the session-end rule. Tests in the two-parties file.
3. **The commands**: `lib/cli/debugSession/`, the readers moved out of
   `UIState` into a shared module, `where`, the verbs, `list` with its
   session column, docs (`docs/site/cli/debug.md`, a dev doc
   `docs/dev/cli/debugger-session.md`, and the index line). Tests in
   layers 2 and 3.
4. **The skill**: `.claude/commands/debug-run.md`, and a paragraph in the
   debugger's user doc that says an agent can drive it, beside a person
   or alone.

Each PR is based on main, and the spec is reviewed before the issues
under the milestone are written.
