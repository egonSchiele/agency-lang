# Review: what the program is waiting on, shown while it runs

Reviewed against the code on this branch (`51b26f04e`), the ADI-11 spec on
`debugger-session-spec`, and the debugger dev docs.

## Verdict

The shape is right. A small record instead of a checkpoint, a stack of
open waits rather than a flag, the UI's own clock, and one-way notices on
the channel are all the cheap choices, and the plan says why each one
was made. Three PRs is the right split.

Seven things need to change before anyone builds from it. Two are wrong
descriptions of how the code works today (the record cannot reach the
driver the way the plan says, and the tool site is the wrong step). Two
are design holes (ownership has a side effect, and an attach in the
middle of a long wait shows nothing). One provision is built for a case
that cannot happen. The pause key has four hazards in the key loop. And
the plan leans on an ADI-11 spec that does not say what the plan says it
says.

## Must fix

### 1. The record does not reach the driver "the way stops do"

The plan: "the two calls reach the driver through the slot, the way stops
do". Stops do not go through the slot. `debugStep` returns an interrupt,
which travels up the leg as its result, and the driver sees it either as
the caller (`agency debug`) or through `settleStops` and `attached.run`.
The only runtime-to-driver call that exists today is
`dbg.attached?.ignoring?.(runKey)` in `debugStep`, and that one exists
only when attached.

So PR 1 needs a new way in: a callback field on `DebuggerState`, say
`onBusy: ((entries: BusyEntry[]) => void) | undefined`, which the driver
sets in its constructor. Both drivers must set it, the in-process one and
the attached one, since the in-process debugger shows the same spinner
(`resumeInterrupt` calls `startSpinner` in both). Name this in the plan,
and name the file: the slot is `ctx.debugSlot` in `state/context.ts`, not
`attachedDebugger.ts`, and nothing in it needs to change.

### 2. The tool site is the wrong step

The plan puts the tool's busy and idle "beside the `onToolCallStart` and
`onToolCallEnd` hooks at the same place". Those hooks fire in two
separate steps, `round.N.tool.X.start` and `round.N.tool.X.end`, each
skipped on its own on a resume. The tool itself runs in a third step,
`round.N.tool.X.invoke`, and that is the one that re-runs when a tool's
own interrupt is answered: the `.start` step is already complete and is
skipped, so a busy sent from `.start` would never fire for the second
leg, while the tool is running again.

Put the pair around the `runInvokeStep` call inside the `.invoke` step's
body, in a `try`/`finally`. Then every outcome the body has sends idle:
success, failure, crash, a cancel, and a tool that bails out with its own
interrupt or a debug stop inside it. A resumed invoke sends busy again,
which is right, because the tool is running again.

### 3. `owns()` claims the debugger

The plan: "The run checks `DebuggerState.owns` with its key, as
`debugStep` does". `owns` is not a check. When no run is owned yet, it
makes the caller the owner, throws away the rolling checkpoint window
unless the key continues the last owner, and calls `ownerChanged`, which
clears the pending overrides. Calling it from `debugBusy` means the
first run to start a model call after an attach becomes the debugged
run, before any run has stopped.

With one run that is harmless. With a serve, the plan's own example of
several runs on one module, it changes which run the person ends up
debugging, and does so from a code path nobody thinks of as a stop.

Decide, and write it down. The read-only rule is: report when
`dbg.ownedRun === key`, and before any run is owned, report nothing. That
needs a second method on `DebuggerState` beside `owns`, since `owns` must
keep its side effect for `debugStep`. The cost of the read-only rule is
item 4.

### 4. An attach in the middle of a long wait shows nothing

The moment this feature is for is a program stuck forty seconds into a
model call, and that is the moment it has nothing to say. The attach
opens the debugger waiting for the run's next statement. The model call
began before the debugger existed, so no busy record was sent, and when
the call ends the UI gets an idle for a key it never saw. Until the next
slow thing begins, the bar says `▶ running` with no elapsed figure, and
by then the person has been watching a blank bar for the whole wait they
attached to look at.

Two things follow. The small one: say that an idle whose key is not in
the list is dropped, in the driver, so the UI never sees it.

The bigger one is a decision. The cheap fix is to keep the list of open
waits on the context whether or not a debugger is installed (two tiny
pushes per model call, nothing when nothing is open), and send it when
the run becomes the owned run, with each entry carrying `elapsedMs` as of
the send so the UI can backdate `since`. That keeps "the clock is the
UI's" and still shows `42s` at attach. It also gives ADI-11's `where`
something to print for "running since". If this is deferred, it belongs
in "Not in these PRs", in plain words: attaching during a wait shows
that wait only once the next one begins.

### 5. A stop with open entries cannot come from a tool branch

The plan: "A stop clears nothing: a stop inside a tool call happens while
the tool's model call is still open on another branch, and the list stays
right", and PR 2 puts busy text on the stats bar for that case.

That case does not happen. `PromptRunner.parallel` runs its branches
through `runBatch` in mode `"all"`, which waits for every sibling to
settle before the shared checkpoint is stamped and the frame bails out.
So by the time a stop inside tool A is shown, tool B's model call has
returned, and B's `finally` sent its idle before the stop left the
process. At any stop that comes out of a tool round, the list is empty.

The one place I could not rule out is an `async` call. The halt for an
`interrupt` awaits the pending promises first (`runner.ts:678`), but the
halt a debug stop takes through `maybeDebugHook` does not, so a debug
stop at a root statement may be shown while an `async foo()` is still in
a model call. Check it. If it is real, the stats-bar text is for that
case and the plan should say so; if it is not, drop the stats-bar
provision and add a test that the list is empty at a stop inside a tool
call. Either way the sentence quoted above is wrong and should go.

### 6. The pause key's loop has four hazards

PR 3 adds "a second, smaller loop that reads keys while no command is
awaited and acts on `s` and `n` only, leaving every other key in the
buffer". Each half of that sentence runs into the key machinery as it is.

- **One reader, not two.** `TerminalInput.nextKey()` registers waiters in
  a FIFO. A running-mode loop that is waiting on `nextKey()` when the
  stop arrives keeps its waiter, and the first key the person presses at
  the stop resolves that stale waiter, not `waitForCommand`'s. The key is
  swallowed (or, if it is `s`, calls `stepping()` on a run that is
  already stopped). The fix is one in-flight `nextKey()` promise shared
  by both modes, the pattern `Screen.run` already uses for its tick loop,
  consumed by whichever mode is current.
- **"Leaving a key in the buffer" cannot be done by re-feeding it.**
  `feedKey` goes through `emitKey`, which pushes to the back of the same
  queue the loop reads from. A loop that reads `q`, re-feeds it, and
  reads again gets `q` back at once and spins. Keep a held-keys list on
  `DebuggerUI` that `waitForCommand` drains before it asks the screen.
- **Do not key the pause on the UI's mode.** The plan says the UI calls
  the listener "while the mode is `running`". The UI's mode is stale
  while the program runs: the driver sends `setMode` at the next stop,
  from the mode of the previous command, and nothing is sent on
  `continue`. Key it on "no command is awaited", which the spinner
  already tracks. That also makes `next` over an `llm()` statement
  pausable, which the person wants as much as `continue`; `stepping()`
  clears the step target, so the run-side call is the same.
- **`TestInput.waitForIdle` means "the driver is blocked on a key".**
  `DebuggerTestSession` uses it to tell when a stop has been reached. A
  reader that is live while the program runs makes the input idle during
  a run, and the session's stop detection breaks. Decide how the session
  tells the two apart before writing PR 3's frame test, for example by
  signalling idle only from `waitForCommand`.

Also say in the user doc what pause cannot do: it stops at the next
statement, and a model call in flight is not interrupted, so pressing
`s` during a forty-second request stops the program when the request
returns. The `pausing…` text in the bar is the right place to make that
clear.

### 7. The ADI-11 spec does not say what the plan says it says

Three references need correcting against the spec as it is on
`debugger-session-spec`:

- "the move of that lookup to the run side, which the ADI-11 spec plans".
  The spec plans moving the readers out of `UIState` into a shared
  module. The source map move is in `debugger-future-work.md` ("The
  attached UI imports the program's compiled module for its source map"),
  not in ADI-11. Point at the future-work item.
- "That is also the message the ADI-11 agent command `pause` will send",
  and "the spec is edited to say so". The spec has no `pause` verb at all
  (the word does not appear in it); the Linear ticket lists one but the
  spec's command table starts at `step`. Say that PR 3 adds `pause` to the
  spec, with the message, rather than that the spec already has a
  command waiting for it.
- "so the ADI-11 `where` and `wait` commands print the same words".
  `wait` is a blocking verb that then prints `where`; the one line the
  busy text belongs in is `where`'s "running since <time>; wait stops
  here at the next stop". Name that line.

One more thing from that spec: a held session keeps notices as "the last
twenty activity lines" for the next visit. `setBusy` must be kept as the
latest list, not as lines, or `where` will print a stale wait. Worth one
sentence so whichever PR lands first does the right thing.

## Smaller corrections

- **`lib/debugger/ui.test.ts` does not exist.** The frame tests for
  `DebuggerUI` live in `lib/cli/attach.test.ts` (a `FrameRecorder` and
  `TestInput` around a real `DebuggerUI`) and behind `DebuggerTestSession`
  in `testSession.ts`. Either name one of those or say PR 2 creates the
  file.
- **The exclusions are not `debugStep`'s.** The handler-body and
  callback-body skips are in `PromptRunner.debugStop` and
  `Runner.maybeDebugHook`; `debugStep` checks the node context and
  ownership. Name the right functions, since PR 1 copies them.
- **An older UI does not ignore an unknown notice.** The UI side parses
  every message with `z.enum(NOTICE_METHODS)`, so a `setBusy` notice from
  a newer run fails the schema and fires `malformed`, once per model
  call. Either accept that (both halves ship in one package, as the
  protocol file's comment says) and delete the claim, or make the UI
  side's notice enum open.
- **"Inside those, nothing else" is not true.** `fetch`, `bash`, `sleep`,
  `std::agency run`, image and speech generation, and an interrupt the
  caller is answering are all slow and all unreported. Leaving them out
  is fine; say so under "Not in these PRs", and keep `kind` a string
  union that a third kind joins with one line.
- **A token beats a derived key.** Have `debugBusy` return a number and
  `debugIdle` take it. The step key plus branch path is a string nobody
  else needs, and a rewind that replays the same step key is a collision
  waiting to happen. The whole list still crosses the channel each time,
  so nothing on the UI side changes.
- **Say the mark is the `llm()` line for both kinds.** The example shows
  it, but the "Source pane" section reads as if a tool entry marks the
  tool's body. A tool entry's location is the loop's stop location, so
  `statementStepPath` lands on the statement that called `llm()`.
- **One elapsed formatter.** `ui.ts` already has `formatElapsed` for the
  guards pane (`4m10s`, `30s`, `250ms`). The plan proposes `4.2s` and
  `1m 12s`. Pick one style for the screen, or say why the bar differs.
- **The model body starts before the request.** `llmCall`'s body does
  memory recall (`recallForInjection`) before `_runPrompt`. "Waiting on
  model" is close enough; mention it so the elapsed figure is not read
  as the request's alone.
- **Clearing the list.** "Detach and the end of the run clear it" is
  right for `agency debug`. Attached, the driver outlives a run, and the
  place a new run takes over is `ownerChanged`; `finishedAttached` is
  the other. Name both.
- **Tests to add to PR 1's list:** a cancelled leg (the caller's abort
  signal during a model call) ends with an empty list; a resumed tool
  (`.invoke` re-entered after the caller answers its interrupt) reports
  busy a second time.
- **`bar.agency` is an uncommitted file at the repo root.** Use a fixture
  under `tests/debugger/` for the worked example, or add one.

## What I checked and found right

- `llmCallLabel`, `toolStopLabel`, `checkpointInfo`, and `stepPathFor`
  are where the plan says, and factoring the location out of `debugStop`
  into one private method is a two-line change.
- `stepWithStop` runs the stop before the body, so wrapping only `body()`
  keeps the stop out of the busy window; the bail-out path throws, so a
  `finally` covers it.
- Notices do not touch `keepAlive`, so a busy notice never holds the
  process open, and the channel drops them once closed.
- `NOTICE_METHODS` is the right list to extend, and `serveIO` is a
  one-case addition.
- `UIState.setSourceMap` caches per module, so `busyLine` can share the
  cache; the cross-module caveat ("named in the bar and not drawn") is
  the honest one given that the attached UI loads the compiled module.
- PR 3's run-side half is as small as the plan says: `stepping()` is all
  of it, and the next `debugStep` returns a stop that reaches the driver
  through the path every stop takes.
