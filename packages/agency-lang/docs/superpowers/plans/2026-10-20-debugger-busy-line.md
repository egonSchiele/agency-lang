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
type BusyEntry = {
  /** `model` for a request to the model, `tool` for a call it made. */
  kind: "model" | "tool";
  /** The `llm()` statement, as a loop stop locates it: module, scope, the
   *  statement's step path plus the loop's key, and the branch. */
  moduleId: string;
  scopeName: string;
  stepPath: string;
  branchPath: string[];
  depth: number;
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
job when the person asks for a stop. The record carries the same location
fields as `DebugStopData`, so the UI finds the line the way it finds a
stop's, through the same source map lookup (`UIState.setSourceMap`),
and the move of that lookup to the run side, which the ADI-11 spec
plans, carries this feature with it without a change here.

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

**A stack, not a flag.** A tool call can make a model call of its own,
and a `parallel` block or a fork can have several branches waiting at
once. The run sends `busy` when it enters a slow thing and `idle` with
the same key when it leaves, and the driver keeps the open ones in an
array in the order they began. The UI shows the one that began last in
the bar, with `+2 more` when others are open, and marks every open one's
line in the source pane. A branch that ends through a throw or a
rejection leaves through the same `finally` as a normal return, so a
record is never left open.

**The clock is the UI's.** The elapsed figure counts from when the UI
received the record. Across the channel that is a few milliseconds late
and immune to the two processes disagreeing about the time. The spinner
already redraws the bar every 80ms, so the figure ticks without a timer
of its own.

**The channel gets one notice.** `busy` and `idle` are one-way, so they
are notices in `protocol.ts` alongside `setMode` and the spinner. A UI on
an older build that does not know the notice ignores it, which is the
behaviour notices have today.

**Pausing is a request from the UI.** Today every message from the UI
to the run is a reply to a request, and while the program runs no request
is open. PR 3 adds the first message the UI sends on its own, `pause`,
and the run side turns it into the next stop. That is also the message
the ADI-11 agent command `pause` will send.

## PR 1. The run reports what it is waiting on (ADI-xx a)

### Runtime

- `lib/runtime/debugger.ts`: `debugBusy(run, entry)` and
  `debugIdle(run, key)`. Both return at once and do nothing when no
  debugger is installed, when the debugger does not own the run, when the
  step is in a handler body or a callback body (the same two exclusions
  `debugStep` has, and for the same reason: those have no step a stop
  could show), or when the stack is not a node's. The key is the loop's
  step key for the request or the call, with the branch path, so a
  branch's `idle` matches its own `busy`.
- `lib/runtime/promptRunner.ts`: `llmCall` wraps its body with
  `debugBusy({ kind: "model", label: llmCallLabel(which), ... })` and
  `debugIdle` in a `finally`. The location is the one `debugStop` builds
  from `checkpointInfo` and `stepPathFor(key)`; factor that into one
  private method both use, so the busy record and the stop before it name
  the same place.
- `lib/runtime/prompt.ts`: the tool call's body, where `onToolCallStart`
  and `onToolCallEnd` fire, gets the same pair with `kind: "tool"` and
  `toolStopLabel(name, args)`. A tool that resumes from a checkpoint and
  skips its body reports nothing, as it reports no duration.
- `lib/runtime/attachedDebugger.ts` or wherever the installed debugger's
  slot lives: the two calls reach the driver through the slot, the way
  stops do, as `setBusy(entries: BusyEntry[])` on `DebuggerIO`: the driver
  keeps the array and hands the UI the whole list each time it changes,
  so the UI holds no state the driver does not.

### Driver and IO

- `lib/debugger/types.ts`: `BusyEntry`, and `setBusy(entries)` on
  `DebuggerIO` beside `setMode`.
- `lib/debugger/driver.ts`: `busy(entry)` and `idle(key)` keep the array
  and call `ui.setBusy`. A stop clears nothing: a stop inside a tool call
  happens while the tool's model call is still open on another branch,
  and the list stays right. Detach and the end of the run clear it.
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
  and `setBusy(entries)`, which keeps `since` for an entry already in the
  list, by key, and stamps new ones with `Date.now()`. A second lookup,
  `busyLine(entry)`, finds the line through the same source map path as
  `setSourceMap`; the map is cached per module already.
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
  statement`. The UI's key loop runs only inside `waitForCommand` today,
  so `DebuggerUI` gets a second, smaller loop that reads keys while no
  command is awaited and acts on `s` and `n` only, leaving every other
  key in the buffer for the next stop as now.
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
