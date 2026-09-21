# The logs viewer: screens, the timeline kernel, and follow mode

The interactive statelog viewer behind `agency logs` and `agency eval logs`. This page is
the architecture; the user-facing keys and screens are documented in
`docs/site/guide/observability.md`. The cross-run explorer (`agency logs` over run
directories) is a separate app that embeds this viewer, described in
[`runs-explorer.md`](./runs-explorer.md).

## Screens and overlays

`ScreenHost` owns four numbered screens: overview, trace, transcript and timeline. It keeps a separate, initially empty stack of overlays. The top overlay receives keys and renders while it is open; otherwise the active screen does. Switching screens carries the focused span or stable round ID to the destination and closes overlays.

The shell in `run.ts` owns the terminal, follow watcher, help, clipboard and extraction. A view returns a `ViewAction` when it needs one of these operations. It receives the inner viewport for paging, excluding the tab strip and parse-error footer.

```ts
type View = {
  handleKey(event: KeyEvent, viewport: Viewport): ViewAction;
  render(viewport: Viewport): Element;
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

A pure module computes plain records. One painter per screen draws those records and owns the TUI imports. The bar components in `views/shared.ts` predate this rule and keep their existing compute/render organization.

The overview fills slot 1, the trace outline slot 2, the transcript slot 3, and the timeline slot 4. Selecting a time group in the overview opens its occurrences as an overlay. Round and tool focus survives all screen transitions, including a trip through overview. A missing ID falls back to its nearest surviving ancestor, then the first row.

## Key tables

A `KeyBinding<Action>` gives a set of keys, help text, an optional footer hint, an optional availability condition and an action. `handleKey`, `helpLines()` and the footer derive from that table through `runViewerKey`, `helpFrom` and `hintsFrom`. A new screen must not contain an `if (key === …)` chain. `cursorBindings` supplies the shared movement keys. Ctrl+D/U moves half a page; Ctrl+F/B and PageDown/Up move a full page.

The shell table includes Esc, quit, follow, help, screen selection and trace navigation. Its control bindings run over help and the narrow-terminal message. Help uses the shared cursor bindings to scroll; non-navigation keys dismiss it, and Esc closes it through the usual ladder.

The generic table helpers live in `lib/tui/keymap.ts`. The viewer-specific wrapper lives in `lib/logsViewer/keymap.ts`. The runs explorer retains its existing key handlers.

## The trace picker

The picker shows each trace's starting time, duration, rounds, token total, cost, ask and annotation. A `●` marks the current trace and `✖` marks a recorded error. Annotations occupy display lines under their trace; scrolling counts those lines.

`traceTexts` collects string values from event data, including prompts, answers, nested tool payloads and errors. It does not search serialized JSON, because escaping would hide literal quotes and line breaks. The picker computes these strings on each parse and filters them as you type.

A `TraceFilter` declares an ID, label and a predicate over `TraceSummary`. Every active filter must accept a trace for it to appear. To add a filter, create its predicate and put it in the picker's filter list. The text search is the first filter.

`capturesText()` is true while editing. The shell then sends q, f, ?, digits and other printable characters to the picker. Enter finishes editing; another Enter opens the selected trace. A nonempty query opens slot 2 and searches that trace's payloads, regardless of which screen was underneath the picker.

At boot, multiple traces with no requested focus open the picker over the most recent trace. A single trace or `focusTraceId` opens its overview directly. Follow updates never reopen the picker. The picker is only a boot decision or an explicit request.

## The timeline kernel (`lib/logsViewer/timeline/`)

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
- `groups.ts` — the overview time-panel grouping, via `groupSpans(spans, root, index?)`. LLM calls group by **thread label** (from
  `threadCreated` events, scoped to the nearest enclosing `subprocessRun` span because
  thread ids restart per process), else the **enclosing function**, else the model;
  everything else groups by its display name. Grouping lives in the kernel because two
  consumers use it (the overview displays groups, occurrences resolves a key back to members)
  and a follow-mode re-parse can legitimately re-group a call — one computation, two
  readers. A group's share is of wall clock and may exceed 100% for parallel work; that is
  the sum of concurrent work.

`TimelineSpan` carries no names and no `TreeNode` reference. Naming is a view opinion, so
label components look nodes up by id, and the kernel's output stays plain serializable
data. Shared span names and argument summaries live in `spanText.ts`. `theme.ts` owns the colors and threshold tones. Slow or expensive metrics include a `!` marker so their meaning does not depend on color.

`rounds.ts` emits one `Round` per completion. A single `llmCall` span can contain an entire tool loop, so a round needs its own ID: `round:<span id>:<ordinal>`. The ordinal is local to the span; the displayed round number follows completion time across the trace. Timeline rows use `drawsRoundRows` to suppress a lone round beneath a drawn call span. A round directly under the trace always gets a row.

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

The trace screen shows one row per round, tool, interrupt, error, new user turn or subagent. `storyOutline` puts each tool below the round that requested it. Interrupts and errors belong to the tool that emitted them; events from a nested tool do not change its parent tool's status.

A round has an ID such as `round:call-id:2`. Other event-backed rows use `leaf:parent-id:event-type:ordinal`, and a user turn uses its round ID plus `:user`. These IDs survive follow updates. Forest leaf IDs such as `evt-12` can change when a completed prompt hides its earlier start event, so the screen does not retain them as cursor IDs.

Press `m` to replace the story with the forest's own nesting. With `a` on too, every node beneath the trace has exactly one row. With `a` off, the forest omits admin subtrees. In the story, `a` adds handler decisions beneath their interrupt. `Enter` collapses or expands children. Filters retain matching rows and their ancestors.

The payload pane follows the outline cursor. `Tab` moves scrolling into the payload; `r` shows raw JSON; `d` opens the same payload at full width. `payload.ts` computes unstyled records, and `screens/payloadPaint.ts` wraps text and highlights whole code blocks. Both screens cache painted content until the row, raw toggle, width or data changes. Detail overlays keep the original story or span ID and resolve it again after each follow update.

Tool outcomes describe recorded evidence. A missing completion reads “completion not recorded.” A rejected interrupt does not establish whether work occurred earlier. Error flags can establish that work occurred or that the tool never started. `classifyTool` and `toolStatusText` own these judgments and labels.

`messageDelta.ts` compares each round with the previous round on the same recorded thread identity, using a conservative span-local key for older logs. It compares normalized full message contents, including tool-call IDs and image data. A prefix extension adds only the new occurrences; a rewrite retains the entire replacement history and its before/after counts.

## The transcript

`transcript.ts` builds plain blocks from `roundsOf`, `roundDeltas` and the story outline. Each round contributes new input messages, its assistant completion, and its tools with results and interrupts. `transcriptPayload.ts` turns blocks into payload records; `transcriptScreen.ts` paints them with the shared payload painter.

Suppression requires an exact message occurrence on the same thread. Each thread has a pending array of completion and tool messages already represented by blocks. Each matching input occurrence consumes one entry. After processing an input snapshot, the array is replaced by that round's represented messages. A tool candidate needs one unambiguous request with matching name and arguments, a call ID and a completed result. The wire accessor unwraps the same outer successful Result as the producer. Full message equality still checks reply content, IDs, names and requests. Caps, attachments, uncertain conversions, repeated ambiguous requests and unmatched refusals stay visible as history.

A rewrite clears pending suppression and displays the replacement history. A `memoryCompaction` event between the preceding and current round marks it “CONTEXT COMPACTED”; otherwise it says “HISTORY REWRITTEN.” New system-role summaries remain visible. The synthetic rewrite fixture follows this producer shape; no real compaction log was available for the recorded fixture.

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

`lib/tui/table.ts` is that component: declare columns and hand it rows, and
it applies both rules for you. For a row that is not a table, build it from
`segment(...)` in `lib/tui/paint.ts`, which returns a string of an exact
visible width, and wrap it with `paintedLine(content, { width })`.

Text from a statelog must never reach `line()` directly. The style parser
swallows a brace group it recognizes (`{bold}`, anything ending in `-fg`),
and escaping changes a string's length without changing its width.
`paint.ts` handles both; its `Painted` type is how the compiler checks that
a string went through it. The structural linter bans direct text builders under `screens/`; statelog text goes through `paint` or the payload painter, which escapes terminal controls before syntax highlighting.

## Keybinding and chrome conventions (shared with any sibling TUI)

- Number keys 1–4 choose screens. `t` opens the trace picker when there are several traces. `<` and `>` step between traces.
- Esc follows the same ladder: close help; let the overlay clear its state; close the overlay; let the screen clear its state; return to overview; return to the host when embedded; otherwise do nothing. A terminal narrower than 100 columns returns directly to the host when embedded and otherwise does nothing.
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
- The tab strip names the active screen. Each screen derives its footer from its binding table. Overlay footers use `bottomHints` in `views/shared.ts`.

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
