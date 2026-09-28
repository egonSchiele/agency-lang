# Timeline Views and the Component Viewer — Implementation Plan (v2, post-review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement
> this plan task-by-task (owner preference: inline execution in the main session, no
> subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

v2 resolves the plan review (`2026-07-31-timeline-views-REVIEW.md`): the three blockers
(search.ts dependency, viewport in handleKey, formatKey in the shell), the altitude finding
(reuse summary.ts helpers via spanText.ts instead of re-porting the prototype), all four
test-quality items, the fixture/smoke gaps, and the full test-plan second pass. Spec is at
v2.1, amended in lockstep.

**Goal:** Add flame / by-name / occurrences / detail views to the logs viewer, move the whole
viewer (tree view included) onto a component architecture, and fix follow mode.

**Architecture:** Two layers. A pure kernel (`lib/logsViewer/timeline/`) computes intervals,
spans-with-self-time, and groups from the existing `TreeNode` forest. A component view layer
(`lib/logsViewer/views/`) implements one `View` type per top-level view, each built from
component classes with separate compute and render methods. A thin shell (`run.ts`) owns the
screen, a view stack, action dispatch, the help overlay, and the follow watcher. Shared
naming/formatting lives in `spanText.ts` (lifted from `summary.ts`), so the tree and the
timeline views can never disagree about what a span is called or how a duration reads.

**Tech Stack:** TypeScript, the existing `lib/tui` layer, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-31-timeline-views-design.md` (v2.1). Where plan and
spec disagree, the spec wins — flag it, do not improvise.
**Prototype (reference only, never merged):** branch `adit/proto-timeline`,
`lib/logsViewer/timelineProto.ts`. Port targets below name its functions.

## Global Constraints

- Worktree: `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-timeline`,
  branch `adit/timeline-views`. Commands run from `worktree-timeline/packages/agency-lang/`.
  NEVER commit to main; never force-push or amend.
- Repo style (enforced by `pnpm run lint:structure`): no dynamic imports; objects not Maps;
  arrays not Sets; `type` not `interface`; function-length limits.
- Colors only via tui `Style.fg` names / `lib/utils/termcolors.ts`.
- Comments short; no narration. Test output always saved to a file
  (`npx vitest run <files> > /tmp/tl-<task>.log 2>&1`), then read. Never run the full agency
  suite.
- Commit after every task; message via file (apostrophes break `-m`).
- Every pre-existing viewer test outside `lib/logsViewer/jsonView/` (150 `it` blocks) passes
  at the end of every task. A changed assertion is a behavior change: name it and the reason
  in the commit message.
- `jsonView/` untouched (its deletion is a deliberately deferred, separate question).
  `lib/tui/**` untouched.
- Key matching ANYWHERE outside a view's own reducer goes through `formatKey(event)`
  (canonical `"f"` vs `"Ctrl+F"` etc.) — raw `ev.key === "f"` is true for Ctrl+F and is the
  bug class the review caught.

---

### Task 0: Shared fixtures — synthetic builder + a real trimmed statelog

(Split out of old Task 2 so every later task can name its test data.)

**Files:**
- Create: `lib/logsViewer/timeline/fixture.ts` (synthetic `TreeNode` builder)
- Create: `lib/logsViewer/timeline/fixtures/bench.jsonl` (real data)

**Interfaces:**
- Produces: `span(label, children, opts?)`, `leaf(type, atMs, data?)`, `trace(children)`
  building type-correct `TreeNode`s / `EventEnvelope`s (fields exactly per
  `lib/statelog/wireTypes.ts`; `threadId` values are strings, matching production);
  `benchForest(): TreeNode[]` (parse + buildForest over the checked-in real log).

- [ ] **Step 1:** Write `fixture.ts` exactly as reviewed (the v1 plan's Task 2 Step 1 code —
unchanged, it verified against `wireTypes.ts`). Satisfy `TreeNode`'s type; do not loosen it.
- [ ] **Step 2:** Check in the real statelog. Source (main checkout, not this worktree):
`/Users/adityabhargava/agency-lang/packages/agency-lang/runs/2026-07-31-171034-rCOYJf/inputs/gcode-to-text/agent/statelog.jsonl`
(678 lines). Trim to the first ~200 lines plus the final 10 (keeps the subprocess boundary,
fork, admin spans, multiple models, and an unclosed span at the cut point — exactly the
properties hand-built fixtures cannot fake), write to
`lib/logsViewer/timeline/fixtures/bench.jsonl`, and add `benchForest()` to `fixture.ts`.
Verify: `benchForest()` yields ≥ 1 trace and > 20 spans (one assertion in Task 2's tests).
- [ ] **Step 3:** Commit ("timeline fixtures: synthetic builder + trimmed real statelog").

---

### Task 1: Kernel — interval arithmetic

**Files:** create `lib/logsViewer/timeline/intervals.ts` + `intervals.test.ts`.

**Interfaces:**
- Produces: `type Interval = { start: number; end: number }`;
  `subtract(base, pieces): Interval[]`; `coverage(intervals, window, cells): number[]`;
  `totalMs(intervals): number`.

- [ ] **Step 1: Failing tests.** The v1 set (verified correct by review) **plus** the four
test-plan additions:

```ts
// added to the v1 suite in intervals.test.ts:
it("crosses cell boundaries with the right per-cell fractions", () => {
  expect(coverage([{ start: 20, end: 30 }], { start: 0, end: 100 }, 4))
    .toEqual([0.2, 0.2, 0, 0]);          // pins the first/last index arithmetic
});
it("two intervals in one cell clamp to 1 — shade is busyness, never overlap count", () => {
  const out = coverage(
    [{ start: 0, end: 20 }, { start: 5, end: 25 }],
    { start: 0, end: 100 }, 4,
  );
  expect(out[0]).toBe(1);                // NOT 1.6+ — the owner-rejected semantic
});
it("subtract with no pieces returns the base (every leaf span path)", () => {
  expect(subtract({ start: 3, end: 9 }, [])).toEqual([{ start: 3, end: 9 }]);
});
```

and rename the zero-width-window test to what it actually asserts:
`"a zero-width window stays finite (visibility of tiny spans is the ░ floor's job — Task 5)"`.

- [ ] **Step 2:** verify failure (`/tmp/tl-1a.log`).
- [ ] **Step 3:** Implement — the v1 plan's `intervals.ts` verbatim (review traced all cases
correct; the added tests pass against it — verify, don't assume).
- [ ] **Step 4:** verify pass (`/tmp/tl-1b.log`). **Step 5:** Commit ("timeline kernel:
interval arithmetic").

---

### Task 2: Kernel — spans with self-time

**Files:** create `lib/logsViewer/timeline/spans.ts` + `spans.test.ts`.

**Interfaces:**
- Consumes: `Interval`/`subtract`/`totalMs`; `TreeNode`; fixtures (Task 0).
- Produces: `TimelineSpan` (as v1: `id, kind, depth, extent, running, selfIntervals,
  selfMs`); `timelineSpans(root, { hideKinds })`; `spanExtent(node)`; `ADMIN_KINDS`.

- [ ] **Step 1: Failing tests.** The v1 set **with these review-driven changes**:
  - **selfIntervals content, not just totals** (bars draw positions, not sums):

```ts
it("selfIntervals carry the actual gaps, not just the right total", () => {
  const inner = span("toolExecution", [leaf("toolCallStart", 200), leaf("toolCall", 800)]);
  const outer = span("llmCall", [leaf("promptStart", 0), inner, leaf("promptCompletion", 1_000)]);
  const [outerSpan] = timelineSpans(trace([outer]), { hideKinds: [] });
  expect(outerSpan.selfIntervals).toEqual([{ start: 0, end: 200 }, { start: 800, end: 1_000 }]);
});
```

  - **span-as-root** (drill-in depends on it): `timelineSpans(outer, …)` (the span itself,
    not the trace) puts `outer` first at depth 0, children at 1.
  - **admin-hiding depth rule** (the test that CAN fail — the v1 equality test was
    tautological; keep it, labeled as a guard, and add):

```ts
it("a hidden span's children take its place at ITS depth — no phantom level", () => {
  const inner = span("llmCall", [leaf("promptCompletion", 400)]);
  const admin = span("handlerChain", [leaf("handlerDecision", 300), inner]);
  const tool = span("toolExecution", [leaf("toolCallStart", 100), admin, leaf("toolCall", 500)]);
  const rows = timelineSpans(trace([tool]), { hideKinds: ADMIN_KINDS });
  expect(rows.map((s) => [s.kind, s.depth])).toEqual([["toolExecution", 0], ["llmCall", 1]]);
});
```

  - **the same no-phantom-level rule for timestamp-less spans**: a span whose `spanExtent`
    is undefined is dropped, and its children surface at the dropped span's depth (change
    `pushSpan`: when `makeSpan` returns undefined, recurse with `depth`, not `depth + 1`).
  - **cancellation is a terminus** (spec v2.1): a span with `promptStart` +
    `promptCancelled` and no `promptCompletion` has `running === false`; a genuinely open
    `promptStart` has `running === true`. Note the existing precedent —
    `summary.ts:26` already renders "⏳ promptStart … never completed"; this flag is the
    same judgment made structural.
  - **the real fixture sanity row**: `benchForest()` parses, and
    `timelineSpans(firstTrace, { hideKinds: [] }).length > 20`.
- [ ] **Step 2:** verify failure (`/tmp/tl-2a.log`).
- [ ] **Step 3:** Implement — v1 plan's `spans.ts` with two amendments:
  `END_BY_START` becomes `ENDS_BY_START: Record<string, string[]>` with
  `promptStart: ["promptCompletion", "promptCancelled"]` (running = starts > sum of all
  listed ends); and the two no-phantom-depth fixes in `pushSpan`/`collect`.
- [ ] **Step 4:** verify pass (`/tmp/tl-2b.log`). **Step 5:** Commit ("timeline kernel:
spans, self-time, running detection").

---

### Task 3: Shared span text — lift from summary.ts; kernel grouping on top

(The review's altitude finding: `summary.ts` already owns span naming, duration formatting,
quote-stripping, last-user-message extraction, and threshold coloring — private. Re-porting
the prototype's copies would give the same span two names in one session. Lift, then build.)

**Files:**
- Create: `lib/logsViewer/spanText.ts` (moved helpers — no behavior change)
- Modify: `lib/logsViewer/summary.ts` (imports the moved helpers; its tests unchanged)
- Create: `lib/logsViewer/timeline/groups.ts` + `groups.test.ts`

**Interfaces:**
- `spanText.ts` produces (moved verbatim from `summary.ts`, exported):
  `spanDetail(node): string | undefined` (the 7-kind switch — tool name, node name, fork,
  subprocess, embedding, llm), `lastUserMessage(promptCompletion)`, `truncate(text, max)`,
  `fmtDuration(ms)`, `stripQuotes(text)`, `durationColor(ms, thresholds)`,
  `costColor(usd, thresholds)`.
- `groups.ts` produces: `SpanGroup` (as v1); `groupSpans(spans, root): SpanGroup[]`;
  `groupKeyOf(spanId, root): string`; `spanDisplayName(node): string` — **implemented on
  `spanDetail`**, adding only what it lacks (the `llm(model)`/`node X` presentation shapes),
  never re-deriving tool/model names.

- [ ] **Step 1: Lift.** Move the seven helpers to `spanText.ts`; `summary.ts` imports them.
Run the summary tests only (`npx vitest run lib/logsViewer/summary.test.ts > /tmp/tl-3a.log`)
— zero assertion changes tolerated.
- [ ] **Step 2: Failing group tests.** The v1 six cases **plus** the test-plan additions:
  - **nested subprocesses**: `subprocessRun` inside `subprocessRun`, each with its own
    `threadCreated` for id "1" — the inner llm resolves against the inner scope only (the
    "excluding nested subprocessRun subtrees" clause, which is the subtle half of the rule);
  - **the follow-mode re-grouping race**: same forest twice, once without and once with a
    late `threadCreated` — the same span's key moves from `llm(<enclosing>)` to
    `llm(<label>)`, which is precisely why occurrences must re-resolve through the kernel;
  - **parallel shares may exceed 100%** (spec v2.1): two forked children each busy 10s
    inside a 10s root → that group's `share` is 2.0. Assert it and reference the spec line —
    this is the sanctioned behavior, distinct from the nesting double-count.
- [ ] **Step 3:** verify failure (`/tmp/tl-3b.log`).
- [ ] **Step 4: Implement.** As v1's structure, with one performance fix from the review:
`groupSpans` builds the parent map (`parentById: Record<string, string>` via one DFS) once
and threads it to the per-span key computation; `groupKeyOf(spanId, root)` remains as the
single-lookup convenience for occurrences and builds its own map when called (once per
`setData`, not per span).
- [ ] **Step 5:** verify pass (`/tmp/tl-3c.log`); run summary + tree suites too (they now
share code). **Step 6:** Commit ("spanText lifted from summary; timeline grouping kernel").

---

### Task 4: The View interface and the view stack

**Files:** create `lib/logsViewer/views/view.ts` + `view.test.ts`.

**Interfaces (verbatim — every later task builds against these):**

```ts
export type Viewport = { rows: number; cols: number };

export type ViewAction =
  | { kind: "open"; view: "tree" | "flame" | "byName" }
  | { kind: "openFlameAt"; spanId: string }        // occurrences → flame drilled to a call
  | { kind: "openOccurrences"; groupKey: string }
  | { kind: "openDetail"; spanId: string }
  | { kind: "focusInTree"; spanId: string }
  | { kind: "back" }
  | { kind: "promptLine"; label: string; onResult: (text: string) => void }
  | { kind: "copy"; text: string }
  | { kind: "none" };

export type View = {
  viewName: "tree" | "flame" | "byName" | "occurrences" | "detail";
  /** Synchronous. Viewport is a parameter so views own their paging keys
   *  (Ctrl-F/B/D/U are viewport arithmetic — the current shell keeps them
   *  out of the reducer for exactly this reason, run.ts:272). */
  handleKey(ev: KeyEvent, viewport: Viewport): ViewAction;
  render(viewport: Viewport): Element;
  setData(roots: TreeNode[]): void;
  helpLines(): string[];
  notify(message: string): void;
};

export type ViewStack = { active(): View; all(): View[]; push(v: View): void;
  popTo(name: View["viewName"]): boolean; pop(): void };
export function makeViewStack(bottom: View): ViewStack;
```

- [ ] **Steps:** failing stack tests (push/active/all; popTo unwinds multiple levels /
returns false when absent; pop never removes the bottom) → implement (array field, ~30
lines) → pass (`/tmp/tl-4.log`) → commit ("viewer: View type and view stack").

---

### Task 5: Shared components — header, axis, bar, footer

**Files:** create `lib/logsViewer/views/shared.ts` + `shared.test.ts`.

**Interfaces:**
- Consumes: kernel `coverage`; `spanText.fmtDuration` (NOT a new `fmtMs` — deleted from the
  plan; one duration formatter exists); `line` builder; `Viewport`.
- Produces: `LAYOUT` constants (v1 values) **plus the degradation rule**: when
  `cols < gutter + stats + minBarCells`, the gutter shrinks first (floor 20), then the stats
  column drops the `/self` half (floor 8); the bar area never goes below `minBarCells: 10`.
  One function `splitWidth(view, cols): { gutter; bar; stats }` owns this; all three bar
  views call it.
  `class BarComponent` (`computeCells(window, cells): string` — glyphs by coverage
  `·░▒▓█`, the ░ floor, the running `⋯` cap); `class AxisHeader`; `class TimelineHeader`;
  `class SelectionFooter`; `padCell`/`clipCell`.

- [ ] **Step 1: Failing tests.** v1 set (thresholds at boundaries, ░ floor, `⋯` cap, axis
text, clip `…`) **plus** the test-plan invariants:
  - **cell-count invariant**: for a spread of intervals/windows,
    `computeCells(w, n).length === n` — wait: `⋯` and glyphs are single chars; assert
    *visible* length via a helper that strips nothing (cells are plain text; color is
    applied by the ROW, not the bar) — assert `computeCells` output contains no ANSI and has
    exactly `n` characters;
  - **one-row invariant on a colorized row**: compose a row the way FlameRow will
    (pad plain → colorize via tui Style, not inline ANSI) and assert the plain-text width
    equals the viewport width budget — this pins pad-before-colorize;
  - **the zero-width-span visibility test** promised in Task 1's rename: a `{start: 5,
    end: 5}` interval inside a 20-minute window renders exactly one `░`.
- [ ] **Steps 2–4:** fail → implement (port prototype `barCells`/`axisHeader` into compute
methods; `fmtDuration` imported) → pass (`/tmp/tl-5.log`).
- [ ] **Step 5:** Commit ("viewer: shared timeline components").

---

### Task 6: DetailScreen

As v1 (files, interface, content assembly via `formatConversation`, keys, vanished-span →
back), with two review additions:
- keys go through the viewport parameter for paging; `g`/`G` top/bottom;
- **a wrapping test**: a transcript line longer than the viewport wraps to multiple rows
  and the scroll clamp uses the POST-wrap line count (the detail screen is the one place
  the one-row invariant is deliberately broken; clamping against pre-wrap counts is the
  invisible bug).

- [ ] fail (`/tmp/tl-6a.log`) → implement → pass (`/tmp/tl-6b.log`) → commit
("viewer: detail screen").

---

### Task 7: FlameView

**Files:** create `lib/logsViewer/views/flameView.ts` + `flameView.test.ts`.

As v1 (constructor `(roots, traceId, thresholds, opts?: { drillTo?: string })` — `drillTo`
serves `openFlameAt`; components `FlameRowComponent`/`RowLabel`/`DurationCell`; drill/zoom/
pan/search/admin behavior; colors), with these review-driven changes:

- `RowLabel.computeText` uses `spanText.lastUserMessage` + `spanText.truncate` (llm) and
  `spanText.spanDetail` (tools/others) — the prototype's `promptSnippet`/`detailOf` are the
  *shape* reference, `spanText` is the *implementation*;
- `DurationCell` uses `spanText.fmtDuration` + `spanText.durationColor`;
- keys: paging (Ctrl-F/B/D/U via viewport param), `g`/`G`; `←`/`h` drill out and do
  nothing at the top (Esc is back-to-tree) — stated plainly, no alternatives;
- **flag (spec-consistency):** search keys and the identity palette are both IN spec v2.1
  (key table row `/ n N`; the "Color" paragraph) — implement exactly those.

- [ ] **Step 1: Failing tests.** v1 list **plus** (test-plan pass):
  - zoom does **not** extend the axis on `setData` while zoomed; unzoomed does track the
    live end;
  - admin spans hidden **by default** (fixture with a handlerChain: absent before any
    keypress);
  - `o` returns `{kind:"focusInTree", spanId}` with the cursor span's id;
  - `drillTo` constructor option starts re-rooted with breadcrumbs;
  - paging keys move the cursor by viewport-rows increments;
  - a snapshot against `benchForest()` at 120×24 (real-data snapshot; layout-only — the
    interval assertions above are the correctness net, snapshots are regression noise
    detectors and say so in a comment).
- [ ] **Step 2–4:** fail (`/tmp/tl-7a.log`) → implement → pass (`/tmp/tl-7b.log`).
- [ ] **Step 5: Eyeball smoke (review's ordering point, without reordering tasks):** a
10-line throwaway script `views/flameSmoke.ts` (gitignored via naming it under `/tmp`?
NO — write it, run it, delete it in this same task) that renders
`new FlameView(benchForest(), …).render({rows: 34, cols: 120})` and prints the flattened
text — the same headless-snapshot trick the prototype used. Look at it before building two
more views on the same shared components.
- [ ] **Step 6:** Commit ("viewer: flame view").

---

### Task 8: ByNameView (+ the cross-view agreement test)

As v1 (constructor shape, components, kernel-driven groups, Enter → `openOccurrences`,
`d` → longest member, bars = member selfIntervals, model-mix footer, shared
`barViewKeys(...)` extraction now that the duplication is visible), with review changes:

- **the shares test is replaced** — nested fixtures cannot violate the bound; the test-plan
  case can: a `forkAll` fixture with two concurrent 10s children in a 10s window asserts the
  group's share renders `200%`, matching spec v2.1's parallel-share rule;
- **`views/crossView.test.ts` (the structural gap):** on the shared fixture AND on
  `benchForest()`, for every group: the sum of `selfMs` over the flame view's spans with
  that group's ids equals the by-name row's `totalSelfMs`. This is the one test that pins
  "flame and by-name cannot disagree", which is the kernel's reason to exist.

- [ ] fail (`/tmp/tl-8a.log`) → implement → pass (`/tmp/tl-8b.log`) → commit
("viewer: by-name view + cross-view agreement test").

---

### Task 9: OccurrencesView

**Files:** create `lib/logsViewer/views/occurrencesView.ts` + `occurrencesView.test.ts`.

`class OccurrencesView implements View` — `constructor(roots, traceId, groupKey,
thresholds)`. Rows chronological; context tail = ancestor display-name path
(`spanDisplayName`) minus the longest common prefix, prefix cut at a ` » ` boundary and
lifted into the header. Enter/`→` on a call with children returns
`{kind:"openFlameAt", spanId}`; on a leaf, `{kind:"openDetail", spanId}`. `←`/`h`/`Esc` →
`{kind:"back"}`. `setData` re-resolves the key via `groupSpans`; a vanished key (follow-mode
re-group) sets an internal stale flag — the next `render` shows the note in the footer and
the next `handleKey` returns `{kind:"back"}`.

- [ ] **Step 1: Failing tests.** v1 list **plus** the test-plan case: two members whose
context paths share a *string* prefix that is not a *segment* prefix (`codeAgent` vs
`codeAgentHelper` as sibling ancestors) — the lifted prefix must cut at ` » `, leaving both
full names visible.
- [ ] fail (`/tmp/tl-9a.log`) → implement → pass (`/tmp/tl-9b.log`) → commit
("viewer: occurrences view").

---

### Task 10: The shell — view stack, actions, help overlay; TreeView adapter

As v1 (TreeView adapter wrapping today's reducer/render; `reveal(spanId)`;
`cursorTraceId()` with synthetic-row unwrapping; help overlay from `helpLines()`;
parse-error footer; `RunViewerOpts` unchanged in THIS task), with the review's fixes:

- the loop sketch is **async dispatch** and **formatKey-canonical**:

```ts
const fmt = formatKey(ev);
if (fmt === "q" || fmt === "Ctrl+C") break;
if (helpOpen) { helpOpen = false; render(); continue; }
if (fmt === "?") { helpOpen = true; render(); continue; }
if (fmt === "f") { toggleFollow(); render(); continue; }
await dispatch(stack.active().handleKey(ev, viewport));   // dispatch: Promise<void>
render();
```

  (`"f"` from formatKey is plain f only — Ctrl+F canonicalizes to `"Ctrl+F"` and falls
  through to the view, which is what keeps paging alive);
- paging keys are FORWARDED to views (no shell paginate step) — the adapter's TreeView
  implements them internally against the viewport param, preserving `run.test.ts` /
  `render.e2e.test.ts` behavior;
- shell tests add: Ctrl+F pages instead of toggling follow (the review's exact misfire,
  pinned), paging in tree via the adapter, plus the v1 list (stack round trip, help overlay,
  focusInTree reveal, promptLine round-trip, quit from every view, `d` in tree).

- [ ] fail (`/tmp/tl-10a.log`) → implement → **entire viewer suite**
(`npx vitest run lib/logsViewer > /tmp/tl-10b.log 2>&1`; 150 pre-existing green) → commit
("viewer shell: view stack + TreeView adapter; all views wired").

---

### Task 11: Tree view full migration

As v1 (absorb input.ts/render.ts into `views/treeView.ts`; probe methods, mechanical test
transformation, assertion-preservation rule), **plus the blocker fix**:

- **Create `lib/logsViewer/treeRows.ts`** first: move `eventExpansionChildren`,
  `rawDataChildren`, `llmCallSpanChildren`, `flattenVisibleRows` there (search.ts and
  TreeView both import it — a shared helper must not depend on a view);
- **`search.ts` changes** (spec v2.1): `expandAncestorsOf(roots, expanded, matchIds)`
  returning the new expanded set — `search.test.ts` setup updates, assertions preserved;
- `types.ts`: `ViewerState` moves into treeView.ts; `TreeNode`/`EventEnvelope` re-exports
  stay; `help.ts` dissolves if Task 10 left remnants.

- [ ] Migrate file-by-file, each migrated test file run before the next
(`/tmp/tl-11-<file>.log`); finish: full viewer suite + `npx tsc --noEmit -p tsconfig.json` +
`pnpm run lint:structure`. Commit ("viewer: tree view fully on the component model"),
naming any assertion that changed and why (target: none).

---

### Task 12: Follow mode — diagnose FIRST, then fix

**Files:** modify `run.ts`, `lib/cli/logsView.ts`; create
`lib/statelog/appendReader.test.ts`; create `lib/logsViewer/followMode.test.ts`; delete
`lib/logsViewer/follow.ts` + `follow.test.ts` (only after the coverage moves).

- [ ] **Step 1: Reproduce the toggle-rewind bug RED against current code** (review T3: it
is reproducible today through the unchanged `runViewer` + fake input/output harness):
append → `f` off → `f` on → append → assert both appends visible. Watch it FAIL against the
pre-Task-12 wiring. This is the diagnosis artifact; quote the failure in the commit message.
The boot gap is timing-dependent — for it alone, one manual reproduction
(`node dist/scripts/agency.js logs <scratch> -f` while appending) recorded in the commit
message is acceptable.
- [ ] **Step 2: Check the two remaining suspects** (collapsed-invisibility; re-entrant
paint) against the old path before deleting it; record findings. If collapsed-invisibility
is real, add the shell status-bar "N new events" note (count since last keypress).
- [ ] **Step 3: Preserve the reader coverage** (review T4): move follow.test.ts's
multi-byte-split test and stop()/no-further-reads test into
`lib/statelog/appendReader.test.ts`, rewritten against `makeAppendReader` directly (they
are currently the ONLY tests pinning the UTF-8 hazard appendReader documents). Green before
anything is deleted.
- [ ] **Step 4: Implement** the shell watcher: one `makeAppendReader(path, 0)` created at
boot — the first `read()` IS the boot read (no separate pre-read; no byte-offset
arithmetic); poll interval as today (250ms); on growth: accumulate → `parseStatelogJsonl` →
`buildForest` → `stack.all().forEach(v => v.setData(roots))` → refresh parse-error footer →
render. `f` toggles polling only; the reader and its offset persist (kills the rewind
structurally). `RunViewerOpts` becomes "text or path, at least one" — the stdin route still
passes text and still refuses follow (`logsView.ts:15-17` behavior unchanged); the file
route now passes only the path. Flag: this amends Task 10's "signature unchanged" — that
held until here by design.
- [ ] **Step 5:** the toggle-rewind test now GREEN; add the truncation/renumber test
(truncate mid-follow → viewer resets, cursor falls back, no crash) and the plain append
e2e. Full viewer suite green (`/tmp/tl-12.log`).
- [ ] **Step 6:** Commit ("viewer: follow rebuilt on appendReader; boot gap + toggle rewind
fixed", with diagnosis notes).

---

### Task 13: Documentation, help audit, cleanup

As v1 (docs/dev/logs-viewer.md; CLAUDE.md index; docs/site/cli/logs.md + eval.md;
anti-pattern audit; full gates), with one fix:

- **the smoke command uses the checked-in fixture** (the old command pointed at a runs/
  directory that does not exist in this worktree):
  `pnpm run build && node dist/scripts/agency.js logs lib/logsViewer/timeline/fixtures/bench.jsonl`
  — drive `t`/`t`/Enter/`←`/`d`/`o`/`/`/`a`/`f` by hand once. For a full-size log, the
  original path exists in the MAIN checkout and can be passed by absolute path.
- Confirm `timelineProto*` never existed on this branch
  (`git log --all --oneline -- '*timelineProto*'` shows only the prototype branch).
- Final gates: `npx tsc --noEmit`, `pnpm run lint:structure`,
  `npx vitest run lib/logsViewer lib/statelog > /tmp/tl-13.log 2>&1`.
- [ ] Commit ("viewer: docs + cleanup"). **Do not open a PR** — the owner decides when to
ship.

---

## Task ordering

0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 (ends with the real-data eyeball smoke) → 8 (includes the
cross-view test) → 9 → 10 → 11 → 12 → 13. Strictly sequential; 6–9 share 4+5 and the
`barViewKeys` extraction lands in 8 when the duplication is real rather than speculative.

## Review disposition (what changed from v1 and why)

- **B1** → Task 11 creates `treeRows.ts`, re-signatures `expandAncestorsOf`; spec v2.1
  moved `search.ts` to the changed list.
- **B2** → `handleKey(ev, viewport)` (Task 4); paging keys per-view (Tasks 6–10); spec
  v2.1 amended.
- **B3** → shell matches `formatKey` canonical strings; a test pins Ctrl+F-pages-not-follows.
- **A1** → Task 3 lifts `spanText.ts` out of `summary.ts`; `fmtMs` deleted from the plan;
  `RowLabel`/`DurationCell`/`spanDisplayName` consume the lifted helpers; `isRunning` notes
  the summary.ts precedent and treats `promptCancelled` as a terminus (spec v2.1).
- **T1** → test renamed; the ░-floor visibility test added in Task 5 and tied to it.
- **T2** → tautological test kept as labeled guard; the depth test (the failable one) added.
- **T3** → Task 12 Step 1 reproduces toggle-rewind RED against current code before any fix.
- **T4** → reader tests move to `lib/statelog/appendReader.test.ts` before follow.test.ts
  dies.
- **S1/S2** → Task 0 checks in the trimmed real statelog; Tasks 7/8 snapshot against it;
  Task 13's smoke uses it.
- **S3** → search keys and the identity palette are already in spec v2.1 (key table `/ n N`
  row; the "Color" paragraph) — no code/spec divergence existed; Task 7 references both.
- **Test-plan pass** → boundary/clamp/empty-subtract/span-root/selfIntervals/cancellation
  tests (Tasks 1–2); re-grouping race + nested subprocesses + parallel-share (Task 3);
  zoom-freeze, admin-default, `o`-payload, paging (Task 7); forkAll share + cross-view
  agreement (Task 8); segment-boundary prefix cut (Task 9); wrapping (Task 6); paging in
  shell tests (Task 10). Snapshots demoted to layout-regression detectors, stated in-code.
- **Smaller notes** → thinking-out-loud removed from Tasks 7/9 (conclusions only); parent
  map built once in `groupSpans`; `splitWidth` degradation rule; async dispatch in the
  sketch; `RunViewerOpts` change localized and flagged in Task 12; the post-Task-7 eyeball
  smoke; jsonView deferral stated in Global Constraints.
