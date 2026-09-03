# The logs viewer: component views, the timeline kernel, and follow mode

The interactive statelog viewer behind `agency logs` and `agency eval logs`. This page is
the architecture; the user-facing keys and views are documented in
`docs/site/guide/observability.md`. The CROSS-run explorer (`agency logs` over run
directories) is a separate app that embeds this viewer, described in
[`runs-explorer.md`](./runs-explorer.md).

## The component model

Every top-level view is a class implementing one type (`lib/logsViewer/views/view.ts`):

```ts
type View = {
  viewName: "tree" | "flame" | "byName" | "occurrences" | "detail";
  handleKey(ev: KeyEvent, viewport: Viewport): ViewAction;
  render(viewport: Viewport): Element;
  setData(roots: TreeNode[]): void;
  helpLines(): string[];
  notify(message: string): void;
  setFollowIndicator(on: boolean): void;
};
```

The stack itself is `makeViewStack(bottom)` in the same file. `popTo(name)`
returns false when no instance of that view is on the stack, which is the
shell's signal to construct one.

A view owns its own UI state: cursor, scroll, zoom window, drill path, and admin toggle.
`handleKey` is synchronous. It returns a `ViewAction` for anything the view cannot do
alone, such as opening another view, jumping to the tree, prompting for a search line, or
writing the clipboard. The shell (`run.ts`) owns the screen, a **view stack** (tree always at the
bottom), the `?` help overlay (content comes from the active view's `helpLines()`), the
parse-error footer, quit, and follow mode. `open` actions pop back to an existing view on
the stack rather than pushing a duplicate; `back` pops one. That single rule makes every
"t goes back to the tree" case fall out.

Why the viewport is a `handleKey` parameter: paging keys (`Ctrl-F/B/D/U`) are viewport
arithmetic. The old design kept them in the shell because its pure reducer had no viewport.
A component that receives the viewport owns its own paging and scrolling, built on
`lib/tui/scrollList.ts`.

The tree view's reducer lives in `views/treeReducer.ts`. The row model and the row text
shared by the tree and by search live in `treeRows.ts`. A shared helper must not depend on
a view, so search imports the neutral module rather than the view.

Components inside a view follow one rule: a **compute method and a render method on the same
class**. One method decides the text, such as "the last user message, first N characters",
and the other draws it. The shared visual components live in `views/shared.ts` and all
three bar views use them: `BarComponent`, `AxisHeader`, `TimelineHeader`, and the width
budget `splitWidth`.

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
`setData(roots)` on **every** view on the stack. `setData`'s contract has four parts.
Cursor and drill state is stored as ids, so it survives. An id that no longer resolves
falls back to the nearest ancestor, then to the first row. A zoomed window stays put while
an unzoomed one tracks the live end. A shrunken file, from rotation or truncation, resets
the reader and the accumulator, and the fallback path absorbs the renumbering. Running
spans draw to the window end with a `⋯` cap, so a live call cannot read as "done, and
fast".

End-to-end regressions live in `followMode.test.ts` (append, toggle-rewind, truncation) and
`lib/statelog/appendReader.test.ts` (UTF-8 split across read boundaries, offset rewind).

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

If a real fixed-grid table component ever lands in `lib/tui`, these two
rules are its reason to exist.

## Keybinding and chrome conventions (shared with any sibling TUI)

- `t` cycles views forward, `Shift+T` backward — any Agency TUI with
  multiple views uses the same pair.
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

## Working time, not wall clock

A span's `duration` is its wall-clock envelope, and for an interactive
agent session that number was mostly the user: minutes spent answering
approval prompts, and the gaps between one reply and the next message.
The rows show `active`, the time the agent worked, and name the rest as
`waiting` so the two reconcile (`12m active, 25m waiting`).

Nothing new is logged for this. `waitingTime` in `lib/logsViewer/tree.ts`
reads the gaps between consecutive events: a gap that ends at a
`handlerDecision` approve or reject is a person answering a prompt; a gap
that ends at a `toolCall` carrying an aborted result is a prompt the
person cancelled; a gap with no `promptStart` or `toolCallStart` still
open is time between turns. Every other gap is a model thinking or a
command running. Magnitude coloring uses the active time. The `agentEnd`
leaf still shows the runtime's own wall-clock figure.

## Adding a view

Implement the `View` type, add a `ViewAction` case if the view needs a new cross-view jump,
construct it in the shell's `dispatch`, and give it `helpLines()`. State that must survive
follow re-parses goes by id or absolute time, never by row index.

## Run directories

`agency logs <dir>` on a run directory ([`run-directory.md`](../evals/run-directory.md)) opens
this viewer on `<dir>/statelog.jsonl` with `traceAnnotations`: one line per
trace id ("notes · score 0.70 · labeled", built by `annotationSummaries`
in `lib/runDirectory/list.ts`) that `renderRowText` appends, dimmed, to the
trace's row and nowhere else. `focusTraceId` starts the cursor on a given
trace and expands it; the runs explorer uses it when drilling from a test
into the run's shared statelog. Both are read once at open; follow mode
re-reads the statelog, not the annotations.
