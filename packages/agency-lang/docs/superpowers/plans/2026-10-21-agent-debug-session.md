# Plan: `agency debug session`, the debugger an agent drives

Implements `docs/superpowers/specs/2026-10-20-agent-debug-session.md`.
Linear: ADI-11, with one ticket per PR below once the spec is reviewed.

Four PRs against `main`, each reviewed on its own and each useful alone.
PR 1 lets a debugger session outlive the connection that opened it, so a
CLI can drive the program one command at a time. PR 2 lets a person's
terminal and the CLI be on one run together. PR 3 is the CLI itself,
`agency debug session`, with its readers and verbs. PR 4 is the skill
that teaches an agent when to use it. Smoke the built binary after each
build, against a real `agency run` in another terminal, not only the
tests.

Reading before starting: the spec; `docs/dev/cli/debugger.md`, the
sections "A debugger installed on a running program" and "What the
program is waiting on"; `docs/dev/cli/debugger-attach.md` whole;
`docs/dev/cli/logs-viewer.md`, the "Sessions" section, and
`lib/cli/logsSession/`, whose three files are the model for PR 3.

## What is already there

The attach work (#1228, #1229, #1230) put everything that matters in the
program's process. `DebuggerDriver` in attached mode (`lib/debugger/driver.ts`)
owns the checkpoint window, the stepping mode, the pending overrides, and
the one-run-at-a-time rule. `ChannelDebuggerIO` (`lib/debugger/attach/channelIO.ts`)
is the driver's `DebuggerIO`: each method is a `request` with an id, or a
`notice`, on a `Channel`, and a reply carries the id back. The UI side,
`serveDebuggerIO` in `serveIO.ts`, answers each request with the matching
call on a real `DebuggerIO`. `attachOverChannel` in `server.ts` builds
one driver per channel and detaches on close; `startAttachServer` refuses
a second connection while one is open. The protocol in `protocol.ts` is
zod schemas with a compile-time check that each command and response
shape has a schema line.

Nothing in these PRs changes the driver's logic or the runtime. All four
work on the layer between the driver and its UI, and on the CLI.

## Where the imperative code lives

The session has rules: who may join, who is refused, what a joining
party is sent, which reply answers a request, when the lease fires,
when the session ends. The first draft of this plan put those rules as
mutable fields inside the socket handler in `server.ts`, beside timers
and sockets, which is the "imperative code everywhere" anti-pattern
(`docs/dev/contributing/anti-patterns.md`): every rule would be a
branch in a handler, and a reader could not see the rules without
reading the sockets.

So the rules are one pure function, and the sockets are one adapter:

- `lib/debugger/attach/sessionRules.ts`: `type SessionState`, `type
  SessionEvent`, `type Effect`, and `step(state, event): { state, effects }`.
  Events are what can happen: a party connects with a `client` kind,
  a party's channel closes, the driver sends a message, a party sends a
  message, the lease timer fires, the program finishes. Effects are
  what should be done about it: send this message to this party,
  refuse this connection with this reason, deliver this reply to the
  driver, start the lease, clear the lease, end the session. The
  function never touches a socket, a timer, or a promise, and the state
  is a plain value, so the tests are a table of events in and effects
  out.
- `lib/debugger/attach/sessionChannel.ts`: the adapter. It implements
  `Channel`, the type `ChannelDebuggerIO` already takes, and holds the
  state. `send` from the IO is the "driver sends" event; a message from
  a party is the "party sends" event; the effects are applied to the
  parties' channels, the lease timer, and the IO's `onMessage` and
  `onClose` listeners. This is the only file in the session with a
  timer in it.
- `server.ts` keeps the sockets, and hands each accepted connection to
  the session channel after reading its first message.

`ChannelDebuggerIO` does not change in PR 1 or PR 2. It sends a request
on its channel and waits for the reply with that id; the session channel
decides which party's reply that is, re-sends an unanswered request to
a party that joins, and closes only when the session ends, so the IO's
rule that a close rejects every pending request with `DebuggerDetached`
is exactly the session-end rule. The same is true on the CLI side: a
`Visit` is sockets, and every verb is a pure function of what the visit
returned.

## PR 1. The held session (ADI-11a)

After this PR a CLI client can connect, be shown the stop, answer it or
not, and disconnect, and the program stays stopped with its driver in
place until the next client connects. `agency debug --attach` behaves as
before. No CLI command exists yet; the tests drive the protocol directly.

### The protocol

In `lib/debugger/attach/protocol.ts`:

- `client`: `{ type: "client", kind: "terminal" | "cli" | "probe" }`, the
  first message a connection sends. A connection whose first message is
  anything else is refused: the run cannot tell what it is, and both
  ends ship in one package, so there is no older debugger to keep
  working.
- `status`: `{ type: "status", terminal: boolean, cli: { lastVisit: string } | null, stopped: boolean }`,
  the answer to a `probe`.
- `finished` is unchanged. `hello` is unchanged.

Add both to `AttachMessageSchema` and to the `SameShape` check.

### The rules

`sessionRules.ts`, as "Where the imperative code lives" describes. The
state in this PR:

```
type SessionState = {
  terminal: PartyId | null;
  cli: { visit: PartyId | null; lastVisit: number } | null;
  pending: RequestMessage | null;   // the driver's request no party has answered
  lastRender: RequestMessage | null;
  recent: string[];                 // the last twenty log lines
  finished: FinishedMessage | null; // kept for a visit that comes after the end
};
```

The rules, each one case of `step`, each one row in the test table:

- A `probe` connects: send it `status`, close it. Nothing else changes.
- A `terminal` connects while `terminal` is set: refuse, `already
  attached since <time>, by a terminal debugger`. While `cli` is set:
  refuse, `by agency debug session` (PR 2 lifts this one).
- A `cli` connects while `terminal` is set: refuse, `by a terminal
  debugger` (PR 2 lifts it). While `cli.visit` is set: refuse, `another
  visit is in progress`.
- A party joins: send it `hello`, the `recent` lines as `log` notices,
  `lastRender` if any, then `pending` if any; clear the lease. If
  `finished` is set, send that instead and close it.
- The driver sends a `request`: it becomes `pending` (and `lastRender`
  when its method is `render`); send it to the connected party, if any.
- The driver sends a `notice`: send it to the connected party; a `log`
  notice is also appended to `recent`, keeping twenty.
- A party sends a `reply` whose id is `pending`'s: clear `pending`,
  deliver the reply to the driver. Any other reply from a party is
  dropped (PR 2 answers it).
- A party sends `pause`: deliver it to the driver.
- A terminal's channel closes: clear `terminal`; if `cli` is null, end
  the session.
- A visit's channel closes: clear `cli.visit`, set `lastVisit`, start
  the lease.
- The lease fires: clear `cli`, log the stderr line; if `terminal` is
  null, end the session.
- The program finishes (the driver's `finished`): send it to the
  connected party; if none, keep it as `finished`; end the session
  once it has been delivered or there is no one to deliver it to. In
  this PR a held session with no visit keeps the socket open until a
  visit collects `finished` or the lease fires.

"End the session" is one effect, `end`, and the adapter does what
`detach` does today: `driver.detach()`, close every party's channel,
and fire the IO's `onClose`, which rejects the pending request with
`DebuggerDetached`, the answer the driver treats as `continue`.

### The adapter

`sessionChannel.ts`: `sessionChannel(options): SessionChannel`, where
`SessionChannel` is a `Channel` plus `admit(channel, kind)` for the
server to call with an accepted connection and its first message, and
`end()`. It holds one `SessionState`, applies each event through
`step`, and runs the effects. The lease timer is `setTimeout`, `unref`ed,
with `options.setTimer` and `options.now` injected so a test runs it
with a fake clock. `keepAlive` from the IO, which `ref`ed one socket
while a request was pending, becomes `ref` on the server while
`pending` is set, since a stopped program is waiting on whoever
connects next; the adapter exposes `keepAlive` on the `Channel` as
today and the server wires it.

`attachOverChannel` in `server.ts` becomes `openSession(options)`: build
the session channel, the `ChannelDebuggerIO` on it, and the driver, as
today, and return the session. `startAttachServer` reads each accepted
connection's first message (`client`, or anything else for an old
terminal) and calls `admit`; every refusal comes back as an effect, so
the handler has no branches of its own. The `current()` accessor the
tests use returns the session.

### The terminal UI declares itself

`serveDebuggerIO` sends `client terminal` as its first message. Nothing
else on the UI side changes in this PR.

### Tests for the PR

`lib/debugger/attach/sessionRules.test.ts`, the table: each rule above
as one case, a state and an event in, the effects and the new state
out, with no socket, timer, or driver. This is where the rules are
proved, and a new rule is a new row.

`lib/debugger/attach/held.test.ts`, the adapter and the driver on a
memory channel pair and the agent-shaped fixture, scripted the way
`attach.test.ts` scripts a UI, covering the paths the table cannot:

- A CLI client joins, is sent `hello` and no render, the program stops,
  it is sent `render` and `waitForCommand`, and it closes. The program
  stays stopped (the node promise is still pending after a tick).
- A second client joins and is sent `hello`, the same `render`, and
  `waitForCommand` with the same id. It replies `step`. The program
  reaches the next statement, and the client is sent the next `render`.
- A client that joins, reads, and closes leaves the request pending;
  three such visits in a row and the program has not moved.
- A terminal client is refused while a hold is live, with the reason;
  a CLI client is refused while a terminal is attached.
- A second CLI client while one is connected is refused with `another
  visit is in progress`.
- The lease, with a fake clock: no visit for ten minutes, the stderr
  line, the program finishes, the final value is the caller's.
- A visit during the lease resets it.
- The program ends while no visit is connected; the next client is
  sent `finished` and closed.
- `probe` is answered with `status` and nothing else, and no driver is
  installed (the program runs through).
- A connection whose first message is not `client` is refused.
- A visit that replies and closes in the same tick: the memory pair
  delivers the close first, unlike a socket, so the test waits a turn.

Keep the existing `attach.test.ts` and `server.test.ts` passing as they
are: the terminal path's behaviour is unchanged.

### Docs in the PR

In `docs/dev/cli/debugger-attach.md`, replace the sentence "There is no
detach message: closing the channel, from either side, is the detach"
with the session rule: a terminal's close is its detach, a CLI visit's
close is not, and the lease. Add "A held session" to the pieces list
beside `server.ts`. No user doc yet; nothing a person can type has
changed.

## PR 2. Two parties on one run (ADI-11b)

After this PR a person at `agency debug --attach` and a CLI client can be
on the run at once. Both are sent every stop, either answers it, and the
other is told. This is the whole of the "Two parties, one answer" section
of the spec, and it is the PR a reviewer should read most carefully,
because it is the one that changes what the terminal does.

### The protocol

- `answered`: `{ type: "answered", id, by: "terminal" | "cli", command: unknown }`.
  Sent to every other party when a request is answered, and to a party
  whose reply named an id that is no longer pending.
- `parties`: `{ type: "parties", terminal: boolean, cli: boolean }`, a
  notice sent to every party when one joins or leaves.
- `status` from PR 1 already carries both.

### The session with two parties

In `server.ts`, the session holds `terminal: Channel | null` and
`cli: { visit: Channel | null; lastVisit; lease } | null`, and the
refusals from PR 1 that kept them apart go. What remains refused: a
second terminal, and a second CLI visit during one. The session ends
when `terminal === null` and `cli === null`: a terminal closing while
the hold is live ends nothing, and the lease firing while a terminal is
attached clears `cli` and ends nothing. Every join and leave sends
`parties` to whoever is connected.

### The rules for two parties

All in `sessionRules.ts`; `ChannelDebuggerIO` is untouched. The state
gains `answered: { id, by, command }[]`, the last ten answers, and
`awaitingRender: PartyId[]`. The rows added or changed:

- A `terminal` connecting while `cli` is set, and a `cli` connecting
  while `terminal` is set, join instead of being refused. A join sends
  `parties` to every party.
- The driver sends a `request`: send it to every connected party. When
  its method is `render`, `awaitingRender` is the list of parties it
  went to.
- A party sends a `reply` whose id is `pending`'s: clear `pending`,
  deliver the reply to the driver, append to `answered`, send a `log`
  notice `${by}: ${describe(command)}` to every party (and to `recent`),
  and send `answered` to every other party. `describe` is one function
  in `lib/debugger/attach/describe.ts` that turns a `DebuggerCommand`
  or a selector's answer into a few words (`step`, `continue`, `set x =
  5`, `rewind to #12`, `grant cost 0.5`), tested on every command shape.
- A party sends a `reply` to a `render`: remove it from
  `awaitingRender`; when the list is empty, deliver one reply to the
  driver. A party leaving is removed from the list the same way.
- A party sends a `reply` whose id is in `answered`: send it that
  `answered`. Any other stale reply is dropped.
- A party leaves: send `parties` to the rest. The session ends when
  `terminal` and `cli` are both null, by whichever event made them so.
- `pause` from any party is delivered to the driver, as in PR 1.

### The terminal UI drops a withdrawn read

On `answered` for a request the UI is inside, `serveDebuggerIO` must
stop the UI waiting. Add `withdraw(): void` to `DebuggerUI`: it rejects
the current `personWaiter` with a `RequestWithdrawn` error, which
propagates up through `readKey` to whichever read is open, the command
loop in `waitForCommand`, a text input, or an overlay through
`OverlayContext.nextKey`, and from there out of the `DebuggerIO` method
`serveDebuggerIO` called. `serveDebuggerIO` catches `RequestWithdrawn`
and sends no reply. The rejection path exists already: `TerminalInput.nextKey`
rejects its waiters when `nextLine` takes the terminal, and `armReader`
handles that. The difference is who rejects.

Check each overlay in `overlays.ts` lets a rejected `nextKey` escape
rather than catching it; the guard trip form and the text input are
the ones to read. Then `waitForCommand` has one line to add: a
withdrawn read logs `${by} answered: ${command}` and returns to its
loop. The driver's next `render` arrives at a UI that is waiting for
nothing.

On `parties`, the UI stores the other party and the stats line shows
`with agency debug session` after the `attached to` label. On
`answered` for an id the UI was not inside (it had already replied, and
lost), log the same line.

A `TestDebuggerIO` in a test is withdrawn by resolving its scripted
command late; it needs no code.

### Tests for the PR

The rows above as cases in `sessionRules.test.ts`. Then
`lib/debugger/attach/parties.test.ts`, on two memory pairs, one scripted
terminal `DebuggerIO` and one hand-driven CLI client, for the paths that
need the driver and the adapter together:

- Both are sent the stop's `render` and `waitForCommand`, with one id.
- The CLI replies `step` first: the terminal gets `answered` naming
  `cli` and `step`, and its own later reply gets `answered` and moves
  nothing. The activity line `cli: step` reaches both.
- The terminal replies first: the CLI's reply is refused the same way.
- A terminal joining a held session is sent `hello`, the last render,
  the recent log lines, `parties`, and the pending request.
- A CLI visit joining while a terminal is attached: the same, and the
  terminal is sent `parties`.
- Either party's `pause` while the program runs stops it, and both are
  sent the stop.
- The terminal closes with the hold live: the program stays stopped,
  and the next visit is sent the pending request.
- The lease fires with a terminal attached: `cli` is cleared, `parties`
  goes to the terminal, nothing else happens.
- The last party leaves: the stop is answered with `continue` and the
  program finishes.
- Both are sent `finished`.
- A render to two parties waits for both; a party that closes
  mid-render does not hold it up.

`lib/debugger/ui.withdraw.test.ts`, frame tests around a real
`DebuggerUI`: a `waitForCommand` withdrawn mid-wait logs the line and
the next `waitForCommand` takes the next key; the rewind picker open
when withdrawn closes and its promise rejects with `RequestWithdrawn`;
the guard trip form likewise; `parties` puts `with agency debug
session` on the stats line and removes it on the next `parties`
without a CLI.

### Docs in the PR

`docs/dev/cli/debugger-attach.md`: a section "Two parties" with the
first-answer rule, `answered`, `parties`, `describe`, the render
exception, and the withdraw path through `readKey`. `docs/dev/cli/debugger.md`,
"What the program is waiting on": one sentence that the pause message
may come from either party. `docs/site/cli/debug.md`: under attaching,
a paragraph that an agent can be on the run at the same time, what the
activity pane shows, and that a picker closes when the agent answers
first. The user doc for the CLI itself comes in PR 3.

## PR 3. The commands (ADI-11c)

After this PR `agency debug session list`, `attach`, `where`, the
readers, the verbs, and `detach` work from a shell, readable by default
and `--json` on request.

### The readers move out of the UI

`UIState` (`lib/debugger/uiState.ts`) holds `listThreads`,
`listBranches`, `listGuards`, `loopState`, and `getCallStack`, each a
function of the checkpoint it is showing. Move them to
`lib/debugger/readers.ts` as pure functions of `(checkpoint, stop)` and
have `UIState` call them, so the terminal panes and the CLI print the
same facts. First commit of the PR, no behaviour change, the existing
UI tests prove it.

Add to `readers.ts` what the CLI needs and the panes do not have yet:
`frameAt(checkpoint, n)` (args, locals, the statement's location),
`threadMessages(checkpoint, label, last)`, `branchAt(checkpoint, key)`,
`sourceAround(location, context)`, which reads the file at the
location's path when it exists and returns `null` when it does not. The
CLI never imports the compiled module.

### The command files

`lib/cli/debugSession/`, on the pattern of `lib/cli/logsSession/`:

- `register.ts`: `session` under `debug`, one leaf per verb, `--pid` and
  `--json` on each leaf. Read `lib/cli/logsSession/register.ts` for how
  the vendored commander wants this.
- `target.ts`: resolve the pid. One held session and no `--pid` means
  that one; otherwise the flag; otherwise the refusal with the list.
  Reuse `checkedRecord` from `lib/cli/attach.ts` as it is.
- `visit.ts`: the `Visit` the spec describes, over `lineChannel`:
  `open(socketPath)` sends `client cli` and collects `hello`, the
  render, `parties`, the recent log lines, and the pending request;
  `answer(reply)` sends the reply with the pending id and waits for the
  next request, `answered`, or `finished`; `waitForStop(deadline)` for
  `wait`; `close()`. This is the only new protocol logic on the CLI
  side, and it is `serveDebuggerIO` turned inside out.
- `where.ts`: one function of `(hello, checkpoint, stop, parties,
  recent)` to the summary text and its JSON. Tested on fixtures.
- `commands.ts`: one function per verb, each of a `Visit` and its
  arguments, returning `{ text, json, exitCode }`.
- `index.ts`: resolve the target, open the visit, run the verb, print,
  exit. The only file with a socket in it.

`attach` sends the signal when the socket is absent (`attachCommand`
already has this, in the part before the connection; lift it into a
function both commands call) and waits for the first stop. `list` is
`formatListing` with the session column, from a `probe` per live
record, run in parallel with a short timeout so a suspended program
does not hold the listing.

The refusal messages are the spec's, each a constant in `commands.ts`
with a test.

### Tests for the PR

- `lib/debugger/readers.test.ts`: each reader on checkpoints taken from
  the agent-shaped fixture stopped inside `search`.
- `lib/cli/debugSession/where.test.ts`: the summary text for that stop,
  line by line, and its JSON; the running form; the form with a
  terminal attached; the form with the program's own interrupt beside
  the stop.
- `lib/cli/debugSession/commands.test.ts`: every verb against a scripted
  `Visit`; every refusal; the stale-answer refusal from an `answered`;
  `--json` shapes.
- `lib/cli/debugSession/index.test.ts`, end to end on a real socket, the
  way `lib/cli/attach.test.ts` runs its session: a fixture compiled into
  `.agency-tmp` and started with `node`; `list` shows it with `none`;
  `attach`; `where`; `step`; `thread`; `continue`; `wait`; `detach`;
  the child exits 0. A second case with a headless `DebuggerUI`
  attached as well: `list` shows `terminal + held`, the UI's activity
  shows `cli: step`, and a `continue` from the UI makes the CLI's next
  `step` print the stale-answer refusal.

### Docs in the PR

`docs/site/cli/debug.md`: a section "Driving the debugger from a
script" with the commands, the summary, the exit codes, and the two
parties paragraph moved here from PR 2 if it reads better beside the
commands. `docs/dev/cli/debugger-session.md`, new: the visit, the
readers module, the target resolution, and what is tested where; one
line in the `CLAUDE.md` index and in the `agency-cli-docs` skill.

## PR 4. The skill (ADI-11d)

`.claude/commands/debug-run.md`, the spec's eight points in its order,
written for the agent that will read it: short, with the exact commands
and the exact refusals it will see. A paragraph at the end of the
debugger's user doc that an agent can drive the debugger, alone or
beside a person. Run the skill once against a real stuck fixture and
paste the transcript into the PR description, so the reviewer sees what
the agent does with it.

## Order and size

PR 1 is the largest piece of protocol work and the one the others build
on; it is about the size of #1229, and most of it is `sessionRules.ts`
and its table. PR 2 is smaller than it looks: every rule is a row in
the same function and the same table, and the withdraw is one rejection
path through code that already handles rejection. Its size is in its
tests. PR 3 is the most code and
the least risk, since every piece is a pure function of a checkpoint or
a copy of a `logsSession` file. PR 4 is a document.

Each PR is based on `main`. The spec's rule that a command is one visit
and one reply, with the run owning everything between, is the thing to
hold onto in review: any command that keeps state on the CLI across two
connections reopens the conflict question this design closed.
