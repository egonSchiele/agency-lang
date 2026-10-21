# Plan: what the program is waiting on, shown while it runs

Linear: one ticket per PR below, on the attach track (P-ADI-1), after
ADI-11. Reviewed in `2026-10-20-debugger-busy-line-review.md`; this is
the plan with the review's corrections in it.

Three PRs, stacked: PR 2 builds on PR 1, PR 3 on PR 2. PR 1 makes the
run tell its debugger when it enters and leaves a slow thing, a model
request or a tool call, with where that is in the source. PR 2 shows it:
the command bar names the wait and how long it has lasted, and the
source pane marks the line. PR 3 is the pause key, which stops a running
program at its next statement. Smoke the built binary after each build
against a real program with a model call, not only the tests.

Reading before starting: `docs/dev/cli/debugger.md`, the sections on the
runtime side, on stops between tool calls, and on how the runtime finds
the debugger; `docs/dev/cli/debugger-attach.md` for the channel and its
message kinds; `docs/dev/cli/debugger-tests.md`;
`docs/dev/agents/promptRunner.md` for the loop's steps and keys;
`docs/dev/cli/tui/guide/testing.md` for frame tests.

## The idea, and what it is not

While a program runs after `continue`, the debugger shows a spinner with
a random word, "contemplating..." or "computing...", and the source pane
keeps the highlight of the last stop. The one thing a person wants to
know while waiting, what the program is waiting on, is the one thing the
screen does not say.

A moving highlight per statement is the wrong answer. A program visits
thousands of statements a second between its slow parts, a highlight
that moves that fast shows nothing, and reporting every step costs more
than the step. The slow parts this plan reports are two: a model request
and a tool call the model made. The runtime already knows when each
begins and ends, so the run reports those, a few messages a minute, each
of them news, and says nothing in between. Other slow things, `fetch`,
`bash`, `sleep`, a subprocess, an image, a question the caller is
answering, are not reported; see "Not in these PRs".

What a person sees, with `tests/debugger/agent-shaped.agency` running
its `main` node, whose `llm()` on line 31 calls tools:

```
 30  node main(task: string): string {
 31 ▶  const answer = llm(task, { tools: [search, writeUp, confirm] })
 32    return answer
 33  }
```

```
▶ running · in llm() at agent-shaped.agency:31 · 4s · round 1, waiting on model
```

and during a tool call the model made:

```
▶ running · in llm() at agent-shaped.agency:31 · 12s · round 2, in tool search(query: "cats", breakHere: false)
```

The mark is on the `llm()` line for both kinds: a tool entry's location
is the loop's, under the statement that called `llm()`, as the loop's
own stops are. When the call returns the mark goes, and the bar reads
`▶ running` until the next slow thing. At a stop the ordinary highlight
takes over. The elapsed figure is the part people will read most: a
model call at forty seconds says something no highlight can.

## Decisions

**A wait record, not a checkpoint.** The run sends a small record:

```ts
/** Where in the program something is, as a stop and a wait both say it:
 *  the module, the scope, the step path, the branch, and the call depth.
 *  Lifted out of `DebugStopData`, which becomes the location plus the
 *  stop's own `label` and `loopStop`. */
type StopLocation = {
  moduleId: string;
  scopeName: string;
  stepPath: string;
  branchPath: string[];
  depth: number;
};

type BusyEntry = {
  /** Tells one wait from another across the channel; a number the run
   *  hands out, never derived from the step key, which a rewind that
   *  replays the same step would repeat. */
  token: number;
  /** `model` for a request to the model, `tool` for a call it made. A
   *  string union, so a third kind is one line. */
  kind: "model" | "tool";
  /** The `llm()` statement, as a loop stop locates it: the statement's
   *  step path plus the loop's key, on the branch the call runs on. */
  location: StopLocation;
  /** The loop's own words for the step: `round 2`, or the tool call with
   *  its arguments cut short, as the stop before it is labelled. */
  label: string;
  /** The run's key, so a UI never shows another run's wait. */
  debugRun: string;
  /** How long the wait has been open when the record was sent, so a UI
   *  that joins late can backdate its clock. */
  elapsedMs: number;
};
```

No checkpoint travels with it. A checkpoint per model call would be
affordable, but the locals and stack panes would then be a second-old
picture presented as current, and the stop's render already does that
job when the person asks for a stop. A wait and a stop share one
location type, so the UI finds a wait's line exactly the way it finds a
stop's, through one lookup (`UIState.setSourceMap`). The item in
`debugger-future-work.md` about the attached UI importing the compiled
module for its source map is unchanged by this feature and carries it
along when it is done.

**One wrapper, not a pair of calls.** A site does not call "busy" and
then "idle" in a `finally`. It says what its body is, and one function
does the rest:

```ts
const result = await whileBusy(run, stack, { kind: "model", label, location }, body);
```

`whileBusy` (`lib/runtime/debugger.ts`) opens the wait, runs the body,
and closes the wait however the body leaves, by a return, a throw, or a
bail-out. It is `await body()` alone when the body is a handler's or a
callback's, the exclusions `Runner.maybeDebugHook` and
`PromptRunner.debugStop` make, for the same reason: those have no step a
stop could show. With a third slow thing later, a subprocess or a
question, the site is one call and no new rules.

**The waits live on the module's debug slot, with or without a
debugger.** `ctx.debugSlot` (`state/context.ts`) is the holder every
execution context of a module shares, which is where the runtime finds
the debugger. It gains `waits: OpenWait[]`, the open waits of every run
of the module, each with the run's key and the time it began. Keeping
them costs two small pushes per model call and nothing when nothing is
open. That is what makes the moment this feature is for work: a person
attaches to a program forty seconds into a model call. The wait began
before any debugger existed, but it is on the slot, so the moment the
debugger is installed the run reports it, with `elapsedMs` as of the
send, and the bar shows `42s` at once instead of a blank until the next
call begins.

**How the record reaches the driver.** Not the way stops do. A stop is
an interrupt because it pauses the program: `debugStep` returns it up
the leg as the result, and the driver answers it with a resume. A wait
pauses nothing, so it must not be an interrupt, and giving it the
interrupt shape would make the one runtime concept that means "suspended
until answered" also mean "not suspended at all". The runtime already
holds the driver's `DebuggerState` in the slot, and makes one direct
call into it today, `dbg.attached?.ignoring?.(runKey)` in `debugStep`.
The wait uses the same door: `DebuggerState` gains
`onWait: ((entries: BusyEntry[]) => void) | undefined`, which both
drivers set when built, the in-process one and the attached one, since
both show the spinner. `reportWaits(slot)` builds the list to show and
calls it. Three things call `reportWaits`: `whileBusy` after it opens
and after it closes a wait; `debugStep` when a run takes the debugger,
so the list narrows to that run; and the `debuggerState` setter on the
context, so a debugger installed mid-wait is told at once.

**Reporting never claims the debugger.** `DebuggerState.owns` is not a
check: the first run to call it becomes the owner, the window is reset,
and `ownerChanged` fires. A wait must never do that, or the first run to
start a model call after an attach would become the debugged run from a
code path nobody thinks of as a stop. So `DebuggerState` gets a second,
read-only method beside `owns`, `showsRun(key)`: not attached, every
run; attached with no owner yet, every run, since the debugger is
nobody's and what the process is doing is what it should show; attached
with an owner, that run only. `reportWaits` filters the slot's waits by
it. When a run takes the debugger at its first stop, `debugStep` reports
again, and the list narrows from every run's waits to the owner's.

**The whole list, every time.** A tool call can make a model call of its
own, and a `parallel` block or a fork can have several branches waiting
at once. Each report hands the UI the whole list of open waits through
`setBusy(entries)`. The UI never sees an "entered" or a "left" and never
has to apply them in order, which is the shape `setMode` and
`setOverrides` already have, and a close for a wait the UI never saw is
nothing to handle. The UI shows the entry that began last in the bar,
with `+2 more` when others are open, and marks every open one's line in
the source pane.

**The clock is the UI's.** The elapsed figure counts from the time the
UI first saw an entry, less the `elapsedMs` it arrived with. Across the
channel that is a few milliseconds late and immune to the two processes
disagreeing about the time. The UI's list is a pure function of the
previous list, the new entries, and the clock, `withSince(previous,
entries, now)`: an entry already present by its token keeps its time, a
new one gets `now - elapsedMs`, and one that is gone is dropped. Nothing
is mutated in place. The spinner already redraws the bar every 80ms, so
the figure ticks without a timer of its own. One formatter,
`formatElapsed` from the guards pane (`4s`, `1m12s`), so the screen has
one style.

**What "waiting on model" covers.** The model step's body does memory
recall (`recallForInjection`) before the request itself, so the elapsed
figure is the step's, not the request's alone. Close enough, and said in
the doc.

**A stop with open waits.** `PromptRunner.parallel` runs tool branches
through `runBatch` in mode `all`, which settles every sibling before the
shared checkpoint is stamped, so at any stop that comes out of a tool
round the list is empty, and PR 1 has a test that says so. The one case
where a stop and an open wait coexist is an `async` call: the halt a
debug stop takes through `maybeDebugHook` does not await the pending
promises (the halt for a program's own interrupt does), so a stop at a
root statement can be shown while an `async foo()` is still in a model
call. PR 2 puts the wait text on the stats bar at a stop for that case,
and the command bar stays the command bar.

**The channel gets one notice.** `setBusy` is one-way, so it is a notice
in `protocol.ts` beside `setMode` and the spinner. Both halves of the
channel ship in one package, as the protocol file says, so no claim is
made about an older UI.

**Pausing is a request from the UI.** Today every message from the UI
to the run is a reply to a request, and while the program runs no request
is open. PR 3 adds the first message the UI sends on its own, `pause`,
and the run side turns it into the next stop. The ADI-11 spec has no
`pause` verb yet; PR 3 adds one to its command table, sending this
message.

**One reader of the key stream.** The UI reads keys only inside
`waitForCommand` today, so while the program runs no key is read at all,
and keys pile up in the terminal's buffer until the next stop. PR 3
wants `s` read while the program runs. Four things about the key
machinery decide how:

- `TerminalInput.nextKey()` registers waiters in a FIFO. A second loop
  waiting on `nextKey()` when the stop arrives keeps its waiter, and the
  first key at the stop resolves that stale waiter, not
  `waitForCommand`'s. So there is one in-flight `nextKey()` promise,
  shared, the pattern `Screen.runLoop` uses for its tick loop, and one
  dispatcher that hands each key to whoever is current.
- A key cannot be "left in the buffer" by feeding it back: `feedKey`
  pushes to the back of the queue the dispatcher reads from, and a loop
  that re-feeds `q` reads it again at once. Keys pressed while running
  that are not the pause key go into a held list on `DebuggerUI`, which
  `waitForCommand` drains before it asks the screen, so `q` pressed while
  running still detaches at the next stop, in order, as the user guide
  promises.
- The pause is not keyed on the UI's mode. The UI's mode is stale while
  the program runs: the driver sends `setMode` at the next stop, and
  nothing on `continue`. It is keyed on "no command is awaited", which
  is true from the spinner's start to the next `waitForCommand`. That
  also makes `next` over an `llm()` statement pausable, which a person
  wants as much as `continue`; `stepping()` clears the step target, so
  the run-side call is the same.
- `TestInput.waitForIdle` means "the driver is blocked on a key", and
  `DebuggerTestSession` uses it to tell when a stop has been reached. A
  reader that is live while the program runs would make the input idle
  during a run and break that. So the session's signal moves to the UI:
  `DebuggerUI.onCommandAwaited(listener)` fires when `waitForCommand`
  starts waiting, and the session waits on that.

## PR 1. The run reports what it is waiting on (ADI-xx a)

### Runtime

- `lib/runtime/debugger.ts`: `StopLocation`, lifted out of
  `DebugStopData`; `isDebugStop` and the driver's and UI's reads of the
  five fields follow. `BusyEntry` and `OpenWait` (the entry without
  `elapsedMs`, with `startedAt`). `whileBusy(run, stack, wait, body)` as
  under Decisions: a handler's or a callback's body runs plain; otherwise
  the wait is pushed on `run.ctx.debugSlot.waits` with a fresh token and
  `Date.now()`, reported, and removed and reported again in a `finally`.
  `reportWaits(slot)`: nothing without a state or an `onWait`; else the
  slot's waits that `showsRun` accepts, as entries with `elapsedMs`.
- `lib/runtime/state/context.ts`: `DebugSlot` gains `waits`, the
  `debuggerState` setter calls `reportWaits` after installing a state.
- `lib/debugger/debuggerState.ts`: `onWait` and `showsRun(key)`.
- `debugStep`: after `owns` returns true, when `ownedRun` was null before
  the call, `reportWaits(ctx.debugSlot)`.
- `lib/runtime/promptRunner.ts`: `llmCall` passes its body through
  `whileBusy` with `kind: "model"` and `llmCallLabel(which)`. The
  location is the one `debugStop` builds from `checkpointInfo` and
  `stepPathFor(key)`, with the stack's branch path and the run's depth;
  one method, `loopLocation(key, run)`, builds it for both, and is public
  with `toolStopLabel` so the tool site can use them.
- `lib/runtime/prompt.ts`: the `.invoke` step's body, the
  `runInvokeStep` call, goes through `whileBusy` with `kind: "tool"`.
  Not beside the `onToolCallStart` and `onToolCallEnd` hooks: those are
  the `.start` and `.end` steps, each skipped on its own on a resume,
  while the tool itself runs in `.invoke`, the step that re-runs when the
  tool's own interrupt is answered. So a resumed tool reports a second
  wait, which is right, since the tool is running again, and every
  outcome of the body, success, failure, crash, cancel, bail-out, closes
  it. A tool that resumes from a checkpoint and skips its body reports
  nothing, as it reports no duration.

### Driver and IO

- `lib/debugger/types.ts`: `BusyEntry` re-exported, and
  `setBusy(entries: BusyEntry[])` on `DebuggerIO` beside `setMode`.
- `lib/debugger/driver.ts`: the constructor sets
  `debuggerState.onWait = (entries) => this.ui.setBusy(entries)`, with
  the `detachedNow` guard the callbacks use. Nothing is kept on the
  driver. Attached, the list narrows on `ownerChanged` through the
  `debugStep` report, and `finishedAttached` sends an empty list, since
  the run that ended has no waits.
- `lib/debugger/attach/protocol.ts`: `setBusy` joins `NOTICE_METHODS`.
  `channelIO.ts` sends it; `serveIO.ts` dispatches it. The entry crosses
  as `z.unknown()` like the other notice arguments; the UI side keeps
  the list as is.
- `lib/debugger/ui.ts`: `setBusy` stores the list on `UIState`; PR 2
  draws it.
- `lib/debugger/testHelpers.ts`: `TestDebuggerIO.busyCalls`, every list
  `setBusy` received, for the tests.

### Tests, in `lib/debugger/attached.test.ts` with `withLLMMocks`

- `llm-after-step`: under `continue`, `busyCalls` is one list with one
  `model` entry, the statement's module and step path, `round 1`, then
  an empty list. The same under `next` over the statement.
- `agent-shaped` with a tool call mocked: the lists go `model`, empty,
  `tool`, empty, `model`, empty, in that order, since the loop's
  request step closes before the tool round opens.
- `agent-shaped` with the `confirm` tool, whose interrupt the caller
  answers: the resumed `.invoke` reports a second `tool` wait.
- A stop inside a tool (`search` with `breakHere`): `busyCalls` at the
  stop's render is empty.
- A second run on the module while the first is debugged: the second
  run's waits are not reported after the first run's stop; before any
  stop, both runs' waits are.
- A debugger installed while a wait is open (`awaits-helper` is not a
  model call, so a mocked tool that waits on the helper does it): the
  first `setBusy` after `attach()` carries the open wait with an
  `elapsedMs` above zero.
- A cancelled leg, the caller's abort signal during a model call, ends
  with an empty list.
- `lib/debugger/attach/attach.test.ts`: the notice crosses the channel
  and the UI-side `DebuggerIO` sees the same entries.

### Docs

- `docs/dev/cli/debugger.md`: a section "What the program is waiting
  on", with the record, the wrapper, the slot's list, the read-only
  ownership rule, the three report sites, and the one case of a stop
  with an open wait.
- `docs/dev/cli/debugger-attach.md`: the new notice.
- `docs/dev/cli/debugger-tests.md`: the tests above.

## PR 2. The bar names the wait, the source pane marks the line (ADI-xx b)

### UI state

- `lib/debugger/uiState.ts`: `busy: BusyShown[]`, where `BusyShown` is
  the entry and its `since`, and `setBusy(entries, now)`, which replaces
  the list with `withSince(this.busy, entries, now)`, the pure function
  under Decisions, in `lib/debugger/busy.ts` with its own table test.
  The line of a wait comes from the same lookup as a stop's, since both
  carry a `StopLocation`: `lineFor(location)`, factored out of
  `setSourceMap`, reading the per-module cache, and `setBusy` fills the
  cache for a module not seen yet and redraws when it has.
- `busyText(entry, now)` in `busy.ts`, so the ADI-11 `where` line
  "running since <time>; wait stops here at the next stop" can print
  the same words: `in llm() at agent-shaped.agency:31 · 4s · round 1,
  waiting on model` for a model entry, `· round 2, in tool search(...)`
  for a tool entry, with `formatElapsed` for the figure.

### Command bar

- `lib/debugger/ui.ts` `buildCommandBar`: while running, the spinner text
  becomes `▶ running · ` plus `busyText` of the last entry, with
  `· +N more` when others are open, in place of the random phrase. With
  nothing open it reads `▶ running`. The phrases list goes; the frame
  character stays as the sign that the screen is alive. At a stop with
  the list not empty, the `async` case, the stats bar shows the same text
  after the usual figures.

### Source pane

- `buildSourceContent`: every open entry's line gets a second style,
  distinct from the stop's magenta: a `▶` in the gutter and a dim
  background, with the elapsed figure at the right edge for the entry
  shown in the bar. A line that is both the stop and busy keeps the
  stop's style. The window of twenty lines centres on the stop when there
  is one and on the busy line otherwise, so a running program's pane
  follows the wait. A wait in another module than the one on screen is
  named in the bar and not drawn.

### Tests

- `lib/debugger/ui.busy.test.ts`, new, with a `FrameRecorder` and a
  `TestInput` around a real `DebuggerUI` as `lib/cli/attach.test.ts`
  does: a running screen with one model entry shows the bar text and the
  marked line; two entries show `+1 more`; the elapsed figure advances
  between two frames with the clock injected; the stop's highlight wins
  on a shared line; a stop with an open entry puts the text on the stats
  bar.
- `busy.test.ts`: `withSince` keeps, backdates, and drops; `busyText`
  for both kinds.

### Docs

- `docs/site/cli/debug.md`: a bullet in the list of things to do, and a
  paragraph under attaching: what the bar says while the program runs,
  what the gutter mark means, that it is not a stop, and that the
  figure is the step's, memory recall included.
- `docs/dev/cli/debugger.md`: the UI half of the section PR 1 added.
- `CHANGELOG.md`, under Unreleased with the attach entries.

## PR 3. The pause key (ADI-xx c)

What it does: while the program runs, pressing `s` stops it at its next
statement, as `step` would from a stop; `n` does the same. The same key
as stepping, because "step now" is what a person pressing it means, and
because today a key pressed while running is kept and acted on at the
next stop, so `s` is already the key people press. The other keys keep
their meaning of waiting for the stop. A model call in flight is not
interrupted: `s` during a forty-second request stops the program when
the request returns, and the bar says `pausing at the next statement`
until then.

### Mechanism

- `lib/debugger/debuggerState.ts`: `stepping()` already turns the next
  `debugStep` into a stop. Pausing is calling it while the mode is
  `running`, and nothing else on the run side changes.
- `lib/debugger/types.ts`: `DebuggerIO.onPause(listener)`. The driver
  registers once, in its constructor; the listener calls
  `debuggerState.stepping()` and logs `Pausing at the next statement`
  when a leg is running, and is dropped at a stop or after the run
  ended (`legRunning`, set around `resumeInterrupt`).
- `lib/debugger/ui.ts`: one reader, as under Decisions. `readKey()`
  holds the single in-flight `nextKey()`; a dispatcher hands the key to
  the waiting `waitForCommand` when there is one, else to the pause
  listener when it is `s` or `n` and no command is awaited, else to the
  held list. `waitForCommand` drains the held list first and keeps its
  signature; `onCommandAwaited(listener)` fires when it starts waiting.
  `DebuggerTestSession` waits on that instead of `TestInput.waitForIdle`.
- Attached: `lib/debugger/attach/protocol.ts` gets `{ type: "pause" }`,
  the first message the UI side sends unprompted. `serveIO.ts` registers
  the UI's listener to send it; the run side's `ChannelDebuggerIO`
  receives it and calls the driver's listener.
- The ADI-11 spec's command table gains `pause`, sending this message;
  that edit goes to the spec's PR.

### Tests

- `attached.test.ts`: a program whose node waits on the helper
  (`awaits-helper`) under `continue`; the test calls the IO's pause
  listener, releases the waiter, and the next statement stops, with the
  log line. A pause called at a stop changes nothing.
- `attach.test.ts`: the message crosses the channel and the run stops.
- `ui.busy.test.ts`: `s` while running reaches the listener and the bar
  reads `pausing`; `q` pressed while running is acted on at the stop;
  `s` at a stop is a step, not a pause.

### Docs

- `docs/site/cli/debug.md`: the key, in the sentence about keys pressed
  while running, and what pause cannot do.
- `docs/dev/cli/debugger.md` and `debugger-attach.md`: the reader, the
  listener, and the message. `debugger-tests.md`: the session's new
  wait.

## Order and what each PR leaves out

PR 1 is useful alone only to tests and to the ADI-11 commands; PR 2 is
what a person sees, so review them close together. PR 3 is independent
of the other two in mechanism but builds on PR 2's bar text for its
`pausing` line, so it sits on top. A stacked PR gets no CI until its
base is merged and it is retargeted to `main`.

Not in these PRs: a highlight per statement; a checkpoint with the wait
record; the other slow things, `fetch`, `bash`, `sleep`, `std::agency
run`, image and speech generation, and an interrupt the caller is
answering, each of which is one `whileBusy` call and one `kind` when
wanted; the waits of a subprocess started with `std::agency run`, which
has no debugger of its own; a breakpoint on a line, which is the natural
next thing after the pause key and gets its own ticket; and the move of
the source map lookup to the run side, which stays in
`debugger-future-work.md`.
