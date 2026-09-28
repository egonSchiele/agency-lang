# Timeline views and the component viewer — design (v2.1)

v2 incorporated the spec review (`2026-07-31-timeline-views-design-REVIEW.md`); every
blocking item, correction, and gap from it is resolved in the text below, with the review's
file:line citations re-verified before adoption. v2.1 folds in four amendments surfaced by
the PLAN review (`../plans/2026-07-31-timeline-views-REVIEW.md`): `search.ts` and
`summary.ts` move from the "unchanged" list to the "changed" list (shared text/naming
helpers lift out of `summary.ts`; `expandAncestorsOf` loses its `ViewerState` coupling),
`handleKey` gains the viewport parameter (paging keys need it), group shares may exceed
100% under real parallelism (documented below), and `promptCancelled` counts as a prompt
terminus for running-span detection.

## What this is

The logs viewer (`agency logs <statelog>`, `agency eval logs <runDir>`) is centered on one
interactive view: a collapsible tree of spans and events. (A second view exists in the code —
see "The orphaned jsonView" below.) This project adds three views for analyzing where a single
run spent its time — a flame view, a by-name view, and an occurrences view — plus a
full-detail screen for any single call. At the same time, the viewer's internals move to a
component architecture: every view is a class with the same small interface, built from
smaller component classes that each render one visual element. The existing tree view migrates
onto that architecture as part of this project, and follow mode (the `-f` flag that re-renders
as the file grows), which has never worked, gets diagnosed and fixed.

A working prototype of all four views exists on branch `adit/proto-timeline` (all logic in
`lib/logsViewer/timelineProto.ts`). Every behavioral decision below was made by driving that
prototype against real benchmark statelogs — the 20-minute gcode run and the 13-minute regex
run in `runs/2026-07-31-171034-rCOYJf/`. The prototype is the primary source for what the
views look like; this spec is the source for how to build them properly.

## Background: how the viewer works today

The pipeline: a statelog is a JSONL file of event envelopes (`lib/statelog/wireTypes.ts` —
`trace_id`, `span_id`, `parent_span_id`, and a `data` payload with a `type` and a
`timestamp`). `parseStatelogJsonl` (`lib/statelog/parse.ts`) turns text into envelopes.
`buildForest` (`lib/logsViewer/tree.ts`) turns envelopes into a forest of `TreeNode`s: one
root per trace, span nodes beneath (labeled `agentRun`, `nodeExecution`, `llmCall`,
`toolExecution`, `forkAll`, `subprocessRun`, `handlerChain`, …), leaf nodes for events. Each
node carries aggregated `firstTs`, `duration`, `tokens`, `cost`, and a precomputed `summary`.

The view layer today is elm-style: one central `ViewerState` (`lib/logsViewer/types.ts`), a
pure keyboard reducer (`input.ts`), pure render functions producing `Element` trees
(`render.ts`), and a shell loop (`run.ts`) that reads keys, calls the reducer, and paints via
the `lib/tui` screen. Two details of that design matter to this spec:

- The reducer already needs a **second channel**: `handleKeyEx` returns an optional
  `ViewerCommand` (`{kind:"search"|"copy"|"toggleFollow"}`, `input.ts:10-13`) for the things a
  pure reducer cannot do — search needs `await screen.nextLine("Search: ")`, copy shells out
  to the clipboard. The new `View` interface must carry these; see "The View interface".
- Scroll clamping lives in the shell rather than the reducer *because the reducer has no
  viewport* (the comment at `run.ts:272` says exactly that). Components that receive the
  viewport in `render()` get to own their own scrolling — this is the strongest concrete win
  of the component move.

The `lib/tui` layer (Screen, `box`/`row`/`column`/`line` builders, `scrollList`,
`clampScroll`/`followCursor` in `scroll.ts`) stays exactly as it is — components produce
`Element` trees through these same builders, and every row-list view renders its rows through
the existing `scrollList`. No new scrolling implementation is written.

This project replaces the central-state-plus-reducer style with components that own their
state. That is a deliberate convention change, decided explicitly (not drift): after this
project, "a view is a class holding its own UI state" is the pattern the next view follows.

### The orphaned jsonView

`lib/logsViewer/jsonView/` is a complete second view (build/input/render/types plus 35 tests,
same elm style). Nothing outside its own directory imports it — it is dead code. **Decision:
it is out of scope here.** It is not migrated, not deleted, and its tests are not counted in
the migration guarantee. A separate one-line PR should delete it (flagged to the owner; needs
their confirmation that it is not intentionally parked).

## The four analysis views, and what each shows

All decisions in this section are settled — they came out of prototype rounds with the owner.

**Flame view** (`t` from tree). One row per call, indented by nesting, positioned on a shared
time axis. Rows read as a story:

```
llm · Classify this coding task. If …  ░···················        3s
llm · Task: There's a file called te…  ░████░··············     1m33s
llm · Propose ONE concrete approach…   ·····▒··············       11s
llm · There's a file called text.gco…  ·····███████████████    15m59s
  bash · pip install matplotlib 2>&1…  ··········░░········         4s
```

- An LLM row's label is `llm · <first words of the call's last user message>`. Never the
  model name — the model ate the whole gutter and identified nothing (screenshot feedback).
  The model lives in the by-name footer, the selection footer, and the detail screen.
- A tool row's label is the tool name plus its first string argument: the bash command, the
  file path, the subagent's task.
- The duration column shows `total/self` when they differ (e.g. `19m55s/14s`).
- Enter or `→` on a row with children **drills in**: the view re-roots on that span — only it
  and its descendants remain, the axis rescales to its extent, and a breadcrumb
  (`» codeAgent » llm`) shows the path. `←` climbs back out one level. Enter on a leaf opens
  the detail screen.

**By-name view** (`t` again). One row per group, all of a group's calls drawn as bars on one
axis, with count, total self-time, and share of the view at the right:

```
llm(codingAgent)     ·······▓██████▓▓████████████▓██▒······    1×  15m21s  77%
llm(verifierAgent)   ···························▓██████        2×   1m48s   9%
bash                 ·······░░·░··░░▒▒░░▒▒···░··░░▒░░░        62×     41s   3%
```

- **Grouping key for LLM calls** (owner decision, precedence order): the call's **thread
  label** when one exists (`llm(codingAgent)` — thread labels come from `threadCreated`
  events), else the **enclosing function** the call was made in (the nearest enclosing tool or
  node span — tools and functions are the same thing, so a subagent like `codeAgent` counts),
  else the model. Non-LLM spans group by their plain name (tool name, `node main`, span kind).
  Two same-named functions in different modules collide into one group; accepted.
- Rows sort by total self-time, descending.
- Shares are of the view's wall clock, and **may legitimately exceed 100% when work ran in
  parallel**: two forked branches each busy for 10s inside a 10s window are 200% — that is
  true compute time, not the nesting double-count that self-time exists to prevent. A group
  whose share exceeds 100% is by definition parallel work.
- The selection footer for an LLM group lists the distinct models used by that group's calls.
- Enter on a row opens the **occurrences view** for that group.

**Occurrences view.** Every call of one group, chronological, each with the context of where
it came from. The path segments shared by every occurrence say nothing, so the common prefix
is lifted into the header, leaving each row its distinguishing tail plus the call's detail:

```
TIMELINE [occurrences]  bash — 62 call(s)  (all under agentRun » node main » llm » codeAgent)
# 1 llm · pwd; ls -la; wc -l text.gcode      ····░································     63ms
# 6 llm · pip install matplotlib 2>&1 | …    ········░░···························       4s
```

Enter on an occurrence drills into it (children) or opens its detail screen (leaf). `←`/`Esc`
returns to by-name.

**Detail screen.** Full information for one call, as a scrollable page: the span summary,
start/duration/self, and — for LLM calls — model, tokens in/out, cost, and the complete
prompt transcript (rendered with the existing `formatConversation`); for tools, the complete
call payload including the untruncated arguments. Reached by Enter on a leaf, or `d` on any
selection (`d` on a by-name row opens the group's longest call). `←`/`Esc` returns to
wherever it was opened from.

The detail screen is a **viewer-level feature, not a timeline-internal one**: `d` opens it
from the tree view too. It is one component used by all views.

## Semantics that must be implemented exactly

These encode the prototype's findings. Each changed what the views *mean*.

**Self-time.** A span's raw extent (its envelope) is the wrong number to aggregate, because
envelopes nest: the top-level `llmCall` span wraps the agent's entire tool loop, so summing
envelopes credited "llm" with 193% of a run. A span's **self-time** is its envelope minus the
union of its direct children's envelopes. By-name totals and shares use self-time only; the
flame view shows both. With self-time, the gcode run correctly reads "90% waiting on the
model, 3% running bash".

**Span extent.** Computed over **all descendant leaf events** (not just direct children):
start = min of (`timestamp` − `timeTaken`), end = max of `timestamp`. This is the envelope
rule `tree.ts` uses for `duration`, and "all descendants" is what makes parent ⊇ child hold
(a parent's leaves are a superset of each child's — `tree.ts:338`), which is what keeps
self-time non-negative. Additionally, the kernel **intersects each child interval with the
parent extent before subtracting**, so containment is enforced rather than assumed — a
malformed log must not be able to produce negative self-time. Do not derive extents from
`firstTs + duration` (`firstTs` is minimum *emission* time and overshoots the true start).

Edge rules: a span with no parseable timestamps is dropped from timeline views (it cannot be
placed). A zero-width extent (end = start) renders as its minimum one cell. Drilling into a
zero-width span sets the window to a minimum of 1ms so `coverage` never divides by zero.

**Bar shading = slice busyness.** Each bar cell covers a fixed slice of wall-clock time. The
glyph reflects the fraction of the slice the row's calls actually ran: `·` none, `░` ≤25%,
`▒` ≤50%, `▓` ≤90%, `█` above. (Darkness-as-overlap-count made 62 tiny bash calls read as
heavy overlap; the owner chose busyness.) **Override, stated as such:** any call inside the
window paints at least one `░` cell even when its true coverage rounds to zero — losing a
60ms call entirely on a 20-minute axis is worse than overstating it; this floor takes
precedence over the threshold table for that cell.

**Administrative spans hidden by default.** `handlerChain` and `threadEndHooks` spans appear
under nearly every tool call (90 in one run) and bury the signal. Hidden in all timeline
views by default; `a` toggles, and the header shows `[admin spans shown]` while toggled.
Hiding removes rows only — it must not change any span's depth, extent, or self-time (an
admin span's envelope sits inside its parent's regardless of visibility, so hiding is purely
presentational).

**Thread labels are per-process, not per-trace.** Thread ids restart in every subprocess, so
one trace can contain two `threadCreated` events for thread id `1` with different labels
(observed in the gcode statelog). The label lookup must be scoped to the process subtree: a
`subprocessRun` span is a process boundary, and an LLM call resolves its thread id against
the `threadCreated` events between it and its nearest enclosing `subprocessRun` span (or the
trace root when there is none).

**Unfinished spans** (follow mode's whole point is watching live runs). A span is *running*
when its start-marking event has no matching end: `toolCallStart` without `toolCall`,
`promptStart` without `promptCompletion` **or `promptCancelled`** (cancellation is a real
terminus — a run containing one cancelled call must not read as running forever),
`subprocessStarted` without `subprocessEnd`. A
running span's extent extends to the end of the view window and its bar ends in a `⋯` cap so
it cannot be misread as "done, and fast". Its self-time (and its ancestors') is provisional
and simply recomputes on the next `setData`.

**One trace at a time.** A statelog can hold several traces. Timeline views render the trace
containing the tree cursor at the moment `t` was pressed, and remember that **trace id**
(needed by `setData`, below). Cursor on a trace root selects that trace. Cursor on a
synthetic row (`jsonLine`, `convoLine`, `rawDataToggle` — on-the-fly rows that are not part
of the persistent forest) resolves through its owning real leaf, the same id-unwrapping
`search.ts`'s `expandSyntheticAncestors` does.

## Keybindings

| Key | Tree | Flame | By-name | Occurrences | Detail |
|---|---|---|---|---|---|
| `t` | open flame | open by-name | back to tree | back to tree | back to tree |
| `↑↓` / `jk` | existing | select row | select row | select row | scroll |
| `Enter` / `→` / `l` | expand (existing) | drill in / detail (leaf) | open occurrences | drill in / detail (leaf) | — |
| `←` / `h` | collapse (existing) | drill out | — | back to by-name | back |
| `g` / `G` | first/last row (existing) | same | same | same | top/bottom |
| `Ctrl-F/B/D/U` | page (existing) | page | page | page | page |
| `/` `n` `N` | search (existing) | search rows | search rows | search rows | — |
| `y` | copy node JSON (existing) | copy span JSON | — | copy span JSON | copy page text |
| `d` | detail of cursor | detail | detail (longest call) | detail | — |
| `o` | — | jump to tree at span | jump to tree | jump to tree | — |
| `+` `-` | — | zoom | zoom | — | — |
| `[` `]` | — | pan | pan | — | — |
| `0` | — | reset zoom | reset zoom | — | — |
| `a` | — | toggle admin spans | toggle admin spans | — | — |
| `Esc` | — | back to tree | back to tree | back to by-name | back |
| `q` / `Ctrl-C` | quit — shell-level, all views | | | | |
| `f` | toggle follow — shell-level, all views | | | | |
| `?` | help — shell-level overlay; content comes from the active view | | | | |

Notes: `h`/`l` stay vim-left/right everywhere (the admin toggle is `a`, not `h`, precisely so
`h` keeps meaning left). Copy is `y`, matching the existing binding. Search in the timeline
views is plain substring match against the visible row text, moving the cursor to the next
match (`n`/`N` cycle) — no highlighting in v1; same prompt flow as the tree's.

## Architecture: the component model

### The View interface

Every top-level view — tree included — implements one interface. `handleKey` stays
**synchronous**; everything a view cannot do alone is expressed as a returned action (this is
the widened replacement for today's `ViewerCommand` second channel, and it is what keeps
component tests cheap: construct, feed keys, assert on render):

```ts
type ViewAction =
  | { kind: "open"; view: "tree" | "flame" | "byName" }
  | { kind: "openOccurrences"; groupKey: string }
  | { kind: "openDetail"; spanId: string }
  | { kind: "focusInTree"; spanId: string }      // `o` — shell pops to tree, calls reveal()
  | { kind: "back" }                              // Esc/← at a view boundary
  | { kind: "promptLine"; label: string; onResult: (text: string) => void }  // search
  | { kind: "copy"; text: string }                // shell writes clipboard, calls notify()
  | { kind: "none" };

interface View {
  handleKey(ev: KeyEvent): ViewAction;    // mutates own state; synchronous
  render(viewport: Viewport): Element;
  setData(roots: TreeNode[]): void;       // follow: new forest, UI state preserved
  helpLines(): string[];                  // the `?` overlay's content for this view
  notify(message: string): void;          // shell feedback (copy result, etc.) → message bar
}
```

`setData` takes the whole **forest**, not one trace: the tree view owns all traces (it is the
trace picker), and a live log can start a second trace mid-watch — the tree grows a new root
while each timeline view re-picks its remembered trace id out of the new forest and keeps
showing it.

Handled by the shell, not by views: `q`/`Ctrl-C` (quit), `f` (follow toggle — follow is
shell-owned), `?` (help overlay — rendered by the shell from the active view's
`helpLines()`, closed by any key, exactly like today's flag). Search is view-initiated via
`promptLine` because only the view knows what to do with the result; the shell owns the
actual line prompt since it owns the screen.

The shell keeps a **view stack**, tree always at the bottom. `open`/`openOccurrences`/
`openDetail` push — with one rule: **`open` pops back to a view already on the stack instead
of pushing a duplicate**. That single rule makes `t`-from-by-name (pop to tree),
`t`-from-occurrences (pop two), and `t`-from-detail all fall out. `back` pops one.

Thresholds (`ViewerThresholds`) go to view constructors. The parse-error footer ("N parse
error(s) — first: line X") is shell-level, and is re-rendered from the **latest** parse on
every follow append (today it shows the boot-time errors forever, `run.ts:91`).

### Component trees per view

Each view is composed of component classes, one per visual element. A component takes its
data (and shared layout facts) at construction, holds its presentation state, and has a
`render()` producing an `Element` (or a string, for cell pieces composed into a `line()` by
their row). The parent decides placement; the child decides content. Components follow the
owner's rule for logic placement: a **compute step and a render step as separate methods on
the same class** — `RowLabel.computeText()` decides "last user message, first N characters",
`RowLabel.render()` draws it; deciding and drawing live together but test separately.

```
TreeView                    (migrated from render.ts/input.ts — same visuals, new home)
├─ TreeRowComponent         (marker, indent, summary — wraps existing renderRowText)
└─ StatusBarComponent       (search matches, [FOLLOW], messages — existing renderStatusBar)

FlameView
├─ TimelineHeader           (title, breadcrumbs, [admin spans shown], zoom range)
├─ AxisHeader               (tick labels over the bar area)
├─ FlameRowComponent        one per span row
│  ├─ RowLabel              (indent + name/snippet + detail)
│  ├─ BarComponent          (intervals → shaded cells for the current window)
│  └─ DurationCell          (total, or total/self when they differ)
└─ SelectionFooter          (cursor span's summary + start/self)

ByNameView
├─ TimelineHeader, AxisHeader                    (same components, reused)
├─ GroupRowComponent        one per group
│  ├─ GroupLabel            (renders the group key — the key itself comes from the kernel)
│  ├─ BarComponent          (self-intervals of every call in the group)
│  └─ GroupStatsCell        (count ×, total self-time, share %)
└─ SelectionFooter          (adds the group's model mix)

OccurrencesView
├─ TimelineHeader ("bash — 62 call(s) (all under …)"), AxisHeader
├─ OccurrenceRowComponent   (#index, context tail, detail, BarComponent, DurationCell)
└─ SelectionFooter

DetailScreen
├─ DetailHeader             (span summary line)
└─ DetailBody               (metrics lines + transcript/args, wrapped, scrollable)
```

`TimelineHeader`, `AxisHeader`, `BarComponent`, `SelectionFooter` are shared classes used by
all three bar views. Row lists render through the existing `lib/tui/scrollList` with
`clampScroll`/`followCursor` — no new scrolling code.

**Color.** Bars and row labels are colored by **group identity**: the top ~8 groups by
self-time get distinct palette colors, the rest gray; one group = one color in every view
("lots of cyan" means the same thing everywhere). Stats cells (durations, costs) reuse the
tree's threshold coloring (`thresholds.ts`), so "this was slow/expensive" is signaled the
same way in both halves of the viewer.

**Width budget** (constants in the shared components; these are the prototype's numbers):
flame label gutter 48 columns; by-name gutter 28; occurrences gutter min(55% of width, 64);
stats column 16 (flame/occurrences) or 20 (by-name); the bar area gets the remainder with a
floor of 10 cells. The bar-cell count is the `cells` argument to `coverage`, so this budget
is an input to rendering math, not cosmetics: at 80 columns a flame bar is ~15 cells, at 200
columns ~135. Labels clip with `…`, never wrap — a row is always exactly one terminal row,
which the repaint depends on.

### The shared kernel

Three pure modules sit below the views, in `lib/logsViewer/timeline/`. They exist because
their outputs must be **identical across views** — flame's duration column, by-name's
totals, and occurrences' membership must agree — and because the planned cross-run analysis
project will reuse them without a TUI attached.

- **`intervals.ts`** — interval arithmetic: `subtract(base, pieces)` (self-time — merges
  overlapping pieces, i.e. subtracts the union, which is what makes parallel fork children
  correct), `coverage(intervals, window, cells)` (shading fractions; defined for zero-width
  windows per the edge rules above). Knows nothing of spans or terminals.
- **`spans.ts`** — `timelineSpans(trace, { hideKinds }): TimelineSpan[]`: walks a span
  subtree, computes extents (all-descendant-leaves rule), running-span detection,
  self-intervals/self-time (children clamped into the parent), depth, admin filtering.
- **`groups.ts`** — `groupKeyOf(span)` (thread label → enclosing function → model, with the
  per-process thread-label scoping) and `groupSpans(spans): SpanGroup[]` (members, count,
  total self-time, share, model mix). Grouping lives in the kernel — not on `GroupLabel` —
  because **two views depend on agreeing about it**: by-name computes groups to display
  them, and occurrences resolves a group key back to its members. Two private copies could
  drift (concretely: in follow mode a `threadCreated` event can arrive after the LLM call it
  names, re-grouping that call from enclosing-function to thread-label between two
  `setData`s). With one kernel computation both views re-derive from the same function; if
  an occurrences view's remembered key no longer exists after `setData`, it pops back to
  by-name with a message-bar note.

```ts
type Interval = { start: number; end: number };

type TimelineSpan = {
  id: string;              // span id — the join key back to the TreeNode forest
  kind: string;            // "llmCall" | "toolExecution" | "nodeExecution" | …
  depth: number;
  extent: Interval;
  running: boolean;        // no matching end event yet (see Unfinished spans)
  selfIntervals: Interval[];
  selfMs: number;
};

type SpanGroup = {
  key: string;
  spanIds: string[];
  count: number;
  totalSelfMs: number;
  share: number;
  models: string[];
};
```

Note what is *not* in `TimelineSpan`: no names, no labels, no `TreeNode` reference. Naming
and labeling are view opinions and live on label components (which look nodes up by id when
they need event payloads); the kernel's output is plain serializable data.

### File layout

```
lib/logsViewer/
  run.ts                     — the shell: screen, view stack, action dispatch, follow watcher,
                               help overlay, parse-error footer, quit
  views/
    view.ts                  — the View interface, ViewAction, the view stack helper
    treeView.ts              — TreeView (+ TreeRowComponent, StatusBarComponent)
    flameView.ts             — FlameView + FlameRowComponent + RowLabel + DurationCell
    byNameView.ts            — ByNameView + GroupRowComponent + GroupLabel + GroupStatsCell
    occurrencesView.ts       — OccurrencesView + OccurrenceRowComponent (+ context-tail logic)
    detailScreen.ts          — DetailScreen + content assembly (via formatConversation)
    shared.ts                — TimelineHeader, AxisHeader, BarComponent, SelectionFooter
  timeline/
    intervals.ts             — interval arithmetic (pure)
    spans.ts                 — span extraction, self-time, running detection (pure)
    groups.ts                — group keys (thread-label scoping) + aggregation (pure)
```

If any view file grows past one comfortable read (roughly the structural linter's limits),
its row components split out beside it — one concept per file wins over this table.

Absorbed or changed (previously unlisted): `types.ts` (`ViewerState` becomes `TreeView`'s
private state; `TreeNode` and shared types remain), `help.ts` (dissolves into per-view
`helpLines()`), `follow.ts` (its polling loop moves into the shell's watcher on top of
`appendReader`; the file goes away — see Follow mode), `input.ts` and `render.ts` (absorbed
into `TreeView`). Two more, per the plan review (v2.1): `search.ts` — it imports the
synthetic-row builders from `render.ts` and takes a `ViewerState`, so those builders move to
a neutral `treeRows.ts` shared by search and `TreeView`, and `expandAncestorsOf` takes
`(roots, expanded, matchIds)` instead of the state object; `summary.ts` — its private
text/naming helpers (`spanDetail`, `lastUserMessage`, `truncate`, `fmtDuration`,
`stripQuotes`, `durationColor`/`costColor`) lift into a shared `spanText.ts` that both
`summary.ts` and the view components import, so a span is named and a duration formatted
ONE way across the whole viewer. Unchanged: `parse.ts`, `tree.ts`, `clipboard.ts`,
`conversation.ts`, `thresholds.ts`, `jsonView/` (out of scope, see above; the delete-it
question is deliberately deferred), everything in `lib/tui/`. Deleted at the end: the
prototype files (they live on the prototype branch) and whatever of `render.ts`/`input.ts`
has fully moved into `TreeView`.

One interface amendment (v2.1): `handleKey(ev: KeyEvent, viewport: Viewport)` — the paging
keys (`Ctrl-F/B/D/U`) are viewport arithmetic, which is exactly why they live in the shell
today; with the viewport as an argument each view owns its own paging.

## The tree view migration

The tree view moves onto the View interface **now** (owner decision). The migration is a
re-homing, not a redesign: visuals, keys, search, copy, help content, paging all stay
identical. `TreeView`'s internal state is today's `ViewerState` fields (roots, expanded set,
cursor, scroll, query/matches, message bar). **Every existing viewer test outside
`jsonView/` — 150 of them — keeps its assertions**; only setup changes (reducer tests become
`TreeView.handleKey` tests, render tests become `TreeView.render` tests). An assertion that
has to change is a behavior change and needs a stated reason.

Tree-view interactions with the new world: `t` returns `{kind:"open", view:"flame"}`; the
shell builds a `FlameView` for the cursor's trace. `{kind:"focusInTree", spanId}` (from `o`)
pops to the TreeView and calls a new `TreeView.reveal(spanId)` — internally the existing
`expandAncestorsOf` plus a cursor move.

## Follow mode: fix, not just port

Follow mode has never worked (owner report). Diagnosis comes first; here is what is already
**confirmed by reading the code**, what is ruled out, and what remains to check.

**Confirmed defect 1 — the boot gap.** The CLI reads the file once (`logsView.ts:25`), and
`follow()` starts its reader at the file's *current* size (`follow.ts:27`). Bytes appended
between those two moments are never parsed; toggling `f` minutes into a session silently
loses everything since boot. The fix is structural, and simpler than offset arithmetic:
**there is no separate boot read.** The shell creates one `makeAppendReader(path, 0)`; the
first `read()` *is* the boot read, one offset cursor exists, and the gap cannot exist by
construction. (A byte-offset seed computed from the decoded boot string would be wrong on
any multi-byte character — `string.length` is not a byte count.) Stdin input
(`agency logs -`) has no path; follow stays refused there exactly as today
(`logsView.ts:15-17`).

**Confirmed defect 2 — the accumulator rewind.** `startFollow` re-seeds its accumulator from
the boot text every time it starts (`run.ts:81`, `let accum = opts.jsonl`). Toggling `f` off
and on rewinds the accumulator to the boot snapshot; the next append rebuilds the forest
from boot-plus-one-chunk and rows visibly vanish. Reproducible, and the first thing the
diagnosis should reproduce. The single-reader design above also removes this bug by
construction (there is no second accumulator to rewind).

**Ruled out.** State replacement on append: `onFollowAppend` (`run.ts:231`) preserves
`expanded` and `cursorId` and only falls back when the cursor id genuinely vanished. Do not
chase this.

**Remaining suspects for "it never seemed to update", to check during diagnosis:**
- *The update is correct but invisible*: only the trace root is expanded by default, and new
  events land inside collapsed spans — a working follow looks like nothing. If confirmed,
  the fix is UX: a "N new events" note in the status bar (cheap, do it) rather than
  auto-expand.
- *Re-entrant painting*: the append handler calls `screen.render` from a timer while the
  main loop is parked in `await screen.nextKey()`. Confirm the Screen repaints correctly
  from that position before assuming.

**The fixed design.** The shell owns following: one `appendReader` from offset 0, polled on
an interval (the polling loop currently in `follow.ts` — that file dissolves into the
shell's watcher), re-parse the accumulated text on growth, `buildForest`, then
`setData(roots)` on every view in the stack. The parse-error footer updates from the fresh
parse. `setData`'s contract for every view:

- UI state survives: cursor and drill path are stored as **ids**; zoom window in absolute
  milliseconds; scroll re-clamps. Span ids come from the statelog and are stable. Leaf ids
  (`evt-<index>`) are parse-order — stable across *appends* because appends never renumber
  earlier events, **not** because they come from the log. A rotated/truncated file (the
  append reader rewinds to offset 0 when the file shrinks) renumbers everything; the
  fallback path below absorbs that, and gets a test.
- An id that no longer resolves falls back to the nearest surviving ancestor, then the
  first row.
- The flame/by-name axis end extends as the trace grows; an unzoomed view (`0` state) keeps
  tracking the live end; running spans render per the Unfinished-spans rule.

Follow gets an end-to-end test that appends to a real file under the viewer and asserts the
new span appears — the test that would have caught the breakage — plus a
toggle-off-toggle-on regression (defect 2) and a boot-gap regression (write between viewer
start and first poll).

## Testing

- **Kernel:** interval subtraction edge cases (nested, overlapping = fork children,
  exact-cover, child extending past parent → clamped, zero-width); extent rule (timeTaken vs
  emission; all-descendant leaves); self-time on the prototype's pathological case (the 193%
  regression — the top-level llm span must not absorb the run); thread-label scoping across
  a subprocess boundary (the observed id-1 collision); grouping fallback order; admin
  filtering leaving depth/extent/self-time untouched; running-span detection per event pair.
- **Components:** construct with a fixture forest, feed keys, assert rendered text — the
  existing harness (fake `InputSource`/`OutputTarget`, fixed viewport). Direct
  compute-method tests for labels (snippet truncation), bars (shading thresholds, the ░
  floor override, the running-span `⋯` cap), cells (`total/self` formatting).
- **Migrated tree tests:** all 150 keep their assertions; only setup changes.
- **Shell:** view-stack semantics (open-pops-when-present, back, quit), action dispatch
  (promptLine round-trip, copy → notify), `focusInTree` reveal, help overlay from
  `helpLines()`.
- **Follow:** the three regressions named above, and the truncation/renumber fallback.
- **Fixtures:** a small synthetic statelog exercising every span kind (including a
  subprocess boundary and a fork), plus a trimmed real benchmark statelog for
  snapshot-style tests at a fixed 120-column viewport (the width budget makes viewport size
  part of the expected output).

## Documentation

- `docs/site/cli/logs.md` and the `eval logs` section of `docs/site/cli/eval.md`: the
  views, keys, and what self-time means, with a text example.
- New `docs/dev/logs-viewer.md`: the component architecture — View interface, view stack,
  kernel, the setData/follow contract — so the next view follows the pattern. CLAUDE.md's
  deep-docs index gains the entry.

## Non-goals

- Cross-run aggregation and the runs explorer (project 2) — the kernel is built for reuse
  by it, but nothing cross-run ships here.
- Surfacing `metrics.models` into eval `summary.json` (project 2).
- `--timeline` CLI flag to open directly into flame view — deferred until the views are
  lived with.
- Migrating or deleting `jsonView/` (separate one-line deletion PR, pending owner
  confirmation it is not parked on purpose).
- Incremental per-append re-derivation for follow — full re-parse is fine at current log
  sizes (the 20-minute benchmark log is 678 lines); future work if logs grow hugely.
- Search highlighting in timeline views (cursor-jump only in v1).

## Risks

- **The tree migration touches load-bearing code.** Mitigation: re-homing with assertions
  preserved; the timeline views land on the new interface first, proving it before tree
  moves.
- **Two state conventions during the transition.** Acknowledged and accepted by the owner;
  the end state is one convention, and this spec is its statement.
- **Follow diagnosis may find more than the two confirmed defects.** The remaining-suspects
  list bounds the search; anything new found gets added to the regression list before
  fixing.
