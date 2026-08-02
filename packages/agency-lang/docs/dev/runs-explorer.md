# The runs explorer

`agency logs` pointed at run directories (or several paths at once)
opens the cross-run explorer: one sortable, groupable table with one row
per eval run or statelog trace, drill-down into a run's tests, and from
a test into the existing log viewer. This page explains how it is built
and why the boundaries sit where they do. The single-run viewer has its
own page (`docs/dev/logs-viewer.md`); the explorer is a **separate app**
that reuses the viewer via one call, not a set of views inside it.

## The data flow, end to end

```
CLI paths
  → sources.ts        classify: run dir / dir of runs / statelog file
  → loader.ts         phase 1 (two reads per run) + backfill, one bounded
                      unit per advance(), emits progress / upsert / done
  → rows.ts           RunRow + TestRow, patches, aggregate recompute
  → views/tableState  sort / group / expand / cursor-by-identity
  → views/*           render through lib/tui's TableComponent
  → run.ts            the shell: key loop, loader pump, viewer hand-off
```

## The loader owns loading — all of it

`lib/runsExplorer/loader.ts` is the only place that decides how a row
gets its numbers. Callers see three declarative events (`progress`,
`upsert` with a snapshot row, `done`) and advance the loader one bounded
unit at a time. Everything else — which miner runs for which input, how
record and statelog values merge, when a row counts as `backfilled` —
is private. There are two phases:

**Phase 1 reads exactly two files per run**: `summary.json` and
`config.json`, via `readEvalRunPhaseOne` (`lib/runsExplorer/
readRunSummary.ts`). That budget is pinned by a read-counting test
through the loader itself. It is enough for every table column because
`summary.json` carries a per-input `metrics` block ({costUsd,
durationMs, startedAtMs, models, agentName}, denormalized from each
eval record at summary-write time — see `writeEvalRunSummary`). This is
why a directory of two hundred runs shows a complete table in a couple
of seconds. Do not add per-input file reads to phase 1; that is what
backfill is for.

**Backfill** handles what phase 1 could not: runs written before the
summary carried metrics, and killed or errored inputs with no record at
all. Per input, the eval record is read first (it is the salvaged
truth); the statelog is streamed only for fields the record could not
supply — old records lack `startedAtMs`/`agentName`, killed inputs lack
everything. The statelog scan (`mine.ts`) is resumable: one `advance()`
reads one chunk, bytes carry across chunks so a UTF-8 character split
at a boundary survives, and a torn final line becomes a warning while
the metrics before it are kept. One shared accumulator serves both
direct statelog rows and backfill, so the two paths cannot disagree
about what a statelog means.

Corrupt inputs never disappear: a half-written `summary.json` (the
common case — an eval run still writing while the explorer reads it)
becomes a visible `failed` row whose warnings show on the info screen.

## Wall-clock, not summed durations

A run's `time` column is `max(start + duration) − min(start)` over its
tests. Summing per-test durations reads a parallel run as ~33 m when it
took ~20 m of wall time; the envelope is the honest number. This is the
reason `EvalRecord` gained `startedAtMs` (sibling of `durationMs`,
which was already wall-clock per test).

## Agent identity

Precedence (in `identity.ts`): the `agentName` statelog event (written
by `std::statelog setAgentName`, last call in a trace wins, extracted
into records and summary metrics) > the eval `agentLabel`, shortened
(basename for `.agency` entries, `agency-agent(x)` for agent commands)
> the launch command > the file/trace name. Identity colors are
frequency-ranked over one palette so "bright-cyan is the most-seen
agent" holds on every screen. The suite column comes from
`config.json`'s `provenance.inputsSource.source` (`suite.ts` knows the
real formats: local path, git URL with `?ref=`, `inline:`, `optimize`).

## The cursor pins to identity, never an index

Backfill can rename a row's agent, which regroups and re-sorts the
table under the user. `tableState.ts` therefore stores the cursor as a
row KEY (`runDir` or `statelogPath#traceId`; group headers use
`group:agent:<name>`), re-derives the index every projection, maps a
member hidden by a collapsed group to its owning header, and falls back
to an index hint only when the key vanished outright. Sorting puts
missing values last in BOTH directions — an ungraded run must never
look best or worst.

## Rendering: declare columns, never manage widths

`lib/tui/table.ts` (`TableComponent`) renders every table screen from a
column spec — header, width policy (`number` / `"flex"` / `{min}`),
alignment, cell text and style per row. It resolves widths through the
same algorithm `std::ui/table` uses, lifted into the dependency-free
`lib/utils/columnWidths.ts` (the TUI must not import stdlib internals;
the algorithm was moved DOWN, not reached UP for). Width arrays never
cross the component boundary. When the terminal is too narrow the runs
view drops whole columns — models, then time, then pass — rather than
letting cells collide.

## The shell and the viewer hand-off

`run.ts` is the one imperative boundary. Its two hard rules:

- **At most one outstanding key request, and none while the embedded
  viewer runs.** Opening a test's log awaits
  `runViewer({ embedded: true })` on the same input/output; a stale
  explorer waiter would steal the viewer's first keypress (there is an
  assertion at the hand-off and a test that feeds the viewer its own
  key). `"back"` resumes the explorer with its state intact; `"quit"`
  exits the program — the Esc-backs/q-quits contract.
- **The loader advances once per macrotask** (`setImmediate`), so `q`
  lands between chunks of a multi-megabyte statelog scan. Never race
  the key waiter against an always-ready microtask.

Views: a loading splash until the first rows, then three cycling
variants (runs → compare → trend on `t`/`Shift+T`), with tests/info as
an overlay stack above. Esc pops the overlay, then falls back to the
runs variant, then goes inert.

## CSV

Interactive `e` exports the current projection — sort and grouping
preserved, group members always listed under their headers whether or
not the group is expanded on screen. `--csv` prints the completed,
ungrouped table to stdout and uses `loadAllRuns`, the same loader
drained synchronously, so interactive and headless numbers cannot
drift.

## Testing

Everything below the shell is pure and tested headlessly
(`testFixtures.ts` builds realistic run dirs and statelogs in temp
dirs). The shell itself runs end-to-end under `ScriptedInput` +
`FrameRecorder`, with a driver that feeds each key only when the screen
shows the state a human would react to. CLI routing is tested at source
level through injected seams (`LogsViewDeps`) — no dynamic module
mocks.
