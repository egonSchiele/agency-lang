# Review: log viewer comments and live sessions

Reviewed `2026-10-19-log-viewer-comments-and-sessions.md` against the spec and
the code it cites, on 2026-10-19. The overall shape is right. Comments live in
run-directory code, so graders keep them if the viewer feature goes away. The
session sits in one directory behind one small port. Each command works out its
target in one place. The problems are in the wiring: several sentences assume
seams or helpers that do not exist, or that work differently from what the plan
says. Below is what I would change before starting, most important first.

## Summary

- **An agent's comment sent through the session is saved under the person's
  name.** The port's `addComment` is `commentsSource.add`, and that store's
  author is fixed to the human when the viewer opens. Drop the socket's
  `comment` request. The CLI writes with its own agent-author store and then
  sends `reload`.
- **The CLI cannot find a session's comments file.** The registry record holds
  only `logPath`, and you cannot tell from `.../statelog.jsonl` whether the
  comments go in a run directory or in a sidecar file. Put `commentsPath` in the
  record.
- **Every viewer test would start a real socket server in `~/.agency-agent`.**
  The session starts whenever `followPath` is set, and four test files set it.
  Make the session opt-in through an option that names the sessions directory.
- **`a` is already bound** on the trace and timeline screens (it toggles admin
  rows). A shell binding on `a` would take over that key with no warning, and
  the `duplicateKeys` test would not catch it.
- **`safeDeleteFile` cannot delete registry files.** It runs as a dry run by
  default. It refuses anything outside the project root, and it refuses a
  socket because a socket is not a regular file.
- **A suspended viewer would hang `session list`, and the probe would then
  delete its record.** The probe needs a timeout, and "no answer in time" is
  not the same as "stale".
- **Three new things redraw the screen while the `c` prompt is open:** the
  comments refresh, the follow poll, and session requests. Each one would paint
  over the line the person is typing.
- **Task 1's error path does not exist.** `ViewerResolution` is
  `"quit" | "back"`, and nothing carries a result from the viewer back to
  `exitWithError`. `logs view` also cannot declare `--trace-id` a second time.
- **A shell binding's return value is thrown away**, so a `c` binding that
  returns `promptLine` does nothing.
- **The follow poll only calls back when the log grows**, so "refresh comments
  on the follow timer" needs a change to the watcher.

## Task 1: `--trace-id`

**The flag goes on `logs` only.** The comment at `scripts/agency.ts:972`
explains why: the vendored commander gives the parent priority, so a second
declaration on `view` would receive `undefined`, and the fork now rejects that
shape when the command is registered. Read it from `command.parent?.opts()`, the
way `view` already reads `--follow`.

**The plan's error path needs three signature changes it does not mention.**
`ViewerResolution` is `"quit" | "back"` (`run.ts:68`), and the runs explorer
checks it with `resolution === "quit"`. `createViewerHost` returns `void`, so
does `viewStatelogFile`, and `logsView` never sends anything from `viewFile` to
`onError`. To make "resolves with a failure, and the CLI prints it" work, the
failure has to pass through all three layers.

I would do the check in `logsView.ts`, before the terminal is set up, and accept
reading the file once more. The plan's reason for avoiding that ("one parse")
does not hold up:

- For a run directory, `viewRunDirectory` already calls `readRunDirectory`,
  which parses the statelog, so `snapshot.traces` has the IDs with no extra
  parse.
- For a loose file, `findTrace` in `runDirectory/extractTrace.ts` already reads
  traces out of a file.
- Checking before the terminal opens means the error prints as plain text. It
  does not flash the alternate screen first.

**Skip the check under `--follow`.** Someone running `agency logs run.jsonl -f
--trace-id k3Pq9abc` on a log being written may name a trace that has not
started yet. In that case also watch `host.setData` (`run.ts:220`). It falls
back to the most recent trace whenever the focused trace is not in the file, so
in a file with several traces the focus jumps away on the first poll. A test
should check that the named trace keeps focus once it appears.

**Cases the plan leaves out:**

- Stdin is a `kind: "text"` source. `ViewerSource` needs `focusTraceId` on both
  kinds, and so does `viewerOptions`.
- `--trace-id` together with `--csv`, or with paths that open the explorer,
  should be refused, the way `--follow` is.

## Task 2: Addresses and the copy key

**Split an address on the last slash, not the first.** A trace ID is not
always a nanoid. `context.ts:345` takes it from statelog config or from the
`TRACE_ID_ENV` variable first, and hosted invocations can set their own. A row
ID never contains a slash: its parts are nanoid span IDs, ordinals, and fixed
event types. Say this in the "Row IDs are a contract" section.

**One shell binding instead of four screen bindings.** Every screen has
`focusId()` (`screens/screen.ts`), and `host.screen(host.activeScreen())` gives
the active one. A single `A` in `viewerShellBindings` covers all four screens.
It is also the same lookup the session's `get` uses, so the two cannot drift
apart. (A shell binding's result is currently thrown away; see Task 4.)

**A correction that does not change the advice.** "Nothing in the viewer parses
one today" is wrong. `parseRoundId` in `timeline/rounds.ts` exists and is used
by the trace, transcript, and timeline screens. The advice not to add a general
row-ID parser still stands.

**The clipboard test.** `run.shell.test.ts` has no recorded clipboard. Follow
`copyTrace.test.ts`, which mocks `./clipboard.js` with `vi.mock`.

## Task 3: The comments store

**Drop resolve rows from version 1, or add a way to write them.** No command
and no key writes a `Resolve` row, and `CommentsStore` has only `add`. As
written, the fold's resolve logic and its "undone by a later row" test cover
data nothing can produce. My preference is to drop it and add
`comment resolve <id>` later if it turns out to be needed.

**Anchors are written but never read.** The spec requires that "a comment whose
row ID no longer resolves is reported as re-anchored, not dropped", and lists a
test for it. The plan builds anchors in `anchorFor` and then never uses them.
Either add the lookup (in `foldComments`'s caller, given the trace) with its
test, or drop anchors from the record and the spec until a row-ID change
actually happens.

**Stdin and remote logs.** Task 4 gives stdin no store, which contradicts the
spec's `<agent home>/log-comments/<trace id>.jsonl`. That leaves the
`{ kind: "trace" }` branch of `commentsPathFor` with no caller. Drop the branch
and record the decision in the spec. Stdin with no comments is a fine first
version.

**The lock and the append.**

- `withWriter` re-reads the whole run directory twice per write
  (`mutations.ts:595`). For a comment, that means parsing the statelog twice in
  order to append one line. And `readRunDirectory` is run-directory-only.
- A loose file's sidecar has no run directory. `acquireRunDirLock({ dir })` on
  the folder holding the loose file would leave a `.lock` in whatever folder
  that is.

Let the comments path decide the lock. A run directory uses its `.lock`. A
sidecar uses `acquireOwnedFileLock` on `<sidecar>.lock`. The write itself is
`repairTornTail` plus `appendDurably`, with no snapshot. `appendRows` is
annotation-typed and checks content-derived IDs, so a sibling function is the
right call here.

**Wrapping copies; it does not move.** `wrapTracesAsRunDirectories` leaves the
source statelog in place, so the sidecar should stay unchanged too. Never
rewrite it. The test "leaves other traces' rows in the sidecar" reads as if the
sidecar is rewritten; make it "the sidecar is byte-for-byte unchanged". Also put
the comment rows into `RunDirectoryAssemblyPlan`, beside `annotationDrafts`, so
they are written inside the staging directory. A child run is meant to be whole
or absent, and copying the comments in a separate step afterwards breaks that.

**`humanFeedbackFor`.**

- It returns early when a trace has no annotations (`humanFeedback.ts:30`).
  Push the comments before that line, or a trace with comments and no
  annotations loses them.
- `notes` is a `string[]`, so "after the `notes.md` text" means "pushed after
  the `notes.md` entry".
- `<row id>: <text>` is a poor format for an optimizer's model, because
  `round:span-7f3a:2` means nothing to it. Use the anchor:
  `reviewer · gpt-5 call: why does it read the config a second time here?`.

**`annotationSummaryText`** is called only from `logsView.ts:376`, so changing
it affects nothing else. But see Task 4 on where the count should come from.

## Task 4: Comments in the viewer

**`a` collides.** `traceScreen.ts:176` and `timelineScreen.ts:244` bind `a` to
"toggle admin rows". In `runKeyLoop`, a matching shell binding runs instead of
the screen's (`run.ts:436`), so admin rows could no longer be toggled. The
existing `duplicateKeys` test (`run.shell.test.ts:490`) checks only the shell's
own list. Pick another key (`m` and `N` are taken on the trace screen; `C` is free), and extend the
test to check the shell's keys against each screen's keys.

**A shell binding's result is discarded.** `runKeyLoop` calls `binding.run()`
and ignores what it returns, so a `c` binding that returns a `promptLine` action
never opens the prompt. Either dispatch the result there (a one-line change, and
then `A` can return `copy` too), or have `c` and `A` call the shell's handlers
directly.

**The `c` prompt is painted over.** `handleTraceExtract` stops the follow
watcher during its prompt "so an append cannot repaint over it". The `c` prompt
would have three new sources of redraws: the comments refresh, the follow poll,
and session requests. Rather than pausing each one, give the shell one flag: a
`render()` called while a `promptLine` is open only marks the screen as dirty,
and the screen is drawn once when the prompt closes. That also fixes the same
problem for the trace screen's `/` search prompt, which today is not protected
from follow.

**"The follow poll calls `refresh` on its timer" needs a watcher change.**
`poll` calls back only when the log grew or shrank (`run.ts:634`). A comment
added from another terminal while the log is idle would never show. Either
give the watcher a second callback that runs on every tick, or run a separate
timer. In both cases, compare the comments file's size before re-reading and
folding it, since the timer fires every 250ms.

**`setMarks` is in the wrong file.** The `View` type is in `views/view.ts`.
`views/shared.ts` holds the timeline's drawing helpers. TypeScript types have no
default methods, so make it optional (`setMarks?(marks: RowMarks): void`), the
way `escape?` and `capturesText?` are, and have `ScreenHost` call it with `?.`.
Put the "send marks to every view" step on `ScreenHost`, next to `setData`. It
already loops over every screen and overlay.

**`anchorFor` needs a row, and the shell has only an ID.** Add one function,
`findRow(trace, rowId): StoryRow | undefined`, over `outlineRows` with admin and
machinery rows included, so that hidden rows still resolve. Then use it in all
three places that need it: `anchorFor` here, `navigate`'s "no such row" in
Task 5, and `expandRow` in Task 6.

**Agent replies are hidden by default.** The skill's step 2 tells the agent to
answer each of the person's comments with `--reply-to`. With the toggle off, the
person sees their own question and not the answer. Hunk's rule was about
unprompted agent notes. I suggest that a reply to a human comment always shows
under that comment, and the toggle hides only agent comments that are not
replies.

**The comment count in the picker.** Passing the count through the CLI's
annotation string has two problems:

- Loose files get no `traceAnnotations` at all, so they never show a count.
- The string is built once at open, so the count is stale after the first `c`.

The viewer already has every mark, so build the count from the marks inside
the viewer, and leave `annotationSummaries` alone.

**The explorer.** `runsExplorer/run.ts:257` calls `runViewer` with no comments
store. "The explorer gets this with no change" is true for the session, but not
for comments: `c` would say "unavailable" on a drill-in, which the spec lists as
a run-directory case. Pass a store from the explorer, built from the run
directory it drilled into, or list this as a known gap.

**Where `c` works.** Give it a `when`: not while typing, and only on a screen.
Decide whether it also works on the detail overlay, which shows one row and is
an obvious place to leave a comment.

## Task 5: The session server

**Drop the `comment` request.** With `port.addComment = commentsSource.add`:

- The author comes from the viewer's store, which is the human. The request's
  `author` field has nowhere to go.
- `commentsSource.add(rowId, text)` takes no trace ID, so a comment on another
  trace would be saved against the current one.
- Task 6 already writes through the CLI's own store and sends `reload`
  (`index.test.ts`: "comment add makes the viewer reload"). That makes two write
  paths, and only one of them is tested.

Keep `reload`, and remove `comment` from the protocol and `addComment` from the
port. That is also closer to the spec's sentence "the server never touches a
file".

**Put `commentsPath` in the registry record.** The CLI's session target needs to
open a store on the same file the viewer uses. It cannot work that out from
`logPath` alone, and when it is a run directory its statelog is called
`statelog.jsonl`, not `log.jsonl` as the spec's example shows. If the viewer has
no store (an explorer drill-in today), leave the field out, and comment commands
on that session should say so.

**Make the session opt-in.** The plan only says "`opts.session !== false`"
without defining the option. `run.shell.test.ts`, `followMode.test.ts`,
`runsExplorer/run.test.ts`, and `logsView.test.ts` all pass `followPath`, so
every one of them would open a socket and write a record under the real
`~/.agency-agent`. Add `session?: { dir: string }` to `RunViewerOpts`, where no
value means no session. `logsView.ts` and the explorer pass
`sessionsDir(nodeHost)`, and the session tests pass a temp directory.

**Deleting stale records.** `safeDeleteFile` (`utils.ts:83`) is the wrong tool
here, for three reasons:

- Its `dryRun` parameter defaults to `true`.
- It refuses any path outside the project root, and `~/.agency-agent` is outside
  it.
- It refuses a `.sock` because a socket is not a regular file.

Use `fs.rmSync(path, { force: true })` on paths built from the sessions
directory and a pid, after checking that the name matches `^\d+\.(json|sock)$`.

**Probe with a timeout, and use the pid.** A viewer suspended with Ctrl+Z still
accepts connections, because the kernel queues them, but it never replies.
Without a timeout, `session list` hangs. With a timeout that counts as stale,
`list` deletes a live session's record. `lock.ts:169` already has
`processState(pid)`; export it and use it:

- pid gone: the record is stale, so delete it.
- pid alive and the socket answers: the session is live.
- pid alive but no answer in time: show it as "not responding" and keep it.

Use the same timeout in `client.ts`'s `request`.

**Before `listen`, remove a leftover socket at our own path.** The SIGINT and
SIGTERM handlers in `createViewerHost` call `process.exit` without running
`runSession`'s `finally`, so records and sockets will be left behind. If the
same pid is reused later, `listen` fails with `EADDRINUSE`. The record is ours
by pid, so removing it is safe.

**Platform limits.** macOS limits a Unix socket path to 104 bytes. An
`AGENCY_AGENT_HOME` on a long external-volume path could go over that. Check the
length and say what went wrong, instead of passing on a bare `listen` error.
Windows has no Unix sockets at these paths, so skip the session there and show
the notice the spec gives for stdin.

**`navigate`.**

- `host.setTrace` does not exist; `showTrace` is private. Use
  `host.selectTrace(traceId)` followed by `host.switchTo("trace", rowId)`.
  `switchTo` with a focus ID calls `setFocus` on the trace screen.
- "The same resolution the screens use for a missing cursor ID" cannot produce
  "no such row". The screens quietly fall back to the nearest ancestor. Use
  `findRow` from Task 4.
- A row the trace screen is currently hiding (an admin row, or one removed by
  the `F` quick filter or a `/` search) will land the cursor on its ancestor.
  Either clear the filter, or have `navigate` reply that the row is hidden.
- Close the help overlay too, or the person sees no change.

**One place chooses the session.** Task 5 puts `chooseSession` in `client.ts`,
and Task 6 says that choice lives in `target.ts` "and nowhere else". Keep it in
`target.ts`. `client.ts` is just `request`.

**The boundaries paragraph** names three places where imperative code is
allowed. `client.ts` opens sockets too, so it is four. Change the wording rather
than the code.

## Task 6: The CLI

**`resolveTarget`'s refusals are missing one case:** no session is open and
there is no `--log`. Add that row to `target.test.ts`.

**`list` does not take a target.** "The six commands, each a function of a
`Target`" holds for five of them. `list` is a function of the probed records.

**On a files target, consider making `comments` default to `--all`.** With no
viewer open and a run directory of one trace, either choice works. With a loose
file of several traces, refusing and asking for `--trace-id` is a step the agent
will hit every time.

**Expanded text.**

- No copy action uses `Frame.toPlainText`. They build strings directly
  (`transcriptText` in `transcript.ts:663`, `copyText` in `traceScreen.ts:533`).
- `PayloadLine` is already structured data. A small `payloadText(lines)` that
  turns each kind into plain text is simpler and needs no layout width. Without
  it, the text would be wrapped at whatever width the frame was laid out at. It
  should skip the `charts` kind.
- The header line, `Thread · reviewer · LLM call 4 of 9 · gpt-5 · 2.1s ·
  $0.004`, has no existing function that builds it. Say it is new, or name the
  parts to reuse (`threadLabelOf`, `llmGroupTitle`, `roundTokenLine`).

## Task 7: The skill and the docs

The current `.claude/commands/debug-logs.md` has `argument-hint: <traceId>`.
Change that to `[address]` along with the body. No other notes.

## Pull requests

PR B does not depend on PR A's code. Tasks 3 and 4 never use `address.ts`. The
only overlap is the "Row IDs are a contract" section, which Task 2 writes and
Task 3 adds to. So B can be opened in parallel with A, with the anchor sentence
going in whichever PR merges second. PR C does need both. Each PR is based on
`main` and opened after the one it needs has merged; say that in so many words
in the plan, rather than "opened one after the other".
