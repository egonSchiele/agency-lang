# The logs viewer: screens, the timeline kernel, and follow mode

The interactive statelog viewer behind `agency logs` and `agency eval logs`. This page is
the architecture; the user-facing keys and screens are documented in
`docs/site/guide/observability.md`. The cross-run explorer (`agency logs` over run
directories) is a separate app that embeds this viewer, described in
[`runs-explorer.md`](./runs-explorer.md).

## Screens and overlays

`ScreenHost` owns four numbered screens: overview, trace, transcript and timeline. It keeps a separate, initially empty stack of overlays. The top overlay receives keys and renders while it is open; otherwise the active screen does. Switching screens carries the focused span or stable round ID to the destination and closes overlays.

The shell in `run.ts` owns the terminal, follow watcher, help, clipboard and extraction. A view returns a `ViewAction` when it needs one of these operations. It receives the inner viewport for paging, excluding the tab strip and parse-error notice. Parse errors appear below the tab strip. The shell passes its shared key hints to `render` so the view can combine them with its own hints on one footer row.

```ts
type View = {
  handleKey(event: KeyEvent, viewport: Viewport): ViewAction;
  render(viewport: Viewport, sharedHints?: string): Element;
  setData(roots: TreeNode[]): void;
  helpLines(): string[];
  notify(message: string): void;
  setFollowIndicator(on: boolean): void;
  escape?(): boolean;
  capturesText?(): boolean;
};

type Screen = View & {
  screenName: ScreenName;
  focusId(): string | undefined;
  setFocus(id: string): void;
  setTrace(traceId: string): void;
  escape(): boolean;
  applySearch(query: string): void;
};
```

The actual types live in `views/view.ts` and `screens/screen.ts`. An overlay also declares its `viewName`. A screen can decline an Esc by returning false, allowing the shell to continue down the ladder.

Pure modules compute plain records. Screen painters draw those records and own the TUI imports. Shared bar components live in `views/shared.ts`.

The overview fills slot 1, the trace outline slot 2, the transcript slot 3, and the timeline slot 4. The overview selects completed model requests; Enter opens its selection in trace. Round focus survives transitions between all four screens. A missing ID falls back to its nearest surviving ancestor, then the first row.

The overview stacks context, cost and request duration charts beside a full-height preview. `overviewData.ts` supplies the trace summary and the requests. `screens/overviewCharts.ts` paints the three charts with a shared call window, column width and selected ID, using maxima over the entire trace for stable scales. A model context ceiling is used only for a single-model trace. Column slots grow to fit full call numbers.

Each `OverviewCall` records where the request sits among the others. `enclosing` lists the tools it ran inside, outermost first, from the `toolExecution` spans above it; `inside` is the nearest of those, with the index of the call that requested it; `continues` is the previous call in the same conversation (see `messageDelta.ts` below). A request that failed before the provider answered gets the same placement. The metadata above the preview prints these as one line: `continues LLM call 2 · inside researchAgent (requested by LLM call 1)`. When any call is nested, each chart gains one bracket row per nesting level under the call numbers, `└ researchAgent ┘` across the calls that share that tool, and those columns and the gaps between them carry a `THEME.groupBg` band, one shade per level, so a sub-agent's calls read as a block and a tool run inside the sub-agent as a block within it. The selected column keeps its own highlight. This is a signpost, not a tree: the trace and timeline screens draw the full nesting.

When the trace has more than one thread, the call numbers under each chart take their thread's color and a `threads` legend names them, in order of first use. A second thread with a name already taken reads `name #2`, so two threads one tool started are told apart; `OverviewCall.threadName` carries that display name and the preview uses it too. The preview always names the call's thread.

`OverviewScreen` owns selection by stable round ID and separate input and output scroll offsets. The preview opens on the input, so the first thing a reader sees is their own message; `i` and `o` choose input or output, and the choice persists across calls. Tab focuses the other pane, as on the trace screen; each pane has a `paneHeader` from `screens/chrome.ts`. Left/Right always change the call and Up/Down always scroll the preview. Ctrl+F/B, Ctrl+D/U, g/G and Home/End act on the focused pane: pages and ends of calls in the charts, pages and ends of lines in the preview. A changed selection resets the scroll and every toggle below; follow updates keep the ID or fall back to the first remaining call. Arriving from a tool previews its owning call and keeps the tool ID for the return trip until the user selects a call.

The metrics above the preview use `roundTokenLine` from `payload.ts`, the same token line the trace detail prints, with exact counts, and `fmtDuration` for the duration.

The context chart stacks cached, fresh and output tokens per call. `stackedColumn` rounds the whole stack to rows and hands them to the bands by largest remainder (`shareRows`); rounding each band on its own hid the one call in a long-context trace whose output outweighed its input, since 11k fresh and 12k output each rounded to nothing against a 116k scale. Output is still a few percent of a long context and seldom earns a row of its own; the token line above the preview prints the exact count for the selected call. `roundResponsePayload` shares completion and requested-tool formatting with the trace detail. In the trace detail each argument is cut to `ARGUMENT_PREVIEW_CHARS` and an ellipsis, since the same call appears again as its own tool row directly below and the two read as one when both are whole; the overview has no tool rows, so it prints arguments whole. The tool row itself has the overview's shape: `TOOL CALL · name`, the status and duration, the arguments, then `→ RESULT · ~N tokens` and the whole output, with no `Arguments` or `Output` labels, so the colored headings carry the hierarchy. The runtime drops an argument the model sent as `null` when its parameter has a default (`dropNullDefaultedArgs`), so the recorded arguments can be fewer than the request's. `ToolStoryRow.droppedNulls` names them, found by pairing the row with its requesting round's tool calls by name and order (the requesting round of every tool span is computed once per outline, in `lookupsFor`, since the outline is rebuilt on every follow tick), and the tool row prints them back as `name: null` followed by the dim line `Null arguments in tool calls are dropped, defaults apply`, so the two rows agree without the reader comparing them. On the overview it also prints each requested tool's result, cut to `RESULT_PREVIEW_CHARS` with a `… ~N more tokens · x to show` line after it; `x` prints every result whole. The input cuts a `TOOL RESULT` message the same way, measured as the text the model read, and the one `x` toggle covers both previews: the output restarts at its top, the input keeps its scroll. The trace detail passes no tool rows and shows no results; the tool's own row and the transcript print them whole.

`roundInputPayload` reads the complete recorded `messages` array and labels roles and tool-call IDs; a tool-role message is headed `TOOL RESULT`, since `TOOL` alone read like a call. A message sent as content parts shows each text part as its text and any other part as its fields; a list that is not made of parts, such as a tool result of records, keeps every field. System and developer prompts show as `SYSTEM`, their first line, and `… (+10 more lines · s to show)`; `s` expands them all and leaves the scroll where it is. The input also takes the call's `RoundDelta`, which splits it into history, the messages the previous call already had, and new messages. By default the history folds to a stub: the last history message as its heading and first line, kept to one painted row (`oneRow`) because a tool result often starts with one very long line, then a dots line counting the rest, `… (+3 earlier messages)`, with the rewrite noted when there was one, all faded. System prompts count as messages. `e` swaps the stub for the whole history, faded, with a `── N earlier messages above · NEW ──` divider, and scrolls so the divider is the first row under the metrics even when the new messages do not fill the pane. The first call on a thread has no history and no stub. Missing input is distinguished from an empty message list. The screen caches painted input and output separately for the selected round and width, invalidating only the input when a toggle changes it. Graph height adapts to terminal height; the footer stays at the bottom.

## Errors and how the run ended

`problems.ts` is the one place the viewer decides what went wrong. `traceErrors` turns the `error` events into one record per error: the same message logged within a second on one call stack (a tool, then the tool above it, as a rethrow travels up) is one error with a count, while two sibling tools failing the same way are two. Each error records the tool call it was logged inside, if any. `runStatus` reads the lifecycle events after the latest `agentStart`: `done` after a footer, `crashed` when the event right before that footer is the `error` with `errorType: "runtimeError"` the runtime logs when a run throws (a failed tool or a handled structured-output failure also log errors, and a node that returns nothing has no `result` on its footer, so neither can be the signal), `paused` while some interrupt's latest resolution is `propagated` or `passed` (the runtime logs `passed` when no handler decided, which is the usual way an interrupt reaches a person), and `running` otherwise. A log with no lifecycle events falls back to whether any work is still open. A run stopped by the host's pause signal logs neither a footer nor a waiting interrupt, so it reads as `running`.

Two notions of "running" exist on purpose. `hasRunningWork` in `timeline/spans.ts` answers whether one span has work that has not ended, and span rows read it. `runStatus` answers how the whole run ended, and only the Overview header reads that. A tool paused for approval is open work in its span and a paused run in the header.

The Overview header shows the status in its own color and, when there are errors, a red count. Every chart column with a problem gets a red ✖ on a row of its own under the call numbers, so a two-digit number never squeezes it out; the row and the `✖ failed` legend entry appear only when something went wrong. A failed tool is marked on the call that requested it. An error between calls (a hook, a validator, a guard) is marked on the last earlier call in its own `llmCall` span, then the last earlier call anywhere, then the first call, so it is never dropped. A request that failed before the provider answered (an `llmError` inside an `llmCall` span; the memory manager's own `llmError`s are marked on a call like any other error) has no round; it gets a column of its own with no bars, a ✖ for its tick, a `FAILED REQUEST` preview that shows the error, and the error row's id so Enter opens it in the trace. The output preview follows each requested tool call with what came back: `→ RESULT` with the output shortened to `RESULT_PREVIEW_CHARS`, `✖ RESULT · tool failed` with the message, `⏸ RESULT · waiting for a response`, or the status text. The header counts completed calls, with failed requests counted beside them. Requests pair with tool rows by name, in order.

The Transcript marks failed tools `✖` and waiting tools `⏸` in the call list (`TOOL_STATUS_MARK` in `story.ts` is the one glyph table every screen reads), always shows a failed tool's error in its block, and gives an error outside any tool call a `✖ ERROR` block of its own. Every block carries the time of the event it comes from (a tool's first event, a call's start for its input, a call's end for its reply), and an error block goes before the first later block on its thread, or at the end. A rethrown error shows once with "logged N times as it was rethrown". The Timeline prefixes `✖` to a span that logged an error itself and paints its bar red, and `⏸` to a tool the story outline says is waiting for a response.

## Key tables

A `KeyBinding<Action>` gives a set of keys, help text, an optional footer hint, an optional availability condition and an action. `handleKey`, `helpLines()` and the footer derive from that table through `runViewerKey`, `helpFrom` and `hintsFrom`. A new screen must not contain an `if (key === …)` chain. `cursorBindings` supplies the shared movement keys. Ctrl+D/U moves half a page; Ctrl+F/B and PageDown/Up move a full page.

The shell table includes Esc, quit, follow, help, screen selection and trace navigation. Its control bindings run over help and the narrow-terminal message. Help uses the shared cursor bindings to scroll; non-navigation keys dismiss it, and Esc closes it through the usual ladder.

The generic table helpers live in `lib/tui/keymap.ts`. The viewer-specific wrapper lives in `lib/logsViewer/keymap.ts`. The runs explorer retains its existing key handlers.

## The trace picker

The picker shows each trace's starting time, agent name, duration, LLM calls, token total, cost, ask and annotation. `fmtStartedAt` formats the start as a full local date and 12-hour time with seconds; the column is labeled `Started (local)` and aligns days and hours. The highlighted row is the selection; `✖` marks a recorded error. The shell header reads the picker's selection for its trace ID, position and annotation. When no traces match, it omits those fields. Annotations occupy display lines under their trace; scrolling counts those lines.

While the picker is open, no numbered tab is marked active. Enter opens the highlighted trace's overview, or its trace screen when the query has a text part. Number keys open the highlighted trace in the corresponding screen. The picker uses the overlay stack, but Esc treats it as the outermost page: clear its search, then return to the embedding app or stay on the list when standalone. Esc from overview opens the picker when the log has several traces.

`traceTexts` collects string values from event data, including prompts, answers, nested tool payloads and errors. It does not search serialized JSON, because escaping would hide literal quotes and line breaks. The picker computes these strings on each parse and filters them as you type.

A `TraceFilter` declares an ID, label and a predicate over `TraceSummary`. Every active filter must accept a trace for it to appear. To add a filter, create its predicate and put it in the picker's filter list. The text search is the first filter.

The `agent` column shows the trace's recorded agent name: the name in the last `agentName` event in file order, the same rule `eval extract` and the runs explorer use. `buildForest` records it on the trace root during its file-order pass over events, because the later passes sort the tree by timestamp and `walkNodes` visits children in reverse, so the name cannot be read back from the finished tree. `TraceSummary` carries it. The column is present only when some trace in the file has a name, so a log from a plain program looks as it did before. It takes the width of the longest name or the header plus a gap cell, capped at 26 cells, measured over every trace rather than the shown ones so it does not jump as a query changes. A longer name is clipped; the full name is on the trace's `agentName` event.

A query that starts with `agent:` (the keyword in any case, after any leading spaces) names a prefix of the agent name, up to the first space; the rest of the query, with leading spaces dropped, is the ordinary text search. `parsePickerQuery` in `traceSearch.ts` makes the split, and `agentFilter` is the `TraceFilter` for the prefix. The match is a case-sensitive prefix match so the list narrows as the name is typed and `agent:agency-agent/` selects a family of variants. An unnamed trace never matches, so a prompt that mentions a name does not count. Hits, the hits column, the first-hit line and the search carried into the trace screen come from the text part alone, because the trace screen searches rows, not names. `agent:` with nothing after it lists every named trace.

`capturesText()` is true while editing. The shell then sends q, f, ?, digits and other printable characters to the picker. Enter finishes editing; another Enter opens the selected trace. A query with a nonempty text part opens slot 2 and searches that trace's payloads, regardless of which screen was underneath the picker.

At boot, multiple traces with no requested focus open the picker over the most recent trace. A single trace or `focusTraceId` opens its overview directly. Follow updates never reopen the picker. The picker is only a boot decision or an explicit request.

## The timeline kernel (`lib/logsViewer/timeline/`)

A chat session's trace is mostly waiting for the person's next message, so on one shared axis every bar is a sliver. `turns.ts` splits a trace into turns at every `turnStart` event, which the `repl` functions log for each line a person submits (a slash command excepted) and `turnStart` in `std::statelog` logs from anywhere else; the agent's seeded first prompt logs one. A `threadResumed` is not a turn: the runtime logs it whenever a named session thread is re-entered, which a sub-agent does with no person involved. A turn runs from its `turnStart` to the next, or to the trace end. Its work ends at its last event other than `exitNode` and `agentEnd`, and the rest is the wait for the person. Events before the first `turnStart` are startup, folded into the first turn's wait, unless an LLM call completed among them, in which case they are a turn of their own with no message. A trace with fewer than two turns is unchanged and works to its end, since the moments before its `agentEnd` are shutdown. The tally behind this (`tallyEvent`) takes one event at a time, so the runs explorer feeds it while scanning a log and the viewer feeds it from the forest, and the two agree.

With several turns the rows are stacked: a `turn` row (`turn 2 · do the same analysis for modem.ai` across the width, with the turn's cost and call count at the right), an `axis` row beneath it with that turn's own axis in the bar column, ticked in offsets from the turn's start, and the `total/self` label, the turn's spans and calls indented one level under it, and after it a dim `wait` row, `⏸ waited 7m46s for the user` (`then the run ended` after the last). The cursor skips the axis, wait and gap rows, a search never matches them, and `Enter` on a turn row folds the turn. Each turn's bars are measured on that turn's axis: `timelineSpans` takes the turn's working time as a `window`, keeps only the spans that overlap it, cuts their extents to it, and counts self time inside it, so `node main` does not carry the wait; the turn's own rounds (`Turn.rounds`) are drawn under it. A span that runs across turns is drawn once per turn, and the cursor, folds and zoom belong to one turn's copy (`rowKey`, `zoomTurn`): a follow update puts the cursor back on the same turn's copy of its row. The header splits elapsed time into working and waiting, and `traceTimes` gives every screen the same split: the overview header prints the working time with `(waited 19m12s for the user)` dim beside it, the trace picker's duration column is working time, and so is the runs explorer's duration for a trace opened from a raw log, since a session that sat for 900 minutes between two messages did not take 900 minutes. Eval runs have no `turnStart` events, so their durations are unchanged.

On the timeline `Enter` folds or unfolds the selected span in place, as it does on the trace, while `Right` and `l` drill in (re-root the view on the span, with a breadcrumb) and `Left` and `h` drill out. A folded span keeps its bar and takes the `▸` marker. A completed `llmCall` span inside a tool folds the first time it is seen, by the same rule as the trace (`threadComplete` in `story.ts`: nothing under it still runs and its last call asked for no tool, so a thread between its tools' end and its next call is not complete); a top-level thread never folds by itself; the group the cursor is on or inside is never folded by a follow update; a fold reopens when its span runs again; and a group the reader opened stays open across follow updates (`foldDefaultsApplied`). Search looks through folded rows and opens the way to a match, and so does a focus from another screen. Row numbers (`#`) count every row of the drill view, folded ones included, so a fold leaves a gap like the trace and the gutter keeps one width. A bar is drawn in block elements of one height: `█` for a cell the span covers by more than three quarters, `▐` or `▌` for a cell it covers less, on the side it covers, so a span reads `▐███▌` with thin ends; a call too short for any cell still gets one half glyph on the side of its cell it falls in, and a running span ends in `⋯`. The shades `░▒▓` sit at other heights than `█` in most fonts and clash with the overview's token legend, where the same glyphs mean cached, fresh and output. Timeline uses `[` and `]` to select the previous or next sibling in its displayed row hierarchy. It skips descendants, stops at parent boundaries, and does not wrap. This works in drilled and zoomed views without changing the time window. Panning uses `{` and `}` while zoomed.

Timeline labels enclosing `llmCall` spans in bold accent text with `llmGroupTitle` from `story.ts`, the same rule as Trace: `Thread · <name> · N LLM calls`. Names come from the span's recorded calls, with `unnamed` when unavailable; breadcrumbs and the selection footer use the same label. Individual requests retain their `LLM call N` labels, and tool rows retain their argument summaries. The `agentRun` span is hidden with the admin spans until `a` (`HIDDEN_KINDS`): its own time is startup and shutdown, and the node row and the overview header carry its name and totals. The right-hand column reads `total/self`, named once on the axis line: how long the row ran, and how much of that was outside every span beneath it; one number when they are nearly equal. Rows take the trace's colors by kind (`spanColor`): tools in the tool color, LLM calls in the assistant color, `llmCall` spans in the accent, admin spans in chrome, the run and subprocess spans muted, and a span that logged an error in red.

Tool ownership uses the recorded `toolCallStart` timestamp when available, falling back to the span's extent start for older logs. A duration-derived extent can begin slightly before the requesting completion, so it does not override a recorded tool start.

The pure timeline modules compute records that screens and analysis code can share:

- `intervals.ts` — interval arithmetic. `subtract(base, pieces)` removes the union of the
  pieces (clamped into the base, so malformed logs cannot produce negative residue);
  `coverage(intervals, window, cells)` returns per-cell busyness fractions.
- `spans.ts` — `timelineSpans(root, { hideKinds })` turns a span subtree into plain timed
  data. A span's **extent** is the envelope over all descendant leaf events
  (`timestamp − timeTaken` to `timestamp` — the same rule `tree.ts` uses for duration,
  which is what keeps parent ⊇ child and self-time non-negative). A span's **self-time**
  is its extent minus its direct children's extents. This separates the wrapping `llmCall` span from its nested work. `running` is true when a start-marking event has no
  terminus, and `promptCancelled` counts as a terminus. The admin spans listed in
  `ADMIN_KINDS` (`handlerChain` and `threadEndHooks`) are filtered presentationally: rows
  disappear and depths close up, while extents and self-time stay untouched.
- `groups.ts` — call grouping for the timeline and occurrences overlay, via `groupSpans(spans, root, index?)`. LLM calls group by **thread label** (from
  `threadCreated` events, scoped to the nearest enclosing `subprocessRun` span because
  thread ids restart per process), else the **enclosing function**, else the model;
  everything else groups by its display name. Grouping lives in the kernel because both
  the timeline and occurrences need consistent group membership
  and a follow-mode re-parse can legitimately re-group a call — one computation, two
  readers. A group's share is of wall clock and may exceed 100% for parallel work; that is
  the sum of concurrent work.

`TimelineSpan` carries no names and no `TreeNode` reference. Naming is a view opinion, so
label components look nodes up by id, and the kernel's output stays plain serializable
data. Shared span names and argument summaries live in `spanText.ts`. `theme.ts` owns the colors and threshold tones. Slow or expensive metrics use amber and include a `!` marker. Defaults are 300000ms and $1; durations under 100ms are gray. CLI entry points pass `config.viewer` through to `runViewer`, which fills in omitted thresholds from `DEFAULT_THRESHOLDS`. This includes remote logs and traces opened from the runs explorer.

`rounds.ts` emits one `Round` per completion. The UI labels these “LLM calls”; internal types and stable IDs retain the name `Round`. A single `llmCall` span can contain an entire tool loop, so a round needs its own ID: `round:<span id>:<ordinal>`. The ordinal is local to the span; the displayed round number follows completion time across the trace. Timeline draws a row for every round, a lone one beneath its span too: its bar repeats the span's, but the row is what `Enter` opens in the trace, and a thread of one call (a review agent) had no way in without it. A round directly under the trace gets a row as well. Direct tool spans nest beneath the latest completed call in the same scope before the tool starts. Their entire subtrees move together, so bracket navigation skips them between LLM calls. This only changes display order and depth; span extents, request durations and self-time stay unchanged.

Rounds compare the recorded `MessageThread.id`, which survives serialization. Ordinary tool invocations can create separate thread stores in one process, so their local registry numbers are insufficient for equality. A legacy round without recorded identity uses its containing span and local thread number. This can repeat context across old spans, but never merges unrelated histories. Handoffs that carry their caller's recorded identity share that history. Process scope remains useful for legacy thread labels, with ambiguous labels omitted.

`forest.ts` owns tree traversal and indexes: `walkNodes`, `walkWithDepth`, `findNode`, `ancestorsOf`, `nearestAncestor`, `rootOf` and `buildTreeIndex`. Screens and pure data modules use these helpers instead of adding recursive forest walkers. Records keyed by IDs from logs use null-prototype objects.

## Follow mode

`makeFollowWatcher` in `run.ts` owns one `makeLineReader(path, 0)` from `lib/statelog/lineReader.ts` and the log parsed from it: the events, the parse errors, and a line count. Its first read is the boot read. `f` toggles polling while retaining the reader, its byte offset, and the log, so appends between boot and the first poll remain available and toggling follow loses nothing.

The shell never sees text. Each poll parses only the lines appended since the last one, numbering them from the line count so a parse error names its line in the file, and hands the shell a new log that holds the old event objects plus the new ones. The shell rebuilds the forest from it and calls
`setData(roots)` on every numbered screen and every open overlay. Cursor and drill state is stored as IDs. An id that no longer resolves
falls back to the nearest ancestor, then to the first row. A zoomed window stays put while
an unzoomed one tracks the live end. A shrunken file, from rotation or truncation, gets a new
reader and an empty log, and the fallback path absorbs the renumbering. Running spans draw to the window end with a `⋯` cap.

The reader returns complete lines only. A file opened without `--follow` is treated as finished at boot, so its partial last line goes through the reader's `finish()`: kept when it is complete JSON, left out when it is a write cut off partway. Polls leave a partial last line alone, since the writer may be in the middle of it; the reader keeps those bytes, so a later poll completes the line and no parse error shows in the meantime.

Stdin and `agency remote logs` hand the viewer a parsed log (`RunViewerOpts.parsed`) instead of a file: `parseStatelogStream` in `lib/cli/logsView.ts` parses stdin as it arrives, and `traceLogsToEvents` checks the fetched records with `parseStatelogRecords`.

The viewer checks `--trace-id` against the log it read. When the id names no single trace and the log will not grow (no `--follow`), the viewer shows the message `resolveTraceIdArgument` builds and ends as `"noSuchTrace"`, which the CLI turns into exit code 1 after the terminal is restored. Under `--follow` it waits for the trace instead. Inside the runs explorer the focus comes from the explorer's own rows, so the check is skipped.

End-to-end regressions live in `followMode.test.ts` (append, toggle-rewind, truncation, a finished file's last line, a half-written line under follow, and the watcher keeping its parsed events) and
`lib/statelog/lineReader.test.ts` (UTF-8 split across chunks, lines longer than a chunk, `finish()`, offset rewind).

## Comments

A comment is a note on one row, stored beside the log in the run
directory's `comments.jsonl` (`docs/dev/evals/run-directory.md` describes
the store). In the viewer, comments are data in, like trace annotations:
the shell folds the store into a `RowMarks` map (`marks.ts`, trace ID →
row ID → threads) and hands it to every screen and open overlay through
`ScreenHost.setMarks`, next to `setData`. A painter does one lookup
(`marksForRow`) and draws `✎` for a person's comment or `⚑` for an agent's
in the gutter (`traceScreen.ts`, `timelineScreen.ts`). `payloadFor` appends
a `COMMENTS` section when its options carry threads, so the trace pane, the
detail overlay, and the CLI's `show` list them the same way, each comment
with its ID so a reply can name it. The picker counts a trace's comments
from the marks the viewer holds, so a loose file gets a count and it is
current after every `c`. The dictionaries have no prototype: IDs come from
logs and comment files.

One object in the shell, the comments source (`makeCommentsSource` in
`run.ts`), is the only viewer code that reads or writes comments.
`refresh` reads the store, builds marks, sends them, and redraws; `add`
writes and then refreshes; a write that fails (another writer holds the
lock, a read-only directory) is reported in the message bar and the viewer
stays up. Its callers never repeat that sequence: the `c` key, the follow
tick, and the session's `reload`. The viewer never computes an author; the
store it is handed carries one. Without a store (stdin), `c` says comments
are unavailable, as `f` does for follow.

The row a comment, an address, or a session `get` names is `focusedRow`
in `run.ts`: the row a detail overlay shows, else the active screen's
`selectedRowId`, else its `focusId`. A screen's `focusId` is not the
selected row; it names the row focus travels to on another screen (a user
turn's round, an interrupt's tool). `c` captures the whole comment target,
trace, row, and anchor, before its prompt opens, because a session
`navigate` can switch traces while the person types.

`c` is a shell binding that returns a `promptLine` action; the key loop
dispatches what a shell binding returns. The prompt owns the bottom row
while it is open, so `render()` called meanwhile (a follow poll, a
refresh, a session request) only marks the screen dirty, and the screen is
drawn once when the prompt closes. The follow watcher runs a second
callback on every tick, grown or not, because the comments file can change
while the log is idle; a restart that names no tick keeps the one it had.
The store compares the file's size before re-reading, since the tick fires
every 250ms.

An agent's reply to a person's comment is always shown under it; the `C`
toggle hides only the agent's own notes (`marksFrom` drops a thread no
human wrote in, so an agent note the person replied to stays). A shell
binding runs instead of a screen's on the same key, so `run.shell.test.ts`
checks every shell key against every screen's keys.

## Sessions

With `session: { dir }` in `RunViewerOpts`, the viewer starts a server on
a Unix socket in that directory and writes a record beside it
(`session/`). No value means no server, so no unit test opens a socket
unless it asks to. The CLI's file route and the explorer's drill-in pass
the sessions directory under the agent home; stdin passes nothing. The
record names the log and the comments file as absolute paths, because the
CLI runs from any directory and cannot tell from a statelog path alone
whether comments live in a run directory or in a sidecar.

The server is built on the same seam as the follow watcher: a request
arrives between key presses, is answered through a `SessionPort` the
shell builds from its host and its comments source, and ends with a
`render()`. The port has five functions: `focus` (the same `focusedRow`
lookup `A` uses), `navigate` (`selectTrace` when the trace differs, then
`switchTo("trace", rowId)`, or the trace screen's first visible row when no
row is named, also when that trace is already open; every refusal, a missing trace or row or one the trace screen's
settings or an active search hide, comes before the host changes, so the
person's trace, overlays, and screen stay as they were), `reloadComments`
(`commentsSource.refresh`), `pick` (the trace list, as `t` opens it), and
`notify`. A port call that throws answers the request with an error and
leaves the viewer up; a connection is answered once, on its first line,
and a client that never finishes its line is cut off by a timeout or a size
cap, and `stop` ends every open connection so quitting never waits on
one. A record that cannot be written after `listen` closes the socket and
leaves the viewer without a session, as a failed `listen` does. There is no request that writes
a comment: it would be saved under the viewer's author, the person, so the
CLI writes through its own store and sends `reload`. The server is started
inside the shell's `try`, and a listen failure gives a notice instead of
a server, so the follow watcher is always stopped on the way out.

The registry does one thing per function. `listRecords` only lists.
`probe` tells three states apart: the process is gone (`stale`), it is
alive and answers (`live`), or it is alive and does not answer within the
timeout (`not-responding`, which a viewer suspended with Ctrl+Z produces).
`removeStale` deletes only the stale, with paths built from the directory
and a pid, so it can only ever touch a viewer's own two files. Before
listening, the server removes a leftover socket at its own pid's paths,
since the terminal's signal handlers exit without the shell's `finally`.
An over-long socket path (104 bytes on macOS) and Windows each give a
notice instead of a server.

Imperative code lives in four places here: `server.ts` and `client.ts`
(sockets), `registry.ts` (files), and the wiring in `run.ts`. Everything
else in `session/` is a type or a pure function. To remove the feature:
delete `session/`, `lib/cli/logsSession/` (moving `chooseLog` out first,
since `lib/cli/logsQuery/` uses it), the `debug-logs` skill's session
steps, and the `session` option with its call sites in `run.ts` and the
two CLI routes. Comments, addresses, and `A` stay.

## The agent commands

`agency logs traces`, `outline`, and `search` (`lib/cli/logsQuery/`) let an
agent read a log without grepping it. Each command is a function from
parsed options to `{ text, json, exitCode }`; `register.ts` is the only
file that touches the process. They reuse the viewer's modules and add
three small pure ones: `lib/runDirectory/traceSelection.ts` (which traces
the flags pick), `lib/logsViewer/outlineText.ts` (a trace's rows as
records), and `lib/logsViewer/rowSearch.ts` (the search over one trace).

**Finding the log.** `chooseLog` in `lib/cli/logsSession/target.ts` is the
one place any logs command finds its log: `--log`, else the one open
viewer, else `log.logFile` from `agency.json` when no viewer is open, else
a refusal naming all three. Several open viewers are refused even when the
config names a log. `traces`, `outline`, and `search` probe the viewer
registry the way the `session` commands do, so an address `search` prints
is one `session show` finds in the same file. `configuredLog` is a function, called only on the
branch that needs it, so a broken `agency.json` cannot stop a command that
passed `--log`. An empty `logFile` counts as unset, because `--log stdout`
writes `""` there to cancel a configured file. A directory with no
`statelog.jsonl` that holds run directories is refused with a pointer to
`--csv`.

**Picking traces.** `selectTraces` takes anything with a `traceId` and a
`startedAt`, which `TraceSummary` has, so start time is computed once, in
`traceSummaries`. Traces sort newest first by start time and not by file
position, because concurrent runs interleave their lines. The flag
combinations are a table (`COMBINATIONS`) with one row for each of the
sixteen sets of the four flags, matched exactly. The viewer's trace picker
lists traces in file order; `--csv` and these commands sort by start time.

**Building a trace.** Each trace's forest is built from its own events,
the way `session show` builds it, and not in one pass over the file as the
viewer does. That keeps every printed address resolvable by `show`. Every
command builds every trace's forest, even `outline --trace X`, because the
start times that `--trace`, `--last`, and `--since` pick by come from
`traceSummaries`, which needs the forest. On a 70 MB log of 89 traces,
reading the file takes about 0.35 s and building every transcript about
0.85 s, so each command finishes in under two seconds.

**The outline.** `outlineLines` is `storyOutline` with one more filter:
`hiddenByDefault` in `story.ts`, the rule the trace screen's `matches()`
also calls, hides approved interrupts unless `--approvals` (or `--admin`,
which needs them as parents for its handler decisions). There is no flag
for the `m` view, whose rows and ids differ from the story's.

**Search is a filter over transcript blocks.** The transcript already
decides which block a message belongs to: it keeps, per thread, a record of
every message a block has stood for, so a message repeated in every later
call's history is one block, on the call where it first appeared. Search
reuses that and adds no ownership rule of its own. `SEARCHED_BLOCKS` names
the block kinds searched and the `--kind` each reports. A tool call's
arguments are on two blocks, the assistant block that requested it and the
tool block, so they give two hits. An interrupt outside any tool has no
block, so search does not find it; the outline shows it.

**Blocks to rows.** `blockRowId` in `transcript.ts` is the one mapping from
a block to the story row it stands for. The transcript screen's `A`
(`selectedRowId`) and search both call it. It is a table (`BLOCK_ROWS`)
keyed by block kind. A system block keeps `roundId` undefined, since the
screen reads `roundId` for focus, and carries the call that first sent the
prompt as `ownerRoundId`. An error block finds the story row built from the
same node. The mapping looks ids up in the story and never parses one.

**Headers.** `headerLine` in `rowText.ts` is shared by `session show`,
`outline`, and `search`. A user turn's, an error's, and an interrupt's
header ends with the first non-blank line of its text, which can be a whole
paragraph, so `outline` and `search` cut headers to `HEADER_CHARS` with
`oneLine`; `show` prints them whole. An interrupt's message tells one kind
of action from another, as in `Interrupt · std::env · approved · Are you
sure you want to read this environment variable?`. Which variable is in the
interrupt's data, which the header does not show.

## The story outline

The trace screen shows one row per round, tool, interrupt, error, new user turn, LLM group or subprocess subagent. An `llmCall` span inside a tool becomes an `llmGroup` row, in a bold accent color, titled `Thread · <name> · N LLM calls` (`llmGroupTitle` in `story.ts`). A sub-agent that runs on its caller's thread is named by that thread too, so `Thread · main · 13 LLM calls` can sit under `Thread · main · 2 LLM calls`; naming the nested one by its tool was tried and read as a different kind of row. A top-level `llmCall` span becomes one only when a sibling `llmCall` span runs on a different thread (several `llm()` calls on one thread, as in a loop, stay flat): a conversation that runs beside the main one (an expression check, a watcher) then reads as its own thread, while a run with one conversation keeps its calls at the top and its rows at the same depth as before. A thread a tool started folds when complete; a top-level thread never folds by itself, because folding it would hide the run. Details does not repeat the owning tool, which the nesting already shows.

Thread names come from `Round.threadLabel` everywhere, so every screen changes together. A thread with a recorded label keeps it. One without is named after the tool that started it, so a sub-agent's thread reads as the sub-agent. A top-level thread has no starting tool and takes the node's name. The call's own `llm(label:)` tag is on `promptStart`, which the forest hides once the call completes, so it cannot serve as a name. A thread with none of these reads as `unnamed`. A group's payload is its title, one line of call count and models, one of wall time (the span's extent) against LLM time and cost, an error count in red, and the overview's three charts over just its calls: the completed calls and the requests that failed inside the span. The count and the charts cover the same errors, those whose nearest `llmCall` span is this one, so a nested thread's errors stay with its own group row. The charts are a `charts` payload line that `payloadPaint.ts` hands to `overviewCharts` with `CHART_BAR_ROWS` rows of bars, once per page of calls when more calls than fit the width, all on one scale, since a payload scrolls down and not across; the columns are sized by the widest call number drawn, as a group's calls keep their numbers from the whole trace. The tools every call shares are dropped from `enclosing` so the charts bracket only nesting inside the group. The screens pass the trace in `PayloadOptions.trace` for this; without it the summary stands alone. The latest response is gone, since the call's own row is one line down, and `r` retains access to the raw events. `storyOutline` puts each tool below the round that requested it. Interrupts and errors belong to the tool that emitted them; events from a nested tool do not change its parent tool's status.

A round has an ID such as `round:call-id:2`. Other event-backed rows use `leaf:parent-id:event-type:ordinal`, and a user turn uses its round ID plus `:user`. These IDs survive follow updates. Forest leaf IDs such as `evt-12` can change when a completed prompt hides its earlier start event, so the screen does not retain them as cursor IDs.

Press `m` to replace the story with the forest's own nesting. With `a` on too, every node beneath the trace has exactly one row. With `a` off, the forest omits admin subtrees. In the story, `a` adds handler decisions beneath their interrupt. `Enter` collapses or expands children, and does nothing on a row with none, such as an LLM call that requested no tool, which used to take the `▸` marker with nothing to hide. Completed LLM groups start folded when first encountered; running groups stay open. Automatic folds are tracked separately from manual folds, so machinery mode stays inspectable and explicit expansion survives follow updates. A group completes after a final model response or cancellation with no remaining running work. Groups containing the current selection are not automatically folded during updates. Successful approval rows are hidden by default and shown with `p`; search, the interrupt filter, and machinery/admin views retain access to them. In the outline, `[` and `]` move to the previous or next visible sibling, skipping descendants and stopping at the parent boundary. Filters retain matching rows and their ancestors.

The payload pane follows the outline cursor. The existing status row is split into Outline and Details headers: the active header uses an accent foreground, contrasting background, bold text and `▶ … ↑↓ scroll`. The divider stays neutral and leaves one blank character before the Details pane. Only an active outline gives the selected table row a background; its selection marker remains when Details is active. `Tab` switches panes; Left focuses Outline and Right focuses Details. Space pages down in the active pane; `r` shows raw JSON; `d` opens the same payload at full width. `payload.ts` computes unstyled records, and `screens/payloadPaint.ts` wraps text and highlights `code` fields as Agency source. `structured.ts` turns a value into those records: a field whose value fits on one line (a one-line string, a number, a boolean, null, an empty or short list of plain values) is a `pair`, painted `key: value` with the key in `THEME.key`; a nested value sits indented under its key, the key painted in `THEME.key` too, so a multi-line `value` argument reads like a one-line one; a list of two or more objects with the same flat fields is a `table`, which the painter draws as a header and one row per item when the columns fit the width and otherwise as `[0]`, `[1]`, … blocks of pairs. A one-line `code` field keeps its highlighting. Every screen that shows a payload (Overview, Trace, Transcript) shares this, so tool arguments, tool results, interrupt data and decision state all read the same way. Highlighted lines also wrap without discarding content. Both screens cache painted content until the row, raw toggle, width or data changes. Detail overlays keep the original story or span ID and resolve it again after each follow update.

Tool outcomes describe recorded evidence. A missing completion reads “completion not recorded.” A rejected interrupt does not establish whether work occurred earlier. Error flags can establish that work occurred or that the tool never started. `classifyTool` and `toolStatusText` own these judgments and labels. Tool-result sizes use an approximate token count: text length divided by four, rounded up, with compact JSON for structured results and successful Result wrappers unwrapped. The estimate excludes viewer formatting and message overhead.

`messageDelta.ts` compares each round with the previous round on the same recorded thread identity and the same `toolPath`, the tool calls it ran inside, recorded on `Round`. The first round at a path compares with the thread's last round anywhere; older logs use a conservative span-local key. The path matters because a sub-agent can run on its caller's thread, extending the caller's messages, and the caller then continues from its own last call, not the sub-agent's. The overview's `continues` line and input stub come from this comparison, and `transcript.ts` keeps its record of already-shown messages per thread and path the same way, a new path starting from the thread's latest record, so neither the sub-agent nor the caller repeats the other's messages. It compares messages as the text the model sees: `messageKey` turns non-string content into its JSON text, the same rule as smoltalk's `contentToString`, so a tool result saved as a value and the same result rebuilt as text (which a resumed run's thread holds) are one message and not a rewrite. The comparison still includes tool-call IDs and image data. A prefix extension adds only the new occurrences. A rewrite reports `firstChangedAt`, the position of the first message that differs, and adds only the messages from there; the Transcript shows them after a `HISTORY CHANGED from message N` block (`after message M` when the thread was only cut short), or `CONTEXT COMPACTED` when a `memoryCompaction` event sits between the two rounds on that thread.

## Decision-model calls

A call to a decision model such as Laya is not a chat: the model receives a state and a set of questions and returns answers with probabilities. The runtime records that on the `promptCompletion` event as `usageKind: "decision"` and a `decision` field (see `docs/dev/hosting/statelog.md`), and `Round.decision` carries it. `decision.ts` is the one place the viewer reads it: `decisionSummary` gives the row label (`decision · curious 86%`, the chosen answer with its probability; several questions read `department: billing 80% · churn: yes 97%`), `decisionInputPayload` shows the state and each question with its type, choices and instructions, and `decisionOutputPayload` shows each answer with its confidence and the highest probabilities as bars, up to `PROBABILITY_BARS`. Trace, Transcript and Timeline rows carry the summary; the Overview previews use the two payloads; the Transcript shows a decision call as one block and not as user messages leading to a JSON reply. That is deliberate: the prompt the decision model was asked is its `STATE` (or the questions' instructions), and showing it again as a user message would draw a chat the model never had. A later text call on the same thread may then reply to a message the reader saw only inside the decision block. A log without the fields is shown as an ordinary call; the viewer does not guess from `rawData`.

## Hosted tool calls

Some providers run tools themselves during a model call. OpenAI's and Anthropic's built-in web search are examples. The runtime never runs these tools, so the log has no `toolCallStart` or `toolCall` event for them. smoltalk records them on the call's `promptCompletion`, under `completion.hostedToolResults`. Each entry names the tool and the provider, and keeps the provider's own items in `raw`.

`hostedCalls.ts` is the one place the viewer reads that field. `roundsOf` calls `hostedCallsIn` once per round and keeps the result on `round.hostedCalls`, one `HostedCall` per call the provider made. Every screen draws its rows from that list. `CALL_READERS` is a table keyed by the type of a raw item:

| Raw item | Provider | One call per | Gist |
| --- | --- | --- | --- |
| `web_search_call` | OpenAI Responses | item | the queries, `open <url>`, or `find "<pattern>" in <url>` |
| `server_tool_use` | Anthropic | item, paired with the result item whose `tool_use_id` names it | the query, or the URL for `web_fetch` |

An Anthropic call failed only when its result has an `error_code`. A successful `web_fetch` or `code_execution` result is an object too, so being an object is not a failure. A call with no `id` is paired with no result.

A result with no raw item the table knows becomes one call per recorded query, or one call when it recorded no query. Gemini's grounding is one example, and a router that reports only citations is another. The provider does not say which query found which source, so each query's row lists all of the call's sources, and `r` shows the whole raw record. To support another provider, add a reader to the table.

The trace outline (`kind: "hosted"`), the timeline (`HostedRow`), and the transcript (a `hosted` block) put these calls under their LLM call, before the tools that call asked the runtime for. A title names a call `HOSTED TOOL CALL · <tool>` (`hostedCallTitle`), so it is never read as a tool the runtime ran: the trace details, the transcript box, and the timeline row and footer all use it. The trace outline and the transcript call list are too narrow for that title next to the queries, so they read `hosted · web_search`.

The log has no time for a hosted call. The timeline draws no bar for one. It prints the call's gist in the bar column, its duration column reads `—`, and the footer says `ran inside LLM call 5 · no timing recorded`. A hosted row has no event of its own; its node is its LLM call's. So `rowEvents` gives a hosted row no events. The trace search matches it by its own title and details, `r` shows that call's raw items, not the whole LLM call, and `agency logs session` puts those items under `providerItems`.

The trace draws hosted rows in both the story and machinery views. A screen asked to focus a hosted call it does not draw focuses the LLM call that ran it: `owningRowId` turns `round:L:0:hosted:1` into `round:L:0`. Without it, `parseRoundId` would read the hosted id as round `L:0:hosted`, find no such span, and leave focus where it was.

## Resumed runs

A run that paused for a person and resumed is several invocations, each with its own `agentRun` span, and the viewer reads them as one story:

- **Interrupts merge across runs.** A story interrupt is one row: its first occurrence's place and stable ID, with the latest outcome and who gave it (`approved by user`). An interrupt with a recorded `interruptId` merges across the whole trace, so the answer logged in the next run, under that run's own span, lands on the interrupt it answers under the tool that raised it. The first occurrence is the innermost tool's, because child spans walk before their parent's leaves, so a nested tool keeps ownership when the same id is logged at more than one level. Without a recorded id, only occurrences under one owner merge, as before.
- **Pauses are rows.** `runPauses` in `problems.ts` pairs each resolution with outcome `propagated` or `passed` (the interrupt went to a person) with the person's answer, the next resolution of the same interrupt with `resolvedBy: "user"`, falling back to the next `agentStart` for a log that recorded no answer; several runs can share one trace when a harness names it for a whole process tree, so another run's start must not end the wait. The Trace shows `── paused 14.2s · resumed ──` under the interrupt, or `paused · waiting for a response` while it still waits; the Transcript shows a `⏸ PAUSED` block placed by time on the tool's thread.
- **Older logs** from before span ids survived a resume hold spans whose `parent_span_id` names a span the log never recorded. `tree.ts` marks them `parentMissing`, they stay at the top level, and when any top-level row is one of them the top level is ordered by time so it lands where it happened (a log with none keeps log order), and their rows read `parent span not in this log`. Details lists the causes (a resume logged before span ids were kept, a log cut off mid-write, a file still being written, a subprocess whose parent span is in another file). Matching an orphan to a tool by name would be wrong whenever a tool is called twice, so the viewer states the fact and does not guess.

The Trace, Transcript and Timeline screens keep an independent `#` line-number toggle, off by default and retained through trace changes and follow updates. Trace outline numbers use the complete outline positions, so filtering and folding leave gaps. Timeline numbers the rows in the current drill view, folded rows included, so a fold leaves a gap like the trace and the gutter keeps the width of the whole view. Trace details and Transcript number wrapped text continuously before slicing for scrolling. `screens/lineNumbers.ts` reserves gutter width before wrapping and widens it when the total gains a digit. Numbers are presentation only; copy, search and selection still use the underlying records.

## The transcript

The screen is a header line, a context row, a call list 32 characters wide on the left, a divider, and the transcript as a column of boxes. The header reads `Elapsed 26m37s · 7m25s working · 19m12s waiting for the user · block 12 of 87`, with the split only when the trace has turns and the count over the blocks not hidden by a fold. The context row states the thread path of the pane's first row, `Thread · main · 2 LLM calls › researchAgent › Thread · main · 13 LLM calls`, in the timeline's drill-in vocabulary; it is blank for a trace with no thread rows. It is a row of its own rather than an overlay so that it never covers a box's title.

**The call list.** The call list indents two cells per level with the trace's levels: a thread row at its tool depth, the messages of its conversation one level in, a tool one level under the call that asked for it, and a sub-agent's thread row under that tool. A turn divider spans the threads and sits at the left, and a trace with no thread rows starts its messages at the left. One column holds a `▸` or `▾` for the blocks Enter opens: a system prompt, a tool, and a thread row, where it shows the fold. Thread rows read `Thread · name` and turn rows `turn 2 · the message`, both bold; user rows read `user` for the person and `prompt` for a message the program wrote; a hand-back row reads `↩ researchAgent`. The list takes the trace's colors: a tool row gold, a failed one red, a system prompt in chrome.

**Thread groups.** A `thread` block opens each `llmCall` span the first time one of its blocks appears, named as the trace names the span, `Thread · main · 13 LLM calls`, counting the span's own calls. A sub-agent that runs on its caller's thread (a handoff) gets a row of its own under the tool that started it, although the thread key never changes; grouping by span, not by key, is what matches the trace. A group that resumes after a nested one, as the caller does after a hand-back, gets no second row. A trace that is one span has no rows. Every block carries `groupPath`, the span ids it is inside, outermost first; a thread block carries `tool`, the tool that started it, and `complete`, the trace's fold rule for it.

**Folding.** A complete sub-agent group folds the first time it is seen, by the trace's rule and with its exceptions (`threadComplete`; a top-level thread never folds by itself; the group the cursor is inside is left open; a group that runs again unfolds, but only when the rule folded it, so a fold the reader made stays). Its row reads `══ THREAD · main · 13 LLM calls ══ ▸ folded · Enter opens`. Enter on the row toggles it, and a search match or a focus from another screen opens every fold on its path. The Replay.io session opens as 21 blocks with its two researcher runs folded, 102 with them open.

**Boxes.** Each message block (a system prompt, a user message, a prompt, a hand-back, an LLM call, a tool, history, an error) is drawn by `blockBox.ts` as a box: a top rule carrying the block's title (`USER`, `ASSISTANT · LLM call 3`, `TOOL CALL · grep`) with its stats on the right (`22.0s · 20k in · $0.0034` for a call, `12 lines · 3.2s` for a tool), the lines between side bars, and a bottom rule, in the block's kind color. A turn divider, a thread divider, a pause and a rewrite are not messages and stay as rules across the pane. The active box takes heavy rules and the cursor background, so it is findable anywhere in the pane and with `NO_COLOR`, and when Enter grows it the box that grew is the box that is marked. Below 60 cells of text the side bars go and only the rules remain, so an 80-column terminal still has room for words. A system block is drawn by the overview's `systemPromptPayload`: `SYSTEM`, the prompt's first line, and `… (+634 more lines · s to show)`. The painted blocks are cached by block, expansion, approvals, width, fold and active state, and the cache is cleared when the blocks are rebuilt.

**Nesting in the pane.** Boxes are not nested inside their caller's box and are not indented. A block inside a sub-agent's group gets a rail, `┃`, per level of tool depth on the left, in the accent color the thread labels use, and the whole row behind it takes the level's tint, the overview's `groupBg` shade for that level, so the sub-agent's conversation reads as a band inside its caller's wherever the pane is scrolled to, and the band's end is the hand-back. An indent alone does not survive scrolling: once the opening tool box is off the screen, an indented box reads as a narrower box.

**Scrolling.** The pane scrolls like a list. Moving the cursor scrolls only when the active box would leave the pane: up to its top when it is above, down to its bottom when it is below, to its top when it is taller than the pane. A box whose top is in view stays put, so a box Enter opens grows downward in place. A search match is scrolled to from its block's start. Paging scrolls by lines and moves the cursor to the block at the top of the pane; a page that cannot scroll leaves the cursor alone.

**Tool calls once.** A reply's box shows its text and one line, `→ 4 tool calls · grep, grep, readFile, typecheck`, since each tool has its own box next. A request no tool block stands for, such as a tool the runtime never ran, is shown whole in the reply's box (`unpaired` on the assistant block), arguments uncut, since nothing else will show it. A tool's box shows the arguments cut as on the trace's call row, a rejected or pending interrupt (an approved one only after `p`, as on the trace), a status line when the tool did not complete, errors always, and the result's first line under a rule, `── RESULT · ~4.4k tokens ──`, with `… (+46 more lines · Enter opens)`. Enter shows the arguments and result whole in the trace's tool-row shape under the same rule, then `── WHAT THE MODEL READ ──` when the reply the model read differs from the recorded output.

`transcript.ts` builds plain blocks from `roundsOf` and the story outline. Each round contributes the messages of its input that nothing has shown yet, its assistant completion, and its tools with results and interrupts. `transcriptPayload.ts` turns blocks into payload records; `transcriptScreen.ts` paints them with the shared payload painter.

**One conversation per thread.** What a thread has shown is one list, `shown`, in conversation order: its system prompts, the person's messages, each call's completion, and each tool's reply. A round's input is matched against it (`matchShown`) and only the unmatched messages become blocks. Each shown message is consumed once per round, so a message that appears twice is matched twice, and order is not required, since a tool that ran beside a handoff can have its reply land earlier in the shared history later. A sub-agent that runs on its caller's thread, a handoff, shares the caller's list, which is why it shows its work once; a list per thread and tool path would show everything the sub-agent added again as history when the caller resumes.

A message matches by its key (`represents`), with two allowances for what the runtime does to a history. A handoff leaves the completion's text in the caller's history with the call that dispatched it removed, so an assistant message with the same text and a subset of the completion's tool calls matches it. A tool reply matches the tool it answers by call id whatever its content, and when the content differs from the recorded output (a capped result, an error with the loop's advice appended) it is kept on the tool block as `modelSaw`, shown on Enter, and included in the block's search and copy text. A tool pairs with its request by its recorded call id, else by its name and position among the round's same-named tools (`requestFor`), the rule the trace uses for dropped nulls; arguments cannot be compared, because the runtime fills in defaults the model never sent. A tool no request can be found for is not represented, so its reply stays visible as history.

A rewrite is detected against the last round on the thread and the last at the round's tool path: when neither one's messages, system prompts aside, are all still in the input, the history was rewritten (`rewriteOf`). System prompts come and go with handoffs, so they do not count. A `memoryCompaction` event on the thread between the preceding and current round marks it "CONTEXT COMPACTED"; otherwise it says "HISTORY CHANGED." After a rewrite the shown list is cut to the messages the input kept, so a kept message is not repeated and a removed one cannot stand for a later message with the same text; a new system summary shows as a system block.

**Who wrote a user message.** A user-role message from a call inside a tool was written by the program for a sub-agent, and its box is titled `PROMPT · researchAgent`, named by the tool. When the trace records the person's messages as `turnStart` events, a top-level user message that starts with none of them is a prompt too, named by its thread (`PROMPT · sessionTitle` for the helper that titles a session). The user-role message the runtime pushes when a handoff returns, `[name finished. …]` or `[name stopped before finishing: …]`, is a `handback` block titled `HAND-BACK · name`. Everything else titled `USER` is the person.

**Turns.** When the trace has more than one `turnStart`, a `turn` block opens each: `⏸ waited 9m54s for the user` on the turn after a wait, then `══ TURN 2 · the message's first line ══` and `ran 7m25s · 13 LLM calls · $0.19`. Turn blocks are placed by time like errors and pauses (`withLooseBlocks`). A trace with one turn has none. An error or pause with no thread of its own takes the thread and group of the block it lands beside.

System blocks are unique per thread and exact text. Their IDs use the introducing round and position in the full input list. User and history IDs also use the round and full input position. Appending rounds preserves these IDs. Each system expands independently, and `s` chooses the latest preceding system on the cursor's thread, or that thread's first system if none precedes it.

The cursor moves by block; paging scrolls display lines. Search and copy use full block content even when collapsed. Search expands its match, reveals approvals when the match is only in an approved interrupt's message, and scrolls to the matching display line. A history block opens detail on the input round that contains it. A tool block shares its span ID; other blocks share their round ID, and system blocks have no round focus.

## Composing rows over lib/tui

- **Every child of a `row(...)` needs an explicit `width`.** A child
  without one gets `flex: 1`, and the layout engine splits the terminal
  width evenly across all flex children — so a table row composed of
  colored text segments drifts out of alignment with its header, with
  each column stretched to `cols / segmentCount`. Give every segment a
  fixed width that matches the header's padding.
- **Every composed row box needs `height: 1`.** A box without a height
  also gets `flex: 1` — on the main axis of the enclosing column this
  time — and stretches to absorb the leftover vertical space. A short
  list of composed rows renders with paragraphs of blank space between
  entries. (`line()` sets `height: 1` for exactly this reason; a
  hand-built `row(...)` must do the same.)

Declare columns and rows with `lib/tui/table.ts`, and
it applies both rules for you. For a row that is not a table, build it from
`segment(...)` in `lib/tui/paint.ts`, which returns a string of an exact
visible width, and wrap it with `paintedLine(content, { width })`.

Pass statelog text through `paint(text)` or `segment(text, width)` before
rendering it. They display style-like text such as `{bold}` literally and
replace ESC with `␛`, so recorded terminal escapes cannot change the output.
Use `paintAnsi(text)` for text whose ANSI colors should be interpreted.
The structural linter bans direct text builders under `screens/`. The payload painter escapes terminal controls before syntax highlighting.

## Keybinding and chrome conventions (shared with any sibling TUI)

- Number keys 1–4 choose screens. `t` opens the trace picker when there are several traces. `<` and `>` step between traces.
- Esc follows the same ladder: close help; let the overlay clear its state; close detail or occurrences; let the screen clear its state; return to overview; return to the traces list when there are several traces; return to the host when embedded; otherwise do nothing. On the traces list, Esc clears search before returning to the host or staying on the list. A terminal narrower than 100 columns returns directly to the host when embedded and otherwise does nothing.
- **Esc backs out until there is nothing left to back out of, and never
  quits; `q` quits the whole program instantly from any screen.** For a
  viewer hosted inside another TUI, `runViewer` takes `embedded: true`
  and resolves with `"back"` (Esc at the bottom of the stack, nothing
  left to clear) or `"quit"` (`q`), so the host can honor the same
  contract.
- Copying: `y` in trace copies the focused node's JSON; in transcript it copies the full block text. `A` on any screen copies the focused row's address. `Y` in the trace screen copies
  every statelog event of the focused trace as JSONL, one object per line in
  file order. Views only *name* what to copy, through the `copy` and
  `copyTrace` actions. The shell in `run.ts` owns the events and the
  clipboard. `x` in the trace screen extracts the focused trace to a file, and
  only when the source is a local file.
- The tab strip names the active screen, with no active tab on the traces list. Screens and overlays use `keyFooter` in `screens/chrome.ts` to combine their hints with the shell's shared commands. Trace uses `twoLineKeyFooter` and reserves a second footer row: complete commands fill the first row, and overflow joins the shared commands and title on the second. Other screens use one row. The page title sits at the bottom right in bold accent text on a contrasting background. The footer reserves room for that title and the shared commands, shortening the screen's hints when necessary; `?` lists every binding. The traces list has no separate title or total-count row. Search counts appear beside its query. Other screens keep useful status text above their content.

## Row IDs are a contract

Every row the viewer draws has an ID that survives follow updates, and the
four screens share them: the overview selects by round ID, the trace
outline's cursor is a row ID, a transcript block carries its round or span
ID, and the timeline opens the same rows. The shapes are:

| Row | ID | Example |
| --- | --- | --- |
| An LLM call (a round) | `round:<span id>:<ordinal>` | `round:span-7f3a:2` |
| The user turn before a round | `<round id>:user` | `round:span-7f3a:2:user` |
| A tool call | its span ID | `span-9c01` |
| A hosted tool call inside a round | `<round id>:hosted:<n>`, counting the round's hosted calls from 0 | `round:span-7f3a:2:hosted:0` |
| An interrupt, error, or other event under a parent | `leaf:<parent id>:<event type>:<ordinal>` | `leaf:span-9c01:interrupt:0` |

An **address** is `<trace id>/<row id>` (`address.ts`). `A` copies the
focused row's address on any screen, and a comment is stored against one.
No single character can split an address: a trace ID may contain slashes
(a hosted run), and a leaf directly under the trace root embeds the trace
ID in its own row ID (`leaf:trace-<trace id>:error:0`). `splitAddress`
therefore takes the trace IDs of the log the address names and uses the
longest one that starts the text; the CLI reads the log before it splits.
Text no trace ID starts is a bare row ID. The row ID is otherwise opaque:
rows are found by looking the ID up in the story (`findRow`), never by
parsing it. `parseRoundId` exists for rounds and the screens use it to fall
back to a round's span; do not add a general row-ID parser.

Changing these shapes breaks every stored comment, so treat them as a
contract. A comment also carries an anchor (the row's time, thread, and
name) so a reader can still say what it was about when its ID no longer
resolves.

## Adding a screen or an overlay

Add the painter under `screens/` and implement `Screen` for a numbered slot or `View` for an overlay. Declare its keys in one table. Give shared computations a pure module outside the painter. Keep follow state as IDs or absolute times, and use `forest.ts` for tree traversal. Round detail overlays retain the original round ID and resolve it again after every update, because event leaf IDs can change.

## Run directories

`agency logs <dir>` on a run directory ([`run-directory.md`](../evals/run-directory.md)) opens
this viewer on `<dir>/statelog.jsonl` with `traceAnnotations`: one line per
trace id ("notes · score 0.70 · labeled", built by `annotationSummaries`
in `lib/runDirectory/list.ts`) shown in the trace picker and shell header.
`focusTraceId` opens the requested trace; the runs explorer uses it when drilling from a test
into the run's shared statelog. Both are read once at open; follow mode
re-reads the statelog, not the annotations.
