# Log viewer comments and live sessions: implementation plan

Implements `docs/superpowers/specs/2026-10-19-log-viewer-comments-and-sessions.md`.
Revised on 2026-10-19 after the review in
`2026-10-19-log-viewer-comments-and-sessions-review.md`; every point in that
review is folded in below, and the spec was changed to match where the
design moved.

Read first:

- The spec, in full.
- `docs/dev/cli/logs-viewer.md`, for the shell in `run.ts`, the `View` and
  `Screen` types, the stable row IDs, and follow mode. The session server
  is built on the same seam as the follow watcher.
- `docs/dev/evals/run-directory.md`, for `annotations.jsonl`, `notes.md`,
  the writer lock, and `humanFeedbackFor`.
- `docs/dev/runtime/lock.md`, for `acquireOwnedFileLock` and `processState`.
- `docs/dev/cli/tui/guide/testing.md`, for `ScriptedInput` and
  `FrameRecorder`, which every viewer test here uses.
- `docs/dev/contributing/coding-standards.md` and
  `docs/dev/contributing/anti-patterns.md`.

All paths are relative to `packages/agency-lang`. One commit per task.

**Pull requests.** Three, each based on `main`:

| PR | Tasks | What it ships | Opened |
| --- | --- | --- | --- |
| A | 1, 2 | `--trace-id`, addresses, the copy key | now |
| B | 3, 4 | the comments store and comments in the viewer | now, in parallel with A |
| C | 5, 6, 7 | the session, the CLI, the skill and docs | after A and B have both merged |

B does not use A's code. The one overlap is the "Row IDs are a contract"
section of `logs-viewer.md`, which Task 2 writes and Task 3 adds a sentence
to; whichever PR merges second carries both. C needs both, so it is based
on `main` after they merge, never on their branches.

## Facts about the current code that shape the tasks

Each of these was checked against the code on 2026-10-19 and is the
reason for a choice below.

- `runKeyLoop` in `run.ts` calls a shell binding's `run()` and discards
  the result. A shell binding that returns a `promptLine` or `copy` action
  does nothing today.
- A shell binding runs instead of the screen's binding on the same key.
  `a` is bound on the trace and timeline screens (admin rows). `c`, `C`,
  and `A` are bound nowhere.
- `ViewerResolution` is `"quit" | "back"` and nothing carries a failure
  from the viewer back to the CLI.
- `--follow` is declared once, on `logs`; the vendored commander refuses a
  second declaration on `view`, which reads the parent's options.
- The follow watcher's `poll` calls back only when the log grew or shrank.
- `ScreenHost` has `selectTrace`, `switchTo`, and `setData`; it has no
  `setTrace`.
- `parseRoundId` in `timeline/rounds.ts` already parses a round ID. There
  is no general row-ID parser.
- `safeDeleteFile` dry-runs by default, refuses paths outside the project
  root, and refuses anything that is not a regular file.
- `withWriter` in `mutations.ts` reads the whole run directory twice per
  write, and `appendRows` is typed to annotation rows.
- `humanFeedbackFor` returns early when a trace has no annotations.
- `processState(pid)` in `runDirectory/lock.ts` is private.
- The SIGINT and SIGTERM handlers in `createViewerHost` call
  `process.exit`, so `runSession`'s `finally` does not run on them.
- `copyTrace.test.ts` mocks `./clipboard.js` with `vi.mock`; the shell
  test has no recorded clipboard.

## Task 1: `--trace-id` on `agency logs`

**Files**

- `scripts/agency.ts`: declare `--trace-id <id>` once, on `logs`, beside
  `--follow`. The `view` subcommand reads it from `command.parent?.opts()`
  as it reads `--follow`. Refuse it with `--csv` and with paths that open
  the explorer, the way `--follow` is refused there.
- `lib/cli/logsView.ts`: add `traceId?: string` to `LogsViewOpts` and
  `focusTraceId` to both kinds of `ViewerSource` (`file` and `text`), and
  pass it through `viewerOptions`. Check the ID before the terminal is set
  up, so the error prints as plain text and never flashes the alternate
  screen: for a run directory, `snapshot.traces` from the
  `readRunDirectory` call `viewRunDirectory` already makes; for a loose
  file, `findTrace` from `runDirectory/extractTrace.ts`; for stdin, the
  text already read. An absent ID goes to `exitWithError` with the IDs
  found. Skip the check under `--follow`: the named trace may not have
  started yet.
- `lib/logsViewer/run.ts`: `focusTraceId` already boots on the trace and
  skips the picker. Under follow, `host.setData` falls back to the most
  recent trace whenever the focused trace is not in the file, so a trace
  named before it starts would lose focus on the first poll. Keep the
  requested ID until it appears: while `focusTraceId` is set and absent,
  pass it as the fallback, and once a root carries it, focus it.

**Tests**

- `lib/cli/logsView.test.ts`: routing passes `traceId` through to the
  injected `viewFile` and `viewRunDirectory`; an absent ID produces the
  error with the found IDs and does not open; `--csv` with `--trace-id`
  is refused.
- `lib/logsViewer/followMode.test.ts`: a viewer opened with a
  `focusTraceId` that is not yet in the file keeps that ID through polls
  and focuses the trace once it appears.

**Docs**: `docs/site/cli/logs.md`, one example under "The log viewer".

## Task 2: Addresses and the copy key

**Files**

- `lib/logsViewer/address.ts` (new): `formatAddress(traceId, rowId)` and
  `parseAddress(text)`, which splits on the **last** slash. A trace ID can
  be anything statelog config or the trace-ID environment variable
  supplies, including text with slashes; a row ID never contains one
  (nanoid span IDs, ordinals, and fixed event types). The row ID is
  opaque here. `parseRoundId` exists for rounds and the screens use it;
  do not add a general row-ID parser. Pure.
- `lib/logsViewer/run.ts`: make `runKeyLoop` dispatch a shell binding's
  result through the same `dispatch` the screens' actions go through.
  One line, and it is what lets `A` here and `c` in Task 4 be shell
  bindings. Then add one shell binding, `A`, in `viewerShellBindings`
  that returns `{ kind: "copy", text }` with the address of
  `host.screen(host.activeScreen()).focusId()`. One binding covers all
  four screens, and it is the same lookup the session's `get` uses in
  Task 5, so they cannot drift. On a screen whose focus has no row (the
  picker, a system block) it notifies "no address here".
- `docs/dev/cli/logs-viewer.md`: a section "Row IDs are a contract" with
  the four shapes, the last-slash rule for addresses, and the statement
  that stored comments depend on the shapes.

**Tests**

- `address.test.ts`: round trip for each shape; a trace ID containing a
  slash; rejection of text with no slash or an empty half.
- `run.shell.test.ts`: mock `./clipboard.js` as `copyTrace.test.ts` does;
  `A` on each screen copies the focused row's address; `duplicateKeys`
  now also checks the shell's keys against every screen's keys, so the
  `a` collision that the review found cannot recur.

## Task 3: The comments store

**Files**

- `lib/runDirectory/comments.ts` (new): the `Comment` row shape with its
  zod schema, the named types `CommentAuthor`
  (`{ kind: "human" | "agent"; id: string }`) and `Anchor`,
  `parseCommentsJsonl(text)` with per-line errors like
  `parseStatelogJsonl`, and `foldComments(rows)` returning each top-level
  comment with its replies (`replyTo`). There are no resolve rows in this
  version: nothing would write one. Add `comment resolve <id>` later if
  it is missed. No I/O.
- `lib/runDirectory/commentsPath.ts` (new): `commentsPathFor(source)` for
  `{ kind: "runDir", dir }` and `{ kind: "file", path }` only. Stdin gets
  no comments in this version (the spec is updated to say so), so the
  home-directory location is gone.
- `lib/runDirectory/commentsStore.ts` (new): the one interface everything
  else goes through:

  ```ts
  type CommentsStore = {
    path: string;
    read(): FoldedComments;
    add(draft: CommentDraft): Comment;
  };
  ```

  `openCommentsStore(path, author)` builds one over a file. The author is
  fixed when the store is opened, by the CLI. The viewer and the CLI
  commands take a store and never a path, and viewer tests inject a fake.
- `lib/runDirectory/mutations.ts`: `appendCommentRow(path, row)`, a new
  sibling of `appendRows` that does not assume annotation rows and takes
  no snapshot: `repairTornTail` then `appendDurably`. The path decides the
  lock: a run directory's `comments.jsonl` takes the directory's `.lock`
  through `acquireRunDirLock`; a sidecar takes `acquireOwnedFileLock` on
  `<sidecar>.lock`, so no `.lock` is left in whatever folder holds a
  loose file. Only `commentsStore.ts` calls it.
- `lib/runDirectory/mutations.ts`, `wrapTracesAsRunDirectories`: wrapping
  copies, it does not move. Read the sidecar once, put the rows whose
  `traceId` is the wrapped trace into `RunDirectoryAssemblyPlan` beside
  `annotationDrafts`, and write them inside the staging directory, so a
  child run is whole or absent. Never rewrite the sidecar.
- `lib/runDirectory/runDir.ts`: add `comments` to `RunDirectoryPaths`
  (`<dir>/comments.jsonl`) and read it into the snapshot outside the
  statelog and annotations coherence check, as `notes.md` is.
- `lib/runDirectory/humanFeedback.ts`: push each top-level human comment
  into `notes` after the `notes.md` entry and **before** the early return
  for a trace with no annotations. Format it from the anchor, which is
  what an optimizer's model can read:
  `reviewer · gpt-5 call: why does it read the config a second time here?`.
  A row ID means nothing to a model and is not included.
- Anchors are read in two places, so they are not write-only: the format
  above, and the "unresolved" listing in Task 6, where a comment whose row
  ID no longer resolves is shown with its anchor and marked
  `re-anchored` rather than dropped.

**Tests**

- `comments.test.ts`: parse and fold with replies; a bad line reported and
  skipped.
- `commentsPath.test.ts`: the two locations.
- `commentsStore.test.ts`: `add` writes a row and `read` folds it back,
  for a run directory and for a sidecar; the sidecar case leaves no
  `.lock` beside the loose file after the store is closed.
- `mutations.test.ts`: wrap puts the trace's comment rows into the child
  run's `comments.jsonl`, written inside staging; the sidecar is
  byte-for-byte unchanged.
- `humanFeedback.test.ts`: a trace with comments and no annotations keeps
  them; agent comments are not included; the anchor format.

**Docs**: `docs/dev/evals/run-directory.md`, a `comments.jsonl` entry in
the layout and a short section on the row shape and the fold.

## Task 4: Comments in the viewer

**Files**

- `lib/logsViewer/views/view.ts`: `setMarks?(marks: RowMarks): void`,
  optional like `escape?` and `capturesText?`.
- `lib/logsViewer/screenHost.ts`: `setMarks(marks)` beside `setData`,
  looping over every screen and open overlay with `?.`.
- `lib/logsViewer/marks.ts` (new): the named types `RowMarkSet`
  (`{ human: Comment[]; agent: Comment[] }`) and `RowMarks` (a map from
  row ID to `RowMarkSet`), `marksFrom(folded)`, `commentCount(marks)`
  for the picker, and `anchorFor(row)` from a `StoryRow`. Pure.
- `lib/logsViewer/story.ts`: `findRow(trace, rowId): StoryRow | undefined`
  over `outlineRows` with admin and machinery rows included, so a hidden
  row still resolves. Used by `anchorFor`'s caller here, by `navigate` in
  Task 5, and by `expandRow` in Task 6.
- `lib/logsViewer/run.ts`:
  - `RunViewerOpts` gains `comments?: CommentsStore`.
  - One object in the shell, the comments source, is the only viewer code
    that reads or writes comments:

    ```ts
    type CommentsSource = {
      refresh(): void;                        // store.read() → marksFrom → host.setMarks → render
      add(rowId: string, text: string): void; // store.add(...) then refresh()
    };
    ```

    The `c` key calls `add`, the follow tick calls `refresh`, and the
    session's `reload` request calls `refresh`. `refresh` compares the
    file's size to the last one it read and does nothing when unchanged,
    because the tick fires every 250ms.
  - The follow watcher gains a second callback, `onTick`, that runs on
    every poll whether or not the log changed; `poll` itself is unchanged.
  - Shell bindings: `c` returns a `promptLine` labelled `comment` whose
    result calls `commentsSource.add` with the focused row ID. Its `when`
    is: a store is present, not typing, and the target is a screen or the
    detail overlay (which keeps a round or span ID, so it is a natural
    place to comment). With no store, `c` notifies "comments unavailable
    for this log", the follow message's shape. `C` toggles agent notes.
  - A dirty flag: `render()` called while a `promptLine` is open only
    marks the screen dirty, and the screen is drawn once when the prompt
    closes. This covers the three new redraw sources (refresh, tick,
    session requests) and also protects the trace screen's `/` prompt,
    which follow can paint over today.
- `lib/logsViewer/screens/traceScreen.ts` and `timelineScreen.ts`: draw
  `✎` for a human comment and `⚑` for an agent one in the gutter of a
  marked row, using `lineNumbers.ts` for the column.
- `lib/logsViewer/payload.ts`: `commentsPayload(markSet, showAgentNotes)`
  returns the `comments` section as `PayloadLine`s; `payloadFor` appends
  it when the row has marks. A reply to a human comment is always shown
  under that comment; the toggle hides only agent comments that are not
  replies. Otherwise the skill's step 2 would leave the person seeing
  their question and not the answer.
- `lib/logsViewer/screens/tracePicker.ts`: the per-trace line adds
  `N comments` from `commentCount(marks)` for that trace. It comes from
  the marks the viewer holds, not from the CLI's annotation string, so a
  loose file gets a count and the count is live after the first `c`.
  `annotationSummaries` in `logsView.ts` is unchanged.
- `lib/cli/logsView.ts`: for the file and run-directory routes, build the
  store with `openCommentsStore(commentsPathFor(source), author)` where
  the author is `{ kind: "human", id: os.userInfo().username }`, and pass
  it as `comments`. Stdin passes none.
- `lib/runsExplorer/run.ts`: the drill-in builds a store from the run
  directory it opened and passes it, so `c` works there. Without this,
  the most common way of opening a run would say "unavailable".

**Tests**

- `run.shell.test.ts`, against a fake `CommentsStore` held in memory: `c`,
  type text, Enter calls `add` with the focused row and the next frame
  shows `✎` and the text in Details; `c` on the detail overlay does the
  same; Esc calls nothing; a follow tick during the prompt does not
  repaint it, and the frame after Enter is current; `C` hides and shows
  an agent comment the fake returns, and a reply stays visible with `C`
  off; a comment the fake starts returning while following appears on
  the next tick with no log growth; the picker line shows the count.
- `payload.test.ts`: the comments section, both kinds, the reply rule.
- `story.test.ts`: `findRow` resolves an admin row.
- `runsExplorer/run.test.ts`: a drill-in passes a store.
- Snapshot tests under `screens/__snapshots__` for a marked row on the
  trace and timeline screens.

## Task 5: The session server

**Files**, all new under `lib/logsViewer/session/`:

- `protocol.ts`: the request and reply types, with zod schemas for the
  request side. Three requests: `get`, `navigate`, `reload`. There is no
  `comment` request: a comment through the socket would be saved under
  the viewer's author, which is the person, and the CLI already writes
  through its own store. Two write paths would be one too many.
- `record.ts`: the `SessionRecord` type: `pid`, `logPath`, `commentsPath`
  (absent when the viewer has no store), `cwd`, `started`. The CLI needs
  `commentsPath` because it cannot tell from a statelog path alone
  whether comments live in a run directory or a sidecar.
- `registry.ts`: `writeRecord`, `removeRecord`, `listRecords` (lists only,
  no side effects), `probe(record, timeoutMs)`, and `removeStale(probed)`.
  `probe` returns one of `live`, `not-responding`, or `stale` as a value,
  using `processState(pid)` (export it from `runDirectory/lock.ts`) and a
  timed `get`: pid gone is `stale`; pid alive and an answer in time is
  `live`; pid alive and no answer in time is `not-responding`, which a
  suspended viewer produces and which must not be deleted. The catch that
  turns a failed connect into a value logs the error at debug level.
  `removeStale` deletes only `stale` records, with
  `fs.rmSync(path, { force: true })` on paths built from the sessions
  directory and a pid whose names match `^\d+\.(json|sock)$`.
  `safeDeleteFile` is the wrong tool: it dry-runs by default, refuses
  paths outside the project root, and refuses a socket.
- `server.ts`: `startSessionServer(port, options)` first removes a
  leftover socket and record at its own pid's paths (the SIGINT path exits
  without `finally`, and a reused pid would otherwise hit `EADDRINUSE`),
  refuses with a clear message when the socket path is over the platform
  limit (104 bytes on macOS, reachable with a long agent home), then
  opens a `net.Server`, writes the record, handles one newline-delimited
  request per connection, calls the port, replies, and closes. Returns
  `{ stop() }`. On Windows there are no Unix sockets at these paths:
  `startSessionServer` returns a no-op and the viewer shows the notice
  the spec gives for a session key with no session.
- `client.ts`: `request(socketPath, req, timeoutMs)` only. Choosing a
  session is Task 6's job.
- `port.ts`:

  ```ts
  type SessionPort = {
    focus(): { traceId: string; screen: ScreenName; rowId: string | undefined };
    navigate(traceId: string, rowId: string | undefined): NavigateResult;
    reloadComments(): void;
    notify(message: string): void;
  };
  type NavigateResult = "ok" | "no such trace" | "no such row" | "row hidden by filter";
  ```

**Wiring**, in `lib/logsViewer/run.ts`:

- `RunViewerOpts` gains `session?: { dir: string }`. No value means no
  session, so the four test files that pass `followPath` never open a
  socket or write under the real agent home. `logsView.ts` and the
  explorer pass `sessionsDir(nodeHost())`; session tests pass a temp
  directory.
- Build the port from `host` and the comments source: `focus` is the
  same lookup as the `A` key; `navigate` is `host.selectTrace(traceId)`
  when the trace differs, then `findRow` (absent: `no such trace` or
  `no such row`), then, if the trace screen's filter or search hides the
  row, `row hidden by filter` with no cursor move, else `host.closeHelp()`
  and `host.switchTo("trace", rowId)`; `reloadComments` is
  `commentsSource.refresh`. Each request ends with `render()`, which the
  dirty flag from Task 4 defers while a prompt is open.
- Start the server after the first `render()`; stop it in the `finally`
  that stops the watcher.

**Boundaries to hold while writing this task.** Imperative code is
allowed in four places: `server.ts` and `client.ts` (sockets),
`registry.ts` (files), and the wiring in `run.ts`. Everything else in the
directory is a type or a pure function. If a fifth place appears, stop
and move the logic into one of the four.

**Tests**

- `server.test.ts`: start a server with a fake port on a socket under a
  temp directory; `get` returns the fake's focus; `navigate` calls the
  fake with the IDs; a malformed request gets an error reply and the
  server stays up; `stop` removes the record; a leftover socket at the
  same path is replaced; an over-long path is refused with the message.
- `registry.test.ts`: `listRecords` lists a record whose socket is gone;
  `probe` reports `stale` for a dead pid, `not-responding` for a live pid
  whose socket does not answer within the timeout, `live` otherwise;
  `removeStale` deletes only the stale one and ignores a file whose name
  does not match the pattern.
- `run.shell.test.ts`: open the viewer with `session: { dir: tmp }`,
  press a few keys, `get` over the client matches the cursor; `navigate`
  to a visible row changes the next frame; `navigate` to a filtered row
  replies `row hidden by filter` and the cursor stays; `reload` makes the
  fake store's new comment appear; a viewer opened without `session`
  writes nothing to the directory.

## Task 6: The CLI

**Files**

- `lib/logsViewer/payloadText.ts` (new): `payloadText(lines)` turns
  `PayloadLine`s into plain text, one case per kind, skipping `charts`.
  No copy action uses the frame's plain-text renderer today (they build
  strings directly), and going through the frame would wrap at whatever
  width it was laid out at.
- `lib/logsViewer/rowText.ts` (new): `expandRow(trace, rowId, marks)`
  returning the expanded block and a JSON object with the same facts plus
  the row's raw events. The header line
  (`Thread · reviewer · LLM call 4 of 9 · gpt-5 · 2.1s · $0.004`) is new;
  build it from `threadLabelOf`, `llmGroupTitle`, and `roundTokenLine`.
  The body is `payloadFor` through `payloadText`. A comment whose row
  `findRow` cannot resolve is listed in an `unresolved` block with its
  anchor text and the word `re-anchored`.
- `lib/cli/logsSession/target.ts` (new): `resolveTarget(args, probed)`,
  the one place that decides what a command acts on:

  ```ts
  type Target =
    | { kind: "session"; record: SessionRecord; store: CommentsStore | undefined; traceId: string }
    | { kind: "files"; logPath: string; store: CommentsStore; traceId: string | undefined }
    | { kind: "refused"; reason: string };
  ```

  Its rules, and nowhere else: choosing a session (`--log` match, else
  the only live one, else refused with the list; none open and no `--log`
  is refused too) and choosing a trace (the address, else `--trace-id`,
  else the open viewer's current trace, else undefined). The store is
  opened here with `openCommentsStore` on the record's `commentsPath` or
  on `commentsPathFor(--log)`, with the agent author. A session record
  without `commentsPath` gives `store: undefined`, and the comment
  commands say the viewer has no comments file.
- `lib/cli/logsSession/commands.ts` (new): `get`, `show`, `comments`,
  `comment add`, and `navigate`, each a function of a `Target` and its
  own arguments, returning the text and JSON to print. `list` is a
  function of the probed records, not of a target, and shows
  `not responding` for those. `get` and `navigate` on a `files` target
  return `no viewer is open` and exit 1. On a `files` target `comments`
  defaults to every trace, grouped, since there is no current trace to
  prefer; on a `session` target it defaults to the viewer's trace, with
  `--all` for every trace. `comment add` writes through the target's
  store and then, on a `session` target, sends `reload`. It takes
  `--reply-to <id>` and `--author <id>`, default author
  `{ kind: "agent", id: "claude" }`.
- `lib/cli/logsSession/index.ts` (new): `logsSession(args, deps)` with
  injected file and socket access: list and probe the registry, remove
  the stale, call `resolveTarget`, run the command, print.
- `scripts/agency.ts`: register `logs session` with the subcommands and
  the shared `--json`, `--log`, `--trace-id` options.

**Tests**

- `payloadText.test.ts`: one case per `PayloadLine` kind; `charts` is
  skipped.
- `rowText.test.ts`: expanded text for a round, a tool, an interrupt, and
  a user turn against the story fixture; the JSON carries the events; an
  unresolved comment is listed with its anchor.
- `target.test.ts`: every row of the two rules as a table: zero, one, and
  two live sessions with and without `--log`; none open and no `--log`;
  an address, a flag, an open viewer, and nothing for the trace; a record
  without `commentsPath`. Pure, no sockets.
- `commands.test.ts`: every command against a `files` target over a
  fixture run directory (text and `--json`); `comment add` appends and a
  second `comments` shows it; `get` and `navigate` on a `files` target
  return the refusal; `comments` on a files target lists every trace.
- `index.test.ts`: with a headless viewer open on a temp socket, `get`
  and `navigate` go through it, and `comment add` writes the file and the
  viewer's next frame shows the mark.

## Task 7: The skill and the docs

**Files**

- `.claude/commands/debug-logs.md`: change `argument-hint` to
  `[address]` and replace the grep instruction with the four steps from
  the spec's "The skill" section.
- `docs/site/cli/logs.md`: a "Comments and sessions" section with the
  keys (`A`, `c`, `C`) and the commands, each with one example.
- `docs/dev/cli/logs-viewer.md`: a "Comments" section (marks as data, the
  `c` prompt and the dirty flag, the follow tick) and a "Sessions"
  section (the port, the record, the registry's three probe states, the
  protocol, the removal recipe from the spec).
- `CLAUDE.md` index and the `agency-cli-docs` skill: no new doc file, so no
  new entry; update the one-line description of `logs-viewer.md` to
  mention comments and sessions.

**Checks before each PR**: `make`, `pnpm run lint:structure`,
`pnpm run fmt:ts`, and the test files named in that PR's tasks, with
output saved to a file. Do not run the full agency suite locally.
