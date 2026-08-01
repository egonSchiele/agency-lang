# The logs viewer: component views, the timeline kernel, and follow mode

The interactive statelog viewer behind `agency logs` and `agency eval logs`. This page is
the architecture; the user-facing keys and views are documented in
`docs/site/guide/observability.md`.

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
};
```

A view owns its own UI state — cursor, scroll, zoom window, drill path, admin toggle.
`handleKey` is synchronous and returns a `ViewAction` for anything the view cannot do alone:
opening another view, jumping to the tree, prompting for a search line, writing the
clipboard. The shell (`run.ts`) owns the screen, a **view stack** (tree always at the
bottom), the `?` help overlay (content comes from the active view's `helpLines()`), the
parse-error footer, quit, and follow mode. `open` actions pop back to an existing view on
the stack rather than pushing a duplicate; `back` pops one. That single rule makes every
"t goes back to the tree" case fall out.

Why the viewport is a `handleKey` parameter: paging keys (`Ctrl-F/B/D/U`) are viewport
arithmetic. The old design kept them in the shell because its pure reducer had no viewport;
components that receive the viewport own their own paging and scrolling (via the existing
`lib/tui/scrollList`).

The tree view's reducer lives in `views/treeReducer.ts` (moved from `input.ts`, unchanged);
the row model and row text shared by the tree and by search live in `treeRows.ts` (moved
from `render.ts`) — a shared helper must not depend on a view, so search imports the neutral
module, not the view.

Components inside a view follow one rule: a **compute method and a render method on the same
class** (`RowLabel.computeText()` decides "the last user message, first N characters";
rendering draws it). Shared visual components — `BarComponent`, `AxisHeader`,
`TimelineHeader`, the width budget `splitWidth` — live in `views/shared.ts` and are used by
all three bar views.

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
  is its extent minus its direct children's extents: without it, the top-level `llmCall`
  span (which wraps the agent's whole tool loop) absorbs the entire run — the prototype
  measured a 193% share. `running` is true when a start-marking event has no terminus
  (`promptCancelled` counts as one). Admin spans (`handlerChain`, `threadEndHooks`) are
  filtered presentationally: rows disappear, depths close up, extents and self-time are
  untouched.
- `groups.ts` — the by-name grouping. LLM calls group by **thread label** (from
  `threadCreated` events, scoped to the nearest enclosing `subprocessRun` span because
  thread ids restart per process), else the **enclosing function**, else the model;
  everything else groups by its display name. Grouping lives in the kernel because two
  views consume it (by-name displays groups, occurrences resolves a key back to members)
  and a follow-mode re-parse can legitimately re-group a call — one computation, two
  readers. A group's share is of wall clock and may exceed 100% for parallel work; that is
  real compute time, not the nesting bug self-time fixes.

`TimelineSpan` carries no names and no `TreeNode` reference — naming is a view opinion
(label components look nodes up by id), and the kernel's output stays plain serializable
data. Span naming and text formatting shared with the tree live in `spanText.ts` (lifted
from `summary.ts`): `spanDetail`, `lastUserMessage`, `fmtDuration`, threshold colors — one
implementation, so a span cannot read differently in two views of the same session.

## Follow mode

The shell owns ONE `makeAppendReader(path, 0)` (`lib/statelog/appendReader.ts`) created at
boot; its first `read()` IS the boot read. `f` toggles polling only — the reader and its
byte offset persist for the whole session. This kills the two bugs that made follow dead on
arrival, by construction:

- **the boot gap**: the old CLI pre-read the file, then the watcher started reading at the
  file's *current* size; anything appended in between was never parsed.
- **the accumulator rewind**: toggling `f` off/on re-seeded the accumulated text from the
  boot snapshot, silently dropping earlier appends.

On growth the shell re-parses the accumulated text, rebuilds the forest, and calls
`setData(roots)` on **every** view on the stack. `setData`'s contract: cursor/drill state
is stored as ids and survives; ids that no longer resolve fall back (nearest ancestor, then
first row); a zoomed window stays put while an unzoomed one tracks the live end; a shrunken
file (rotation/truncation) resets the reader and accumulator, and the fallback path absorbs
the renumbering. Running spans draw to the window end with a `⋯` cap so a live call cannot
read as "done, and fast".

End-to-end regressions live in `followMode.test.ts` (append, toggle-rewind, truncation) and
`lib/statelog/appendReader.test.ts` (UTF-8 split across read boundaries, offset rewind).

## Adding a view

Implement the `View` type, add a `ViewAction` case if the view needs a new cross-view jump,
construct it in the shell's `dispatch`, and give it `helpLines()`. State that must survive
follow re-parses goes by id or absolute time, never by row index.
