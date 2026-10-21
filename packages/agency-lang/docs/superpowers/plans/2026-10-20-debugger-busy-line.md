# Plan: what the program is waiting on, shown while it runs

Linear: one ticket per PR below, on the attach track (P-ADI-1), after
ADI-11.

Three PRs against `main`, each reviewed on its own and each useful alone.
PR 1 makes the run tell its debugger when it enters and leaves a slow
thing, a model request or a tool call, with where that is in the source.
PR 2 shows it: the command bar names the wait and how long it has lasted,
and the source pane marks the line. PR 3 is the pause key, which stops a
running program at its next statement. Smoke the built binary after each
build against a real program with a model call, not only the tests.

Reading before starting: `docs/dev/cli/debugger.md`, the sections on the
runtime side and on stops between tool calls; `docs/dev/cli/debugger-attach.md`
for the channel and its message kinds; `docs/dev/cli/debugger-tests.md`;
`docs/dev/agents/promptRunner.md` for the loop's steps and keys;
`docs/dev/cli/tui/guide/testing.md` for the frame tests PR 2 adds to.

## The idea, and what it is not

While a program runs after `continue`, the debugger shows a spinner with
a random word, "contemplating..." or "computing...", and the source pane
keeps the highlight of the last stop. The one thing a person wants to
know while waiting, what the program is waiting on, is the one thing the
screen does not say.

A moving highlight per statement is the wrong answer. A program visits
thousands of statements a second between its slow parts, a highlight
that moves that fast shows nothing, and reporting every step costs more
than the step. The slow parts are a short list: a model request, a tool
call the model made, and inside those, nothing else. The runtime already
knows when each begins and ends. So the run reports those, a few
messages a minute, each of them news, and says nothing in between.

What a person sees, running `bar.agency` from the attach work, whose
loop makes one model call per iteration:

```
 10    print(i)
 11 ▶  response = llm(
 12      "Write the next line of the story about the talking cat."
 13    )
 14    story += response
```

```
▶ running · in llm() at bar.agency:11 · 4.2s · round 1, waiting on model
```

and during a tool call the model made:

```
▶ running · in llm() at agent.agency:30 · 12s · round 3, in tool fetchPage(url: "https://…")
```

When the call returns the mark goes, and the bar reads `▶ running` until
the next slow thing. At a stop the ordinary highlight takes over. The
elapsed figure is the part people will read most: a model call at forty
seconds says something no highlight can.

## Decisions

**A busy record, not a checkpoint.** The run sends a small record:

```ts
/** Where in the program something is, as a stop and a wait both say it:
 *  the module, the scope, the step path, the branch, and the call depth.
 *  Today these five fields sit inline in `DebugStopData`; they move into
 *  this type, and `DebugStopData` becomes the location plus the stop's
 *  own `label` and `loopStop`. */
type StopLocation = {
  moduleId: string;
  scopeName: string;
  stepPath: string;
  branchPath: string[];
  depth: number;
};

type BusyEntry = {
  /** `model` for a request to the model, `tool` for a call it made. */
  kind: "model" | "tool";
  /** The `llm()` statement, as a loop stop locates it: the statement's
   *  step path plus the loop's key, on the branch the call runs on. */
  location: StopLocation;
  /** The loop's own words for the step: `round 2`, or the tool call with
   *  its arguments cut short, as the stop before it is labelled. */
  label: string;
  /** The run's key, so a UI never shows another run's wait. */
  debugRun: string;
};
```

No checkpoint travels with it. A checkpoint per model call would be
affordable, but the locals and stack panes would then be a second-old
picture presented as current, and the stop's render already does that
job when the person asks for a stop. A wait and a stop share one
location type, so the UI finds a wait's line exactly the way it finds a
stop's, through one lookup (`UIState.setSourceMap`), and the move of
that lookup to the run side, which the ADI-11 spec plans, carries this
feature with it without a change here. Two records with the same five
fields written out twice would drift; one type cannot.

**One wrapper, not a pair of calls.** A site does not call "busy" and
then "idle" in a `finally`. It says what its body is, and one function
does the rest:

```ts
const result = await whileBusy(run, { kind: "model", label, location }, body);
```

`whileBusy` checks that a debugger is installed and owns the run, that
the body is not a handler's or a callback's, records the wait, runs the
body, and clears the wait however the body leaves, by a return, a
throw, or a bail-out. With no debugger it is `await body()` and nothing
else. The rules live in that one place, every site reads as a statement
of what it is, and a third slow thing added later, a subprocess or a
question to a person, is one call and no new rules. Written as a pair
at each site, every site would carry the ownership check, the exclusions,
the key, and the `finally`, and each would be a chance to get one wrong.

**Where it fires.** The sites are the ones the loop's own debugger stops
use, in `lib/runtime/promptRunner.ts`: `llmCall` around the request's
body, and the tool call's body in `lib/runtime/prompt.ts`, beside the
`onToolCallStart` and `onToolCallEnd` hooks at the same place. They
already have the step's label (`llmCallLabel`, `toolStopLabel`) and its
location (`checkpointInfo` and `stepPathFor(key)`). The record is not a
callback in `CallbackMap`: callbacks are the program's and its caller's,
they are composed and relayed from subprocesses, and none of them carries
a source location. The debugger has its own way in, the slot
`ctx.hasDebugger()` guards, and this uses that.

**Only the debugged run reports.** The run checks `DebuggerState.owns`
with its key, as `debugStep` does, so a second run on the same module
says nothing. A run the debugger is stepping reports too: `next` over an
`llm()` statement waits on the same request, and the bar should say so.

**The whole list, every time.** A tool call can make a model call of its
own, and a `parallel` block or a fork can have several branches waiting
at once. The driver keeps the open waits in an array in the order they
began, and each time the array changes it hands the UI the whole array
through `setBusy(entries)`. The UI never sees an "entered" or a "left"
and never has to apply them in order: what it holds is always what the
driver last said is open, which is the shape `setMode` and
`setOverrides` already have. The UI shows the entry that began last in
the bar, with `+2 more` when others are open, and marks every open one's
line in the source pane. A branch that ends through a throw or a
rejection leaves through `whileBusy` as a normal return does, so a wait
is never left open.

**The clock is the UI's.** The elapsed figure counts from when the UI
first saw an entry. Across the channel that is a few milliseconds late
and immune to the two processes disagreeing about the time. The UI's
list is a pure function of the previous list, the new entries, and the
clock, `withSince(previous, entries, now)`: an entry already present by
its key keeps its time, a new one gets `now`, and one that is gone is
dropped. Nothing is mutated in place, so the order the notices arrive in
is the only order there is. The spinner already redraws the bar every
80ms, so the figure ticks without a timer of its own.

**The channel gets one notice.** `busy` and `idle` are one-way, so they
are notices in `protocol.ts` alongside `setMode` and the spinner. A UI on
an older build that does not know the notice ignores it, which is the
behaviour notices have today.

**Pausing is a request from the UI.** Today every message from the UI
to the run is a reply to a request, and while the program runs no request
is open. PR 3 adds the first message the UI sends on its own, `pause`,
and the run side turns it into the next stop. That is also the message
the ADI-11 agent command `pause` will send.

**One key loop, and a table of what each mode accepts.** The UI reads
keys only inside `waitForCommand` today, so while the program runs no
key is read at all, and keys pile up in the terminal's buffer until the
next stop. A second loop that reads keys while running and leaves most
of them in the buffer for the first loop would mean two readers of one
stream, handing off whenever the mode changes, and whether a key reached
the right reader would depend on the exact moment it was pressed. So PR 3
makes one loop that always reads keys and turns each into a command, and
a table says which commands a mode accepts:

| Mode | Accepts | The rest |
| --- | --- | --- |
| stepping | every command | |
| running | `pause` | kept in order for the next stop |

`waitForCommand` becomes "the next command the current mode accepts",
and a command the mode does not accept waits in the UI's own queue, so
`q` pressed while running still detaches at the next stop, as the user
guide promises. The driver sees nothing of this: it registers a pause
listener and receives commands as it does now.

## PR 1. The run reports what it is waiting on (ADI-xx a)

### Runtime

- `lib/runtime/debugger.ts`: `StopLocation`, lifted out of
  `DebugStopData`, which becomes the location plus `label` and
  `loopStop`; `isDebugStop` and the driver's reads of the five fields
  follow. Then `whileBusy(run, entry, body)` as described under
  Decisions: it is `await body()` when no debugger is installed, when the
  debugger does not own the run, when the body is a handler's or a
  callback's (the same two exclusions `debugStep` has, for the same
  reason: those have no step a stop could show), or when the stack is not
  a node's; otherwise it records the wait, runs the body, and clears the
  wait in a `finally`. The wait's key is the loop's step key with the
  branch path, so a branch clears its own.
- `lib/runtime/promptRunner.ts`: `llmCall` passes its body through
  `whileBusy` with `kind: "model"` and `llmCallLabel(which)`. The
  location is the one `debugStop` builds from `checkpointInfo` and
  `stepPathFor(key)`; one private method builds it for both, so the wait
  and the stop before it name the same place.
- `lib/runtime/prompt.ts`: the tool call's body, where `onToolCallStart`
  and `onToolCallEnd` fire, goes through `whileBusy` with `kind: "tool"`
  and `toolStopLabel(name, args)`. A tool that resumes from a checkpoint
  and skips its body reports nothing, as it reports no duration.
- `lib/runtime/attachedDebugger.ts` or wherever the installed debugger's
  slot lives: `whileBusy` reaches the driver through the slot, the way
  stops do. The driver keeps the array of open waits and calls
  `setBusy(entries: BusyEntry[])` on `DebuggerIO` with the whole array
  each time it changes, so the UI holds no state the driver does not.

### Driver and IO

- `lib/debugger/types.ts`: `BusyEntry`, and `setBusy(entries)` on
  `DebuggerIO` beside `setMode`.
- `lib/debugger/driver.ts`: `enterWait(entry)` and `leaveWait(key)`,
  called only by `whileBusy`, keep the array and call `ui.setBusy` with
  it. A stop clears nothing: a stop inside a tool call happens while the
  tool's model call is still open on another branch, and the list stays
  right. Detach and the end of the run clear it.
- `lib/debugger/attach/protocol.ts`: `setBusy` joins `NOTICE_METHODS`.
  `lib/debugger/attach/channelIO.ts` sends it;
  `lib/debugger/attach/serveIO.ts` dispatches it. The UI-side schema for
  the entry is `z.unknown()` like the other notice arguments; the UI
  checks the shape with one type guard before use, as `isDebugStop` does.
- `lib/debugger/testHelpers.ts`: `TestDebuggerIO.busyCalls`, the list
  each `setBusy` received, for the tests.

### Tests

- `lib/debugger/attached.test.ts`, with `withLLMMocks`: a program with
  one `llm()` call, run under `continue`; `busyCalls` holds one entry with
  `kind: "model"`, the statement's module and step path, and `round 1`,
  followed by an empty list. The same with a mocked tool call: `model`,
  then `model` and `tool` together, then `model`, then empty. A stepping
  run (`next` over the statement) reports the same. A second run on the
  module, while the first is debugged, reports nothing.
- A fixture whose tool throws: the list ends empty.
- `lib/debugger/attach/attach.test.ts`: the notice crosses the channel and
  the UI-side `DebuggerIO` sees the same entries.

### Docs

- `docs/dev/cli/debugger.md`: a section "What the program is waiting
  on", with the record, the sites, the ownership rule, and the stack.
- `docs/dev/cli/debugger-attach.md`: the new notice.
- `docs/dev/cli/debugger-tests.md`: the tests above.

## PR 2. The bar names the wait, the source pane marks the line (ADI-xx b)

### UI state

- `lib/debugger/uiState.ts`: `busy: { entry: BusyEntry; since: number }[]`
  and `setBusy(entries)`, which replaces the list with
  `withSince(this.busy, entries, now)`, the pure function under
  Decisions, with the clock injected so a test can advance it. The line
  of a wait comes from the same lookup as a stop's, since both carry a
  `StopLocation`; the source map is cached per module already.
- The wait as one line of text, `busyText(entry, now)`, in a small module
  of its own so the ADI-11 `where` and `wait` commands print the same
  words:
  `in llm() at bar.agency:11 · 4.2s · round 1, waiting on model` for a
  model entry, and `· round 3, in tool fetchPage(url: "…")` for a tool
  entry. Seconds to one decimal under a minute, then `1m 12s`.

### Command bar

- `lib/debugger/ui.ts` `buildCommandBar`: while running, the spinner text
  becomes `▶ running · ` plus `busyText` of the last entry, with
  `· +N more` when others are open, in place of the random phrase. With
  nothing open it reads `▶ running`. The phrases list goes; the frame
  character stays as the sign that the screen is alive. At a stop, when
  the list is not empty (a stop inside a tool call while a model call is
  open on another branch), the stats bar at the bottom shows the same
  text after the usual figures, so the command bar stays the command bar.

### Source pane

- `buildSourceContent`: every open entry's line gets a second style,
  distinct from the stop's magenta: a `▶` in the gutter and a dim
  background, with the elapsed figure at the right edge of the line for
  the entry shown in the bar. A line that is both the stop and busy, when
  the person stops at the loop's own stop before a request, keeps the
  stop's style. The window of twenty lines centres on the stop when there
  is one and on the busy line otherwise, so a running program's pane
  follows the wait.
- A busy entry in another module than the one on screen is named in the
  bar and not drawn, until the person stops there.

### Tests

- The frame tests for the debugger UI (`lib/debugger/ui.test.ts` and the
  TUI testing guide): a running screen with one model entry shows the bar
  text and the marked line; two entries show `+1 more`; the elapsed
  figure advances between two frames with the clock injected; the stop's
  highlight wins on a shared line.
- `busyText` has a table test of its own for the time formats.

### Docs

- `docs/site/cli/debug.md`: a bullet in the list of things to do, and a
  paragraph under attaching: what the bar says while the program runs,
  what the gutter mark means, and that it is not a stop.
- `docs/dev/cli/debugger.md`: the UI half of the section PR 1 added.
- `CHANGELOG.md`, under Unreleased with the attach entries.

## PR 3. The pause key (ADI-xx c)

What it does: while the program runs, pressing `s` stops it at its next
statement, as `step` would from a stop. The same key as stepping, because
"step now" is what a person pressing it means, and because today a key
pressed while running is kept and acted on at the next stop, so `s` is
already the key people press. `n` does the same; the other keys keep
their current meaning of waiting for the stop.

### Mechanism

- `lib/debugger/debuggerState.ts`: `stepping()` already turns the next
  `debugStep` into a stop. Pausing is calling it from the UI side while
  the mode is `running`, and nothing else on the run side changes.
- `lib/debugger/types.ts`: `DebuggerIO.onPause(listener)`: the driver
  registers once, when it goes to running mode, and the UI calls the
  listener when the key is pressed. In-process, the driver's listener
  calls `debuggerState.stepping()` and logs `pausing at the next
  statement`.
- `lib/debugger/ui.ts`: one key loop, started when the UI starts, reads
  every key and turns it into a command through the existing parsing
  (`SIMPLE_KEYS`, `handleInteractiveKey`). The table of what each mode
  accepts, under Decisions, is one object keyed by mode. A command the
  mode accepts is handed on: `pause` to the listener, everything else to
  the caller waiting in `waitForCommand`. A command the mode does not
  accept joins a queue in the UI, and `waitForCommand` takes from that
  queue before reading the loop, so keys pressed while running act at
  the next stop in the order they were pressed, as now. `waitForCommand`
  keeps its signature; the driver changes nothing.
- Attached: `lib/debugger/attach/protocol.ts` gets `{ type: "pause" }`,
  the first message the UI side sends unprompted. `serveIO.ts` sends it
  from the UI's listener; the run side's `ChannelDebuggerIO` receives it
  and calls the driver's listener. A `pause` that arrives at a stop, or
  after the run ended, is dropped.
- The ADI-11 `pause` command sends the same message; the spec is edited
  to say so.

### Tests

- `attached.test.ts`: a program whose node waits on the helper
  (`awaits-helper`) under `continue`; the test calls the IO's pause
  listener, releases the waiter, and the next statement stops, with the
  log line.
- `attach.test.ts`: the message crosses the channel and the run stops.
- A UI frame test: `s` while running is read, the bar reads `pausing…`,
  and `q` pressed while running is still acted on at the stop.

### Docs

- `docs/site/cli/debug.md`: the key, in the attaching section's sentence
  about keys pressed while running.
- `docs/dev/cli/debugger.md` and `debugger-attach.md`: the listener and
  the message.

## Order and what each PR leaves out

PR 1 is useful alone only to tests and to the ADI-11 commands; PR 2 is
what a person sees, so review them close together. PR 3 is independent
of the other two and can go first if the wait is long; its message is the
one ADI-11 needs for `pause`, so whichever of the two lands first adds it
and the other uses it.

Not in these PRs: a highlight per statement; a checkpoint with the busy
record; the busy state of a subprocess started with `std::agency run`,
which has no debugger of its own; a breakpoint on a line, which is the
natural next thing after the pause key and gets its own ticket; and the
move of the source map lookup to the run side, which stays with ADI-11.
