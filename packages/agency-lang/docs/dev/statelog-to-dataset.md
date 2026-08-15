# Labeling a statelog trace

This is the bridge from a captured statelog trace to a human-judged **dataset**
(`agency label`). It lets you run an agent ad-hoc, then — from the log viewer or
the CLI — pick one trace out of a multi-trace statelog and label it.

Read `eval-labeling.md` first for the dataset itself (examples, occurrences,
annotations, the lock, checklists). This note covers only the bridge.

## A trace is just an example

Once extracted, a statelog trace is a `{ task, output }` example — the same
shape a run produces — so it flows through the same machinery a run does:

- **Output** is chosen by the shared `selectLabelingFinalOutput` (an
  `evalOutput()` value, else the entry-node return value; truncated or absent is
  rejected, never the last chat message).
- **Projection** into an occurrence's fields is the shared
  `projectOccurrenceFields` (`lib/eval/label/load/occurrence.ts`), used by both
  `loadRun` and the statelog loader — output rendered via `projectArtifactField`,
  eligibility checked, task prepended.

The only things specific to a statelog are: extracting from a raw statelog with
`extractEvalRecord` (a run has a pre-extracted `eval-record.json`), and a small
occurrence-origin variant, because the `run` origin requires an `inputId` a raw
trace has no honest value for.

## The `statelog` occurrence origin

`OccurrenceOriginSchema` has a `statelog` variant, `{ traceId, finalOutputIndex }`
— the same locator fields `run` uses (minus the eval-input fields), so two
`evalOutput()` values from one trace stay distinct observations and re-labeling
the same trace is idempotent. No manifest bump: the variant is additive, and the
dataset stays at schema version 2.

## The loader (headless)

`loadStatelog` (`lib/eval/label/load/statelog.ts`) scans once
(`scanStatelog`), validates every requested `--trace` id, and for each resolves
→ projects → occurrence-or-skip. It has no interactive selection: output
resolution is deterministic, so there is nothing to prompt for. `agency label
ingest <statelog> --trace <id>` reaches it via the `statelog` format
(auto-detected by the first envelope, reusing the `agency logs` classifier).

## Shared effect owners

Two lifecycles are owned once and shared by the CLI and the viewer:

- **`datasetWriter`** (`datasetWriter.ts`) — the only
  lock → `openDataset` → `ingest` → close → release sequence.
- **`labelingHost`** (`labelingHost.ts`) — the only
  `openLabelingSession` → `runLabelTui` → close-controller sequence, running on
  an **existing** `Screen` it never destroys.

The viewer's lock ordering is sequential, never nested: the writer acquires and
releases the lock for the ingest, then the labeling host opens its own session.

## The viewer hook

`labelTrace` (`lib/logsViewer/labelTrace.ts`) resolves the focused trace, asks
the surface only for the task text, projects, computes `makeOutputId(fields)`,
`datasetWriter.ingest`s, and `labelingHost.run(..., focusOutputId)`s. No file
reread, lock, controller, or terminal code — those are injected services.

In the tree view, `l` emits a `labelTrace` ViewAction **when a dataset is
configured** (local file views); it never expands (Right/Enter do). The shell
handles it in `dispatch`, which the main loop already awaits, so no key read
races the labeling TUI for stdin. It refuses when the current parse has errors
(strict for ingestion, unlike display) and pauses the follow watcher for the
handoff. A new session focuses the just-written example via the pure `focusItem`
session action.

`agency logs [view] --dataset/--checklist` configure the destination; the
per-trace source name is the trace's last `setAgentName`, else the file
basename. Stdin and remote logs get no labeling.
