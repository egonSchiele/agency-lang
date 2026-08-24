# The runs explorer

`agency logs` pointed at several paths (run directories, a directory of
run directories, statelog files) opens the cross-run explorer: one
sortable, groupable table with one row per run directory or statelog
trace, drill-down into a run's tests, and from a test into the existing
log viewer focused on that test's trace. A **sole** run directory does
not open the explorer: it opens the viewer on the directory's statelog,
with each trace's annotations summarised on its row ("notes · score
0.70 · labeled", from `annotationSummaries` in `lib/runDirectory/list.ts`).
This page explains how the explorer is built and why the boundaries sit
where they do. The single-run viewer has its own page
(`docs/dev/cli/logs-viewer.md`); the explorer is a **separate app** that
reuses the viewer via one call, not a set of views inside it.

## The data flow, end to end

```
CLI paths
  → sources.ts        classify: run dir (has statelog.jsonl) / dir of runs / statelog file
  → loader.ts         one readRunDirectory per run dir, chunked scan per statelog file,
                      one bounded unit per advance(), emits progress / upsert / done
  → rows.ts           RunRow + TestRow from a snapshot (or a scan), aggregate recompute
  → views/tableState  sort / group / expand / cursor-by-identity
  → views/*           render through lib/tui's TableComponent
  → run.ts            the shell: key loop, loader pump, viewer hand-off
```

## The loader owns loading — all of it

`lib/runsExplorer/loader.ts` is the only place that decides how a row
gets its numbers. Callers see three declarative events (`progress`,
`upsert` with a snapshot row, `done`) and advance the loader one bounded
unit at a time.

**A run directory is one `readRunDirectory`.** Its statelog is the truth
about every trace and its `annotations.jsonl` carries the harness `run`
rows (test id, how the run ended, suite, the agent label under
`flags.agent`) and the effective scores, so `buildRunRowFromDirectory`
(`rows.ts`, over `summarizeRuns`) fills every column from that one
snapshot and the row is `backfilled` immediately. There is no
`summary.json`, no per-input record, and no backfill phase any more.
A directory whose statelog has a torn or malformed line still loads: the
line becomes a warning on the row. Only a directory `readRunDirectory`
cannot read at all becomes a `failed` row.

**A raw statelog file** given on the command line is scanned chunk by
chunk (`mine.ts`): one `advance()` reads one chunk, bytes carry across
chunks so a UTF-8 character split at a boundary survives, and a torn
final line becomes a warning while the metrics before it are kept. One
row per trace in the file.

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
  exits the program — the Esc-backs/q-quits contract. A run directory
  holds one run, so Enter on a run row opens its `statelog.jsonl`
  directly, with the run's `traceId` as `focusTraceId`. The tests
  overlay (`TestsTableView`, "[pick test]") is reached only by a row
  with several tests, which no run directory produces any more; it is
  kept because the explorer is where group comparison will grow.
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
