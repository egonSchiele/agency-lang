# Promoting a statelog trace into a label dataset

This is the bridge from a captured statelog trace to a human-judged **dataset**
(`agency label`). It lets you run an agent ad-hoc, then — from the log viewer or
the CLI — pick one trace out of a multi-trace statelog and start labeling it.

Read `eval-labeling.md` first for the dataset itself (examples, occurrences,
annotations, the lock, checklists). This note covers only the bridge.

## The three-piece pipeline (finding-2 shape)

`loadBatch(...)` is **synchronous and never prompts**, so a print chooser cannot
live inside a loader. The bridge is therefore split so the interactive step is
owned by the surface, not the loader:

1. **`resolveTrace(events, sourcePath)`** (`lib/eval/label/load/statelog.ts`) —
   pure. Runs the trace's events through `extractEvalRecord`, then decides the
   output by strict precedence and returns a discriminated result:
   - `resolved` — a definite output (`evalOutput` at the last explicit index,
     else the entry-node `return` value, else a single clean printed value).
   - `needs-selection` — several non-truncated prints; the surface must choose.
   - `rejected` — a truncated explicit output (`truncated-output`, never falls
     through to prints), only-truncated prints (`truncated-output`), or nothing
     at all (`no-output`).
2. **surface-owned selection** — the CLI's `--output <trace>=print:<index>` or
   the viewer's chooser turns a `needs-selection` into a concrete choice.
3. **`projectTrace(traceId, resolved, taskChoice, ctx)`** — pure. Projects the
   output and task through `projectArtifactField`, runs `checkEligibility`, and
   emits a `LoadedOccurrence` with a **`statelog` occurrence origin**, or a skip.

The output selection reuses `selectLabelingFinalOutput` (the run loader's
helper), so "absent ≠ null" and truncation are handled identically to run
ingestion. The last assistant message is deliberately never used as an output.

## The `statelog` occurrence origin

`OccurrenceOriginSchema` gained a fourth variant whose locator is
`(traceId, outputSource)`, where `outputSource` is `evalOutput{index}` |
`return` | `print{index}`. So re-promoting a trace with the **same** choice
replays one occurrence (idempotent), while promoting `print[0]` and later
`print[1]` from the same trace are two **distinct** observations. Print indexes
are the 0-based ordinal among all of a trace's print events, so they stay stable
even when a truncated print is dropped from the candidate list.

Adding the variant is additive to the strict schema, but the dataset manifest
bumps v2 → v3 anyway (`CURRENT_DATASET_VERSION`), so an older binary refuses at
the manifest boundary rather than choking on an origin row it cannot parse. The
upgrade is **non-destructive**: `openDataset` validates the whole v2 dataset and
then rewrites only `manifest.json`, never the logs.

## Shared effect owners

Two lifecycles are owned once and shared by the CLI and the viewer, so neither
reimplements them (and neither leaks a lock or a controller):

- **`datasetWriter`** (`lib/eval/label/datasetWriter.ts`) — the only
  lock → `openDataset` → `ingest` → close → release sequence.
- **`labelingHost`** (`lib/eval/label/labelingHost.ts`) — the only
  `openLabelingSession` → `runLabelTui` → close-controller sequence. It runs on
  an **existing** `Screen` and never destroys it; whoever created the terminal
  owns tearing it down.

The viewer's lock ordering is **sequential, never nested**: the writer acquires
and releases the dataset lock for the ingest, and only then does the labeling
host open its own session (which acquires the lock again).

## The viewer hook

`promoteFocusedTrace` (`lib/logsViewer/promoteTrace.ts`) is the imperative
orchestrator: resolve → ask the `PromotionUI` only for unresolved decisions
(which print, the task text) → project → compute `makeOutputId(fields)` →
`datasetWriter.ingest` → `labelingHost.run(..., focusOutputId)`. It contains no
file reread, lock, controller, or terminal code — those are the injected
services.

In the tree view, `l` emits a `promoteTrace` ViewAction **when a dataset is
configured** (local file views); the shell handles it in `dispatch`, which the
main loop is already awaiting, so no key read races the labeling TUI for stdin.
`Right`/`Enter` still expand. A brand-new session focuses the promoted example
via the pure `focusItem` session action (`focusOutputId`). Without `--checklist`
the action still fires but only notifies "Pass --checklist <file>".

`agency logs [view] --dataset/--store/--checklist` configure the destination
(`resolveDataset` reconciles the alias); the per-trace source name is the
trace's `setAgentName`, else the file basename. Stdin and remote logs get no
promotion.

## Print capture (PR 1)

Promotion's third output tier needs printed values, which the statelog did not
record. `_print`/`_printJSON` now call `recordPrint` (`lib/stdlib/statelog.ts`)
after the console write: it attributes to the active thread, serializes with
`node:util.format` / `JSON.stringify` exactly as the console did, and replaces a
value over `PRINT_VALUE_MAX_BYTES` with a fixed placeholder (not a prefix, which
could leak a tagged value past redaction). It is fire-and-forget; `post()` owns
sink-failure reporting, so there is no `.catch`.
