# The run directory

A run directory is the one on-disk shape that observing, noting, labeling,
grading and optimizing all read and write. The design and its reasoning are in
`docs/superpowers/specs/2026-08-18-run-directory-and-annotations-design.md`;
this page is the map of the code in `lib/runDirectory/` and the rules that are
easy to get wrong.

## What is on disk

```
<dir>/
  statelog.jsonl        # required; any number of traces (one trace = one run)
  annotations.jsonl     # every opinion about a trace: note, checklist, score, run
  code/<closureHash>/   # one copy of the agent's closure per code VERSION
  workdir/<traceId>/    # filesystem snapshot for that trace
  workdir/<traceId>.json  # { snapshotAt, source } — when and where from
  checklists/<id>/      # versioned checklist revisions + labeling drafts (docs/dev/eval-labeling.md)
  .lock                 # present only while a writer is open
```

**The statelog is the run.** A directory holding only `statelog.jsonl` is a
valid run directory; every other entry is an attachment that unlocks more.
`agentStart` carries `code` (which closure ran) and `input` (what the entry
node was given) — see `docs/dev/statelog.md` — so a trace stands on its own.

## Read side: one snapshot, no lock

`readRunDirectory(dir, { reportWarning })` (`runDir.ts`) returns a
`RunDirectorySnapshot`: `traces`, raw `annotationRows`, and
`effectiveAnnotations` (the fold). Readers never take the lock; the snapshot
reads statelog → annotations → statelog and retries when a writer changed the
statelog in between, so the pairing is coherent. Parse errors are warnings.

`readTraces` (`traces.ts`) is built on `parseStatelogJsonlWithLines`
(`lib/statelog/parse.ts`), the one owner of line decoding. It drops a torn final
line and byte-identical duplicate lines within a trace (the harmless result of
`cat`), and computes a per-trace **digest over the canonicalized events**, so
key order does not matter. It does not — cannot — detect two different streams
sharing an id once they are interleaved; that check lives in the merge planner.

## Annotations (`annotations.ts`)

One row per opinion; four kinds:

| kind | who | what |
|---|---|---|
| `note` | human | free text |
| `checklist` | human | one sign-off: `checklist`, `version`, `hash`, `answers`, `note` |
| `score` | grader / judge | one grader's verdict in one pass: `passId`, `passSize`, `completesPass`, `name`, `score`, `weight`, `mustPass` |
| `run` | harness | which `test`, which `suite`, how it `ended`, `flags` |

Rules:

- **Ids are deterministic**: `ann_` + sha256 of `{traceId, annotator, payload,
  sessionId|null}`. The same opinion always has the same id, so a retried
  append rewrites nothing and doubles nothing. Score rows include their
  `passId`, so a second grading pass is new rows even when nothing changed.
- **Annotators are named by revision**: a grader is `<path>@<sha256 of file>`,
  the goal judge `goal-judge:<model>@<prompt hash>`. Editing `graders.ts` in
  place is a new annotator; its rows sit beside the old ones.
- **The fold is per key, append order decides**: notes accumulate; checklist
  answers fold per question per `(checklist, annotator)`, so a restored
  question keeps its earlier answer; scores count only from **complete**
  passes (exactly `passSize` distinct rows and one `completesPass`), so a crash
  mid-pass never moves effective state; the latest `run` row wins.
- Reading is tolerant (malformed row → warning, torn tail ignored); writing
  validates against `AnnotationSchema` before append.

## Write side: declarative operations (`mutations.ts`)

Four public writes. Each takes the lock, snapshots, **plans the whole request
with the pure planners before writing a byte**, repairs a torn final line on
each append target, applies, and returns a fresh snapshot; the lock is released
on success or failure.

- `addToRunDirectory({ dir, statelogFiles, codeEntries, workdir?, annotationFiles })`
- `recordCompletedRun({ dir, stagedStatelogFile, codeEntry?, workdir?, run })` — the eval harness's one call per finished test
- `recordNote({ dir, traceId, annotator, text })`
- `recordGradingPass({ dir, scores })` — mints one `passId`, stamps `passSize`, marks the last row `completesPass`

Nothing outside this module and the checklist sign-off owner may import the
lock or the `apply*` helpers.

The planners (`mergeStatelog.ts`, `attachCode.ts`, `attachWorkdir.ts`):

- **Merge** judges the whole incoming set: absent id → add; same id and equal
  digest → skip; same id, different digest → refuse, and the whole plan fails.
- **Code** hashes the closure it is given (`computeCodeIdentity`, relative to
  the closure's common ancestor, never cwd) and requires that some trace in the
  directory recorded that hash on `agentStart`; a mismatch is refused, not
  warned. Stored under `code/<closureHash>/`; a stored tree that is incomplete
  or does not hash to its own name is reported as corrupt.
- **Workdir** copies to `workdir/<traceId>/` and writes the dated sidecar. A
  workdir attached later may postdate the run; the sidecar says so.
  Replacement goes through `safeDeleteDirectoryWithin(root, target)`
  (`lib/utils.ts`), which deletes only a strict descendant of the run
  directory's `workdir/` after resolving symlinks.

## The lock (`lock.ts`)

Moved here from the label store. One writer at a time per directory, as
integrity protection: append order is semantic. A stale lock is reported with
its pid and liveness and **never stolen**. Readers do not need it.

## Derived views

`evalRecordFor(trace)` (`evalRecord.ts`) computes the `EvalRecord` graders and
judges consume — a view, never a file. `traceEnding(trace)` reads how a trace
ended from its own events (`ok` / `error` / `unknown`); the harness's `run` row,
when present, knows more. `summarizeRuns(snapshot)` (`list.ts`) is one
`RunSummary` per trace for listings. `traceInputText` / `traceOutputText`
(`traceText.ts`) are the one rule for what "the input" and "the output" of a
trace are when shown to a person (listings, the labeling screen).

## Durable writes (`durableWrite.ts`)

`appendDurably` (append + fsync) and `atomicWriteValidated` (validate, write a
temp file, fsync, rename) are the two primitives every writer here uses;
checklist revisions and labeling drafts use them too.

## Labeling (`labelStore.ts`)

`openLabelStore` is the facade `agency label` works through; see
`docs/dev/eval-labeling.md`. It holds the writer lock for the whole session and
appends through `appendAnnotationsUnderLock`, the one `@internal` export of
`mutations.ts`.

## Commands (`lib/cli/runDirectory/`)

One file per command; none imports the lock or the append helpers.

- `agency logs extract <log> [--trace <id>] [-o <file>]` — copy one trace out
  of a statelog, verbatim (a single-trace log needs no `--trace`). The viewer's
  `x` key does the same for the focused trace, prompting for a path.
- `agency runs add <dir> [--statelog f]… [--code entry]… [--workdir p [--trace id]] [--annotations f]… [--replace]`
  — one `addToRunDirectory` request; prints counts and the listing.
- `agency runs list <dir>` — one line per trace (`summarizeRuns`).
- `agency note <dir> <text> [--trace id] [--annotator who]` — `recordNote`.
- `agency run <file> --capture-workdir <dir>` (`lib/cli/commands.ts`) — mints
  a trace id (`AGENCY_TRACE_ID`), points the child's statelog at a private
  staging file (`log.logFile` + `observability` overrides), and after exit
  makes one `addToRunDirectory` call: that statelog, the entry file's code
  closure, and the working directory as the trace's workdir snapshot. The
  snapshot is the whole cwd, so run it from the project you mean to capture.
- `agency logs <dir>` — the viewer on the directory's statelog with each
  trace's annotations summarised (`annotationSummaries`); several paths open
  the runs explorer, which reads run directories through `readRunDirectory`
  (`docs/dev/runs-explorer.md`).

## Gotchas

- The module is `lib/runDirectory/`, not `lib/runs/`: `**/runs/` is gitignored
  as eval output.
- `closureBaseDir` (`lib/analysis/closure.ts`) prefers cwd; identity uses the
  exported `commonAncestor` instead. Do not "simplify" it back.
- Two `readTraces` passes inside one snapshot means the statelog is parsed
  twice; that is ~70 ms on a 12 MB log and buys coherence without a reader lock.
