# The logs viewer: component views, the timeline kernel, and follow mode

The interactive statelog viewer behind `agency logs` and `agency eval logs`. This page is
the architecture; the user-facing keys and views are documented in
`docs/site/guide/observability.md`. The CROSS-run explorer (`agency logs` over run
directories) is a separate app that embeds this viewer, described in
[`runs-explorer.md`](./runs-explorer.md).

## The component model

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

Pure modules compute plain records. Screen painters draw those records and own the TUI imports.

`LegacyTraceScreen` adapts `TreeView` to slot 2. The viewer starts on the trace screen. Slots 1 and 3 show placeholders. Embedded viewers skip the placeholder overview when Esc returns to the host.

## Key tables

A `KeyBinding<Action>` gives a set of keys, help text, an optional footer hint, an optional availability condition and an action. `handleKey`, `helpLines()` and the footer derive from that table through `runViewerKey`, `helpFrom` and `hintsFrom`. A new screen must not contain an `if (key === …)` chain. `cursorBindings` supplies the shared movement keys. Ctrl+D/U moves half a page; Ctrl+F/B and PageDown/Up move a full page.

The generic table helpers live in `lib/tui/keymap.ts`. The viewer-specific wrapper lives in `lib/logsViewer/keymap.ts`. The runs explorer retains its existing key handlers.

## The trace picker

The picker shows each trace's starting time, duration, rounds, token total, cost, ask and annotation. A `●` marks the current trace and `✖` marks a recorded error. Annotations occupy display lines under their trace; scrolling counts those lines.

`traceTexts` collects string values from event data, including prompts, answers, nested tool payloads and errors. It does not search serialized JSON, because escaping would hide literal quotes and line breaks. The picker computes these strings on each parse and filters them as you type.

A `TraceFilter` declares an ID, label and a predicate over `TraceSummary`. Every active filter must accept a trace for it to appear. To add a filter, create its predicate and put it in the picker's filter list. The text search is the first filter.

`capturesText()` is true while editing. The shell then sends q, f, ?, digits and other printable characters to the picker. Enter finishes editing; another Enter opens the selected trace. A nonempty query opens slot 2 and searches that trace's payloads, regardless of which screen was underneath the picker.

At boot, multiple traces with no requested focus open the picker over the most recent trace. A single trace or `focusTraceId` opens directly. Follow updates never reopen the picker.

## The timeline kernel (`lib/logsViewer/timeline/`)

Three pure modules whose outputs must be identical across views, and which the planned
cross-run analysis project can reuse without a TUI:

- `intervals.ts` — interval arithmetic. `subtract(base, pieces)` removes the UNION of the
  pieces (clamped into the base, so malformed logs cannot produce negative residue);
  `coverage(intervals, window, cells)` returns per-cell busyness fractions.
- `spans.ts` — `timelineSpans(root, { hideKinds })` turns a span subtree into plain timed
  data. A span's **extent** is the envelope over ALL descendant leaf events
  (`timestamp − timeTaken` to `timestamp` — the same rule `tree.ts` uses for duration,
  which is what keeps parent ⊇ child and self-time non-negative). A span's **self-time**
  is its extent minus its direct children's extents. Without self-time the top-level
  `llmCall` span wraps the agent's whole tool loop and absorbs the entire run; the
  prototype measured a 193% share. `running` is true when a start-marking event has no
  terminus, and `promptCancelled` counts as a terminus. The admin spans listed in
  `ADMIN_KINDS` (`handlerChain` and `threadEndHooks`) are filtered presentationally: rows
  disappear and depths close up, while extents and self-time stay untouched.
- `groups.ts` — the by-name grouping, via `groupSpans(spans, root, index?)`. LLM calls group by **thread label** (from
  `threadCreated` events, scoped to the nearest enclosing `subprocessRun` span because
  thread ids restart per process), else the **enclosing function**, else the model;
  everything else groups by its display name. Grouping lives in the kernel because two
  views consume it (by-name displays groups, occurrences resolves a key back to members)
  and a follow-mode re-parse can legitimately re-group a call — one computation, two
  readers. A group's share is of wall clock and may exceed 100% for parallel work; that is
  real compute time, not the nesting bug self-time fixes.

`TimelineSpan` carries no names and no `TreeNode` reference. Naming is a view opinion, so
label components look nodes up by id, and the kernel's output stays plain serializable
data. Span naming and text formatting shared with the tree live in `spanText.ts` (lifted
from `summary.ts`): `spanDetail`, `lastUserMessage`, `fmtDuration`, threshold colors — one
implementation, so a span cannot read differently in two views of the same session.

## Follow mode

`makeFollowWatcher` in `run.ts` owns ONE `makeAppendReader(path, 0)`
(`lib/statelog/appendReader.ts`), created at boot. Its first `read()` IS the boot read,
returned as `bootText`. `f` toggles polling only. The reader and its byte offset persist
for the whole session. This kills the two bugs that made follow dead on
arrival, by construction:

- **the boot gap**: the old CLI pre-read the file, then the watcher started reading at the
  file's *current* size. Anything appended in between was never parsed.
- **the accumulator rewind**: toggling `f` off/on re-seeded the accumulated text from the
  boot snapshot, silently dropping earlier appends.

On growth the shell re-parses the accumulated text, rebuilds the forest, and calls
`setData(roots)` on every numbered screen and every open overlay. `setData`'s contract has four parts.
Cursor and drill state is stored as ids, so it survives. An id that no longer resolves
falls back to the nearest ancestor, then to the first row. A zoomed window stays put while
an unzoomed one tracks the live end. A shrunken file, from rotation or truncation, resets
the reader and the accumulator, and the fallback path absorbs the renumbering. Running
spans draw to the window end with a `⋯` cap, so a live call cannot read as "done, and
fast".

End-to-end regressions live in `followMode.test.ts` (append, toggle-rewind, truncation) and
`lib/statelog/appendReader.test.ts` (UTF-8 split across read boundaries, offset rewind).

## Folding a long message

An agent's system prompt is hundreds of lines long and is resent on every
round, so expanding a trace buried the conversation under it — a real agent
trace came to 2,181 rows, 1,841 of them copies of two long messages.

`messageRows` in `treeRows.ts` lays out a transcript a message at a time. Under
`FOLD_MESSAGE_LINES` (15) display lines a message becomes flat `convoLine`
rows; at or over it, one `convoMessage` header owning those lines as children,
so they appear only when the header is expanded. Both the `promptCompletion`
leaf and the flattened `llmCall` span go through it.

No keybinding changed, because `e` and `z` add ids from the persistent forest
and these headers are synthetic. Two places do have to know about them:

- `collapseSubtree` (`E`) deletes real-forest ids, which would leave an opened
  fold in the expanded set to spring back the next time you opened its span. It
  also drops expanded ids namespaced under the node.
- `search.ts` walks the hidden lines and, in `expandSyntheticAncestors`, opens
  the fold around a match, or `/` would highlight a row `n` could never reach.

## Composing rows over lib/tui: two layout rules that will bite you

Both were found the hard way while building tables (the runs-explorer
prototype hit each one as a visible rendering bug):

- **Every child of a `row(...)` needs an explicit `width`.** A child
  without one gets `flex: 1`, and the layout engine SPLITS the terminal
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

Use `TableComponent` from `lib/tui/table.ts` for tables. It sets cell widths
and row heights. To compose another kind of row, use `segment(text, width)`
from `lib/tui/paint.ts` for each part, then `paintedLine(content, { width })`.

Pass statelog text through `paint(text)` or `segment(text, width)` before
rendering it. They display style-like text such as `{bold}` literally and
replace ESC with `␛`, so recorded terminal escapes cannot change the output.
Use `paintAnsi(text)` for text whose ANSI colors should be interpreted.

## Keybinding and chrome conventions (shared with any sibling TUI)

- Number keys 1–4 choose screens. `t` opens the trace picker when there are several traces. `<` and `>` step between traces.
- Esc follows the same ladder: close help; let the overlay clear its state; close the overlay; let the screen clear its state; return to overview; return to the host when embedded; otherwise do nothing. A terminal narrower than 100 columns returns directly to the host when embedded and otherwise does nothing.
- **Esc backs out until there is nothing left to back out of, and never
  quits; `q` quits the whole program instantly from any screen.** For a
  viewer hosted inside another TUI, `runViewer` takes `embedded: true`
  and resolves with `"back"` (Esc at the bottom of the stack, nothing
  left to clear) or `"quit"` (`q`), so the host can honor the same
  contract.
- Copying: `y` copies the focused node's JSON. `Y` in the tree view copies
  every statelog event of the focused trace as JSONL, one object per line in
  file order. Views only *name* what to copy, through the `copy` and
  `copyTrace` actions. The shell in `run.ts` owns the events and the
  clipboard. `x` in the tree view extracts the focused trace to a file, and
  only when the source is a local file.
- Every view pins its name to the bottom-right corner via
  `bottomHints(hints, tag, cols)` in `views/shared.ts`, so the answer to
  "where am I" always lives in the same place.

## Adding a screen or an overlay

Add the painter under `screens/` and implement `Screen` for a numbered slot or `View` for an overlay. Declare its keys in one table. Give shared computations a pure module outside the painter. Keep follow state as IDs or absolute times, and use `forest.ts` for tree traversal. Round detail overlays retain the original round ID and resolve it again after every update, because event leaf IDs can change.

## Run directories

`agency logs <dir>` on a run directory ([`run-directory.md`](../evals/run-directory.md)) opens
this viewer on `<dir>/statelog.jsonl` with `traceAnnotations`: one line per
trace id ("notes · score 0.70 · labeled", built by `annotationSummaries`
in `lib/runDirectory/list.ts`) that `renderRowText` appends, dimmed, to the
trace's row and nowhere else. `focusTraceId` starts the cursor on a given
trace and expands it; the runs explorer uses it when drilling from a test
into the run's shared statelog. Both are read once at open; follow mode
re-reads the statelog, not the annotations.
