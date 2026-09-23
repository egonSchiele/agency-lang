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

The overview stacks context, cost and request duration charts beside a full-height response preview. `overviewData.ts` supplies the trace summary and completed requests. `screens/overviewCharts.ts` paints all three charts with a shared call window, column width and selected ID, using maxima over the entire trace for stable scales. A model context ceiling is used only for a single-model trace. Column slots grow to fit full call numbers.

`OverviewScreen` owns selection by stable round ID and independent input/output preview scroll offsets. Tab switches modes; the mode persists across call selection. System and developer prompts in input start collapsed and expand together with `s`. Left/right changes the call; g/G and Home/End select the first/last call. Ctrl+F/B move a full chart page and Ctrl+D/U half a page, using the same column capacity as the painter and the current viewport width. Up/down and PageUp/PageDown scroll the preview beneath pinned metrics; Ctrl+Home/End jump to its start/end. A changed selection resets scroll, while follow updates retain the ID or fall back to the first remaining call. Arriving from a tool previews its owning story call and retains the tool ID for the return trip until the user selects a call. `roundResponsePayload` shares completion and requested-tool formatting with trace detail. `roundInputPayload` reads the complete recorded `messages` array, labels roles and tool-call IDs, and retains structured content parts. Missing input is distinguished from an empty message list. The screen lazily caches painted input and output separately for the selected round and width, invalidating both when either changes and only input when system visibility changes. Graph height adapts to terminal height; the footer stays at the bottom.

## Key tables

A `KeyBinding<Action>` gives a set of keys, help text, an optional footer hint, an optional availability condition and an action. `handleKey`, `helpLines()` and the footer derive from that table through `runViewerKey`, `helpFrom` and `hintsFrom`. A new screen must not contain an `if (key === …)` chain. `cursorBindings` supplies the shared movement keys. Ctrl+D/U moves half a page; Ctrl+F/B and PageDown/Up move a full page.

The shell table includes Esc, quit, follow, help, screen selection and trace navigation. Its control bindings run over help and the narrow-terminal message. Help uses the shared cursor bindings to scroll; non-navigation keys dismiss it, and Esc closes it through the usual ladder.

The generic table helpers live in `lib/tui/keymap.ts`. The viewer-specific wrapper lives in `lib/logsViewer/keymap.ts`. The runs explorer retains its existing key handlers.

## The trace picker

The picker shows each trace's starting time, duration, LLM calls, token total, cost, ask and annotation. `fmtStartedAt` formats the start as a full local date and 12-hour time with seconds; the column is labeled `Started (local)` and aligns days and hours. The highlighted row is the selection; `✖` marks a recorded error. The shell header reads the picker's selection for its trace ID, position and annotation. When no traces match, it omits those fields. Annotations occupy display lines under their trace; scrolling counts those lines.

While the picker is open, no numbered tab is marked active. Enter opens the highlighted trace's overview, or its trace screen when searching. Number keys open the highlighted trace in the corresponding screen. The picker uses the overlay stack, but Esc treats it as the outermost page: clear its search, then return to the embedding app or stay on the list when standalone. Esc from overview opens the picker when the log has several traces.

`traceTexts` collects string values from event data, including prompts, answers, nested tool payloads and errors. It does not search serialized JSON, because escaping would hide literal quotes and line breaks. The picker computes these strings on each parse and filters them as you type.

A `TraceFilter` declares an ID, label and a predicate over `TraceSummary`. Every active filter must accept a trace for it to appear. To add a filter, create its predicate and put it in the picker's filter list. The text search is the first filter.

`capturesText()` is true while editing. The shell then sends q, f, ?, digits and other printable characters to the picker. Enter finishes editing; another Enter opens the selected trace. A nonempty query opens slot 2 and searches that trace's payloads, regardless of which screen was underneath the picker.

At boot, multiple traces with no requested focus open the picker over the most recent trace. A single trace or `focusTraceId` opens its overview directly. Follow updates never reopen the picker. The picker is only a boot decision or an explicit request.

## The timeline kernel (`lib/logsViewer/timeline/`)

Timeline uses `[` and `]` to select the previous or next sibling in its displayed row hierarchy. It skips descendants, stops at parent boundaries, and does not wrap. This works in drilled and zoomed views without changing the time window. Panning uses `{` and `}` while zoomed.

Timeline labels enclosing `llmCall` spans `Thread · <name>` in bold accent text, matching Trace. Names come from the span's recorded calls, with `unnamed` when unavailable; breadcrumbs and the selection footer use the same label. Individual requests retain their `LLM call N` labels, and tool rows retain their argument summaries.

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

`rounds.ts` emits one `Round` per completion. The UI labels these “LLM calls”; internal types and stable IDs retain the name `Round`. A single `llmCall` span can contain an entire tool loop, so a round needs its own ID: `round:<span id>:<ordinal>`. The ordinal is local to the span; the displayed round number follows completion time across the trace. Timeline suppresses a lone round beneath a drawn call span unless it owns tool calls. A round directly under the trace always gets a row. Direct tool spans nest beneath the latest completed call in the same scope before the tool starts. Their entire subtrees move together, so bracket navigation skips them between LLM calls. This only changes display order and depth; span extents, request durations and self-time stay unchanged.

Rounds compare the recorded `MessageThread.id`, which survives serialization. Ordinary tool invocations can create separate thread stores in one process, so their local registry numbers are insufficient for equality. A legacy round without recorded identity uses its containing span and local thread number. This can repeat context across old spans, but never merges unrelated histories. Handoffs that carry their caller's recorded identity share that history. Process scope remains useful for legacy thread labels, with ambiguous labels omitted.

`forest.ts` owns tree traversal and indexes: `walkNodes`, `walkWithDepth`, `findNode`, `ancestorsOf`, `nearestAncestor`, `rootOf` and `buildTreeIndex`. Screens and pure data modules use these helpers instead of adding recursive forest walkers. Records keyed by IDs from logs use null-prototype objects.

## Follow mode

`makeFollowWatcher` in `run.ts` owns one `makeAppendReader(path, 0)` from `lib/statelog/appendReader.ts`. Its first read supplies the boot text. `f` toggles polling while retaining the reader and byte offset. Appends between boot and the first poll remain available, and toggling follow does not reset accumulated text.

On growth the shell re-parses the accumulated text, rebuilds the forest, and calls
`setData(roots)` on every numbered screen and every open overlay. Cursor and drill state is stored as IDs. An id that no longer resolves
falls back to the nearest ancestor, then to the first row. A zoomed window stays put while
an unzoomed one tracks the live end. A shrunken file, from rotation or truncation, resets
the reader and the accumulator, and the fallback path absorbs the renumbering. Running spans draw to the window end with a `⋯` cap.

End-to-end regressions live in `followMode.test.ts` (append, toggle-rewind, truncation) and
`lib/statelog/appendReader.test.ts` (UTF-8 split across read boundaries, offset rewind).

## The story outline

The trace screen shows one row per round, tool, interrupt, error, new user turn, LLM group or subprocess subagent. Nested `llmCall` spans become `llmGroup` rows labeled `Thread · <name>`, with a bold accent color. The label uses recorded thread names, or `unnamed` when unavailable, and makes no claim that the group starts a new thread. The owning tool remains separate metadata in Details. Group payloads summarize only that span’s completed calls and render its latest response; `r` retains access to the raw events. `storyOutline` puts each tool below the round that requested it. Interrupts and errors belong to the tool that emitted them; events from a nested tool do not change its parent tool's status.

A round has an ID such as `round:call-id:2`. Other event-backed rows use `leaf:parent-id:event-type:ordinal`, and a user turn uses its round ID plus `:user`. These IDs survive follow updates. Forest leaf IDs such as `evt-12` can change when a completed prompt hides its earlier start event, so the screen does not retain them as cursor IDs.

Press `m` to replace the story with the forest's own nesting. With `a` on too, every node beneath the trace has exactly one row. With `a` off, the forest omits admin subtrees. In the story, `a` adds handler decisions beneath their interrupt. `Enter` collapses or expands children. Completed LLM groups start folded when first encountered; running groups stay open. Automatic folds are tracked separately from manual folds, so machinery mode stays inspectable and explicit expansion survives follow updates. A group completes after a final model response or cancellation with no remaining running work. Groups containing the current selection are not automatically folded during updates. Successful approval rows are hidden by default and shown with `p`; search, the interrupt filter, and machinery/admin views retain access to them. In the outline, `[` and `]` move to the previous or next visible sibling, skipping descendants and stopping at the parent boundary. Filters retain matching rows and their ancestors.

The payload pane follows the outline cursor. The existing status row is split into Outline and Details headers: the active header uses an accent foreground, contrasting background, bold text and `▶ … ↑↓ scroll`. The divider stays neutral and leaves one blank character before the Details pane. Only an active outline gives the selected table row a background; its selection marker remains when Details is active. `Tab` switches panes; Left focuses Outline and Right focuses Details. Space pages down in the active pane; `r` shows raw JSON; `d` opens the same payload at full width. `payload.ts` computes unstyled records, and `screens/payloadPaint.ts` wraps text and highlights `code` fields as Agency source. Highlighted lines also wrap without discarding content. Both screens cache painted content until the row, raw toggle, width or data changes. Detail overlays keep the original story or span ID and resolve it again after each follow update.

Tool outcomes describe recorded evidence. A missing completion reads “completion not recorded.” A rejected interrupt does not establish whether work occurred earlier. Error flags can establish that work occurred or that the tool never started. `classifyTool` and `toolStatusText` own these judgments and labels. Tool-result sizes use an approximate token count: text length divided by four, rounded up, with compact JSON for structured results and successful Result wrappers unwrapped. The estimate excludes viewer formatting and message overhead.

`messageDelta.ts` compares each round with the previous round on the same recorded thread identity, using a conservative span-local key for older logs. It compares normalized full message contents, including tool-call IDs and image data. A prefix extension adds only the new occurrences; a rewrite retains the entire replacement history and its before/after counts.

The Trace, Transcript and Timeline screens keep an independent `#` line-number toggle, off by default and retained through trace changes and follow updates. Trace outline numbers use the complete outline positions, so filtering and folding leave gaps. Timeline numbers the rows in the current drill view. Trace details and Transcript number wrapped text continuously before slicing for scrolling. `screens/lineNumbers.ts` reserves gutter width before wrapping and widens it when the total gains a digit. Numbers are presentation only; copy, search and selection still use the underlying records.

## The transcript

The left call list is 28 characters wide. User labels use the user blue, and LLM call labels use the assistant green. A vertical divider and one blank character separate it from the transcript text.

`transcript.ts` builds plain blocks from `roundsOf`, `roundDeltas` and the story outline. Each round contributes new input messages, its assistant completion, and its tools with results and interrupts. `transcriptPayload.ts` turns blocks into payload records; `transcriptScreen.ts` paints them with the shared payload painter.

Each thread tracks completion and tool messages already represented by blocks. A matching input message consumes one tracked occurrence. After processing a round, only that round's represented messages remain eligible for suppression.

A completed tool pairs with a request by recorded call ID when available. Older records use the tool name and arguments, ignoring object key order and allowing top-level null request fields omitted from the recorded arguments. Recorded null values remain significant. Ambiguous matches stay visible.

The wire accessor unwraps the outer successful Result and supplies the runtime's placeholder for a successful call without a value. Full message equality checks reply content, IDs, names and requests before suppressing an occurrence. Capped results, attachments, uncertain conversions and unmatched refusals stay visible as history.

A rewrite clears pending suppression and displays the replacement history. A `memoryCompaction` event on the same thread between the preceding and current round marks it “CONTEXT COMPACTED”; otherwise it says “HISTORY REWRITTEN.” Events without a recorded thread identity use the nearest enclosing span with an unambiguous round thread. New system-role summaries remain visible.

System blocks are unique per thread and exact text. Their IDs use the introducing round and position in the full input list. User and history IDs also use the round and full input position. Appending rounds preserves these IDs. Each system expands independently, and `s` chooses the latest preceding system on the cursor's thread, or that thread's first system if none precedes it.

The cursor moves by block; paging scrolls display lines. Search and copy use full block content even when collapsed. Search expands its match and reveals the matching display line. A history block opens detail on the input round that contains it. A tool block shares its span ID; other blocks share their round ID, and system blocks have no round focus.

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
- Copying: `y` in trace copies the focused node's JSON; in transcript it copies the full block text. `Y` in the trace screen copies
  every statelog event of the focused trace as JSONL, one object per line in
  file order. Views only *name* what to copy, through the `copy` and
  `copyTrace` actions. The shell in `run.ts` owns the events and the
  clipboard. `x` in the trace screen extracts the focused trace to a file, and
  only when the source is a local file.
- The tab strip names the active screen, with no active tab on the traces list. Screens and overlays use `keyFooter` in `screens/chrome.ts` to combine their hints with the shell's shared commands. Trace uses `twoLineKeyFooter` and reserves a second footer row: complete commands fill the first row, and overflow joins the shared commands and title on the second. Other screens use one row. The page title sits at the bottom right in bold accent text on a contrasting background. The footer reserves room for that title and the shared commands, shortening the screen's hints when necessary; `?` lists every binding. The traces list has no separate title or total-count row. Search counts appear beside its query. Other screens keep useful status text above their content.

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
