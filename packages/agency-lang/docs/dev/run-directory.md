# The run directory

A run directory is the one on-disk shape that observing, noting, labeling,
grading and optimizing all read and write. The design and its reasoning are in
`docs/superpowers/specs/2026-08-18-run-directory-and-annotations-design.md`;
this page is the map of the code in `lib/runDirectory/` and the rules that are
easy to get wrong.

## What is on disk

```
<dir>/
  statelog.jsonl        # required; ONE trace (one trace = one run; subagents share the id)
  annotations.jsonl     # every structured opinion about the run: checklist, score, run
  notes.md              # a person's free-form notes, written with any editor
  code/                 # the agent's closure, as it ran, flat
  workdir/              # filesystem snapshot, flat
  workdir.json          # { snapshotAt, source } — when and where from
  checklists/<id>/      # versioned checklist revisions + labeling drafts (docs/dev/eval-labeling.md)
  .lock                 # present only while a writer is open
```

**One run per directory.** Writers only ever produce directories with one
trace, so a run can be moved with `cp -r` and opened anywhere. A **group** is
any directory of run directories (what `eval run --out` writes); it has no
index file. `findRunDirectories(paths)` (`findRuns.ts`) is the one walk rule:
a run directory is itself, a directory of run directories yields its children
(one level, sorted), anything else is an error. `eval grade`, `runs list` and
the logs explorer and `label` use it (`uniqueRunDirectories` drops aliases of
one physical directory where a command mutates or keys by run). The reader
refuses a `statelog.jsonl` holding more than one trace id (`assertOneRun`,
naming the ids and `runs add` to split it), and `recordCompletedRun` refuses,
before writing a byte, anything that would make a directory hold two runs: a
second staged trace, a run row for another trace than the one present, or a
second silent run row. No writer and no reader handles the pre-atomic shape.

**The statelog is the run.** A directory holding only `statelog.jsonl` is a
valid run directory; every other entry is an attachment that unlocks more.
`agentStart` carries `code` (which closure ran) and `input` (what the entry
node was given) — see `docs/dev/statelog.md` — so a trace stands on its own.

## Read side: one snapshot, no lock

`readRunDirectory(dir, { reportWarning })` (`runDir.ts`) returns a
`RunDirectorySnapshot`: `traces`, raw `annotationRows`, `effectiveAnnotations`
(the fold), and `notes` (the text of `notes.md`, or null when absent). Readers
never take the lock; the snapshot reads statelog → annotations → statelog and
retries when a writer changed the statelog in between, so the pairing is
coherent. Parse errors are warnings.

`notes.md` is outside that coherence check and outside the writer lock: it is
a person's file, edited with any editor, and nothing in Agency writes it.
`readNotes` is one `readFileSync`; `ENOENT` is the value null (so an editor's
unlink-then-rename save cannot crash a reader), any other I/O error propagates.
A read during such a save may see the old text, the new text, or null.

`readTraces` (`traces.ts`) is built on `parseStatelogJsonlWithLines`
(`lib/statelog/parse.ts`), the one owner of line decoding. It drops a torn final
line and byte-identical duplicate lines within a trace (the harmless result of
`cat`), and computes a per-trace **digest over the canonicalized events**, so
key order does not matter. It does not — cannot — detect two different streams
sharing an id once they are interleaved; that check lives in the merge planner.

## Annotations (`annotations.ts`)

One row per opinion; three kinds (a person's free-form note is not a row, it
is `notes.md`):

| kind | who | what |
|---|---|---|
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
- **The fold is per key, append order decides**: checklist
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

- `wrapTracesAsRunDirectories({ groupDir, statelogFiles, trace?, codeEntries, workdir?, annotationFiles })`
  — one `<groupDir>/<traceId>/` per trace, each assembled under
  `<groupDir>/.staging/` and renamed into place; an existing child is skipped,
  never touched; `--trace` narrows; a workdir needs exactly one trace; code
  must match at least one trace and attaches to the ones that recorded it;
  annotation rows go to the child their `traceId` names and must name one of
  the traces. Used by `runs add` and `run --capture-workdir`.
- `recordCompletedRun({ dir, stagedStatelogFile, codeEntry?, workdir?, run })` — the eval harness's one call per finished test, on a fresh directory
- `recordGradingPass({ dir, scores })` — mints one `passId`, stamps `passSize`, marks the last row `completesPass`; an empty `scores` is refused
- `recordChecklistRow({ dir, groupDir, row })` — one labeling sign-off, the completed row as the session built it (its id is content-derived, so a replay lands on the same id): grounded immediately before the append against the run (holds the trace) and the group's lineage (revision exists with that hash; every answer names one of its questions); returns `appended` or `replayed` plus the post-write snapshot

Writer inputs are held to a stricter standard than reads: a statelog file
with any unparseable line is refused whole (`readTracesOrThrow`), because a
trace stored without its bad lines would look complete. `recordCompletedRun`
also refuses a `run` row for trace X when the staged statelog holds traces
and X is not among them (nor already in the directory). A staged log with no
traces is still fine: a run that died before its first event has no trace,
and its `run` row is the only record it happened. `describeStatelogMerge(plan, dir)` is the one sentence for a
merge outcome (which ids were refused, or that nothing was added and how many
were already there); the CLI and the refusal errors both use it.

Nothing outside this module and the checklist sign-off owner may import the
lock or the `apply*` helpers.

The planners (`mergeStatelog.ts`, `attachCode.ts`, `attachWorkdir.ts`):

- **Merge** judges the whole incoming set: absent id → add; same id and equal
  digest → skip; same id, different digest → refuse, and the whole plan fails.
- **Code** hashes the closure it is given (`computeCodeIdentity`, relative to
  the closure's common ancestor, never cwd) and requires that some trace in the
  directory recorded that hash on `agentStart`; a mismatch is refused, not
  warned. Stored flat under `code/`; a stored tree that is incomplete or does
  not hash to what the trace recorded is reported as corrupt.
- **Workdir** copies to `workdir/` and writes the dated `workdir.json`
  sidecar. A workdir attached later may postdate the run; the sidecar says so.
  The run directory itself, and the optional `excludeDir` (the group a capture
  is written into), are left out of the copy.
  Replacement goes through `safeDeleteDirectoryWithin(root, target)`
  (`lib/utils.ts`), which deletes only a strict descendant of the run
  directory after resolving symlinks.

## The lock (`lock.ts`)

Moved here from the label store. One writer at a time per directory, as
integrity protection: append order is semantic. A stale lock is reported with
its pid and liveness and **never stolen**. Readers do not need it.

Node has no built-in file lock (`fs` exposes no `flock`), so this is the
standard idiom: create the lock file with the `wx` flag, which fails if the
file exists, and record who holds it. Packages such as `proper-lockfile` do
the same thing with more machinery (mtime-based staleness and takeover); we
deliberately do not want takeover, so the ~100 lines here are the whole
feature.

## Derived views

`evalRecordFor(trace)` (`evalRecord.ts`) computes the `EvalRecord` graders and
judges consume — a view, never a file. `traceEnding(trace)` reads how a trace
ended from its own events (`ok` / `error` / `unknown`); the harness's `run` row,
when present, knows more. `summarizeRuns(snapshot)` (`list.ts`) is one
`RunSummary` per trace for listings; its `hasNotes` is true when `notes.md`
has non-blank text, and is the same for every trace the directory holds,
because the note is about the run. `annotationSummaryText` renders the
viewer's per-trace line ("notes · score 0.70 · labeled"). `humanFeedbackFor`
(`humanFeedback.ts`) puts the trimmed `notes.md` first in `notes`, then each
checklist sign-off's note. `traceInputText` / `traceOutputText`
(`traceText.ts`) are the one rule for what "the input" and "the output" of a
trace are when shown to a person (listings, the labeling screen).

## Durable writes (`durableWrite.ts`)

`appendDurably` (append + fsync) and `atomicWriteValidated` (validate, write a
temp file, fsync, rename) are the two primitives every writer here uses;
checklist revisions and labeling drafts use them too.

## Labeling (`labelStore.ts`)

`openLabelStore` is the facade `agency label` works through; see
`docs/dev/eval-labeling.md`. It is over a group (`resolveLabelingGroup` in
`lib/eval/label/group.ts`): session files live in `<group>/checklists/`, a
sign-off appends to its run through `recordChecklistRow` under that run's
lock, and the store holds only a per-session draft lock (plus a short one
around each lineage publication), never a group-wide one. Those locks are
`acquireOwnedFileLock` (`lock.ts`), the same primitive as the run lock at a
different path.

## Commands (`lib/cli/runDirectory/`)

One file per command; none imports the lock or the append helpers.

- `agency logs extract <log> [--trace <id>] [-o <file>] [--overwrite]` — copy
  one trace out of a statelog (a single-trace log needs no `--trace`). Lines
  are copied as they appear, except the two things `readTraces` drops: a torn
  final line and a byte-identical repeat of an earlier line in the same trace.
  An existing `--out` file is refused unless `--overwrite` is passed, and the
  source log itself is never a valid output. The viewer's `x` key does the
  same for the focused trace, prompting for a path, and also refuses an
  existing file.
- `agency runs add <group> [--statelog f]… [--trace id] [--code entry]… [--workdir p] [--annotations f]…`
  — one `wrapTracesAsRunDirectories` request; prints one line per child
  written or skipped.
- `agency runs list <path…>` — one line per run across every run directory
  the paths name (`findRunDirectories`, then `readRunDirectory` each, then
  `buildRunsListing` → `formatRunsList`). Columns `TRACE TEST AGENT STARTED
  ENDED TIME COST LLM TOOLS SCORE NOTES LABELED INPUT`: `NOTES` is `yes`
  when `notes.md` has text, else blank; `TEST` is the harness
  `run` row's test id; `AGENT` is `displayAgent`: the trace's own `agentName`
  event, else the harness label `flags.agent` unchanged (a command line is
  not shortened; its basename could be any argument). `SCORE` and the footer
  mean are the persisted effective score rows (weighted mean per run); a run
  `eval grade` scored zero without running graders (errored, timed out,
  traceless) has no score row and is left out of `G graded`, so the two means
  can differ for such a group. Footer: `N runs · mean 0.720 over G graded ·
  S runs wrote no trace`, clauses only when they apply (the table is omitted
  when there are no rows). Duplicate paths are duplicate rows.
- `agency label <path…> --checklist <file>` (`lib/cli/eval/label.ts`) — the
  same walk into one group; see `docs/dev/eval-labeling.md`.
- `agency eval grade <path…>` (`lib/cli/eval/grade.ts`) — the same walk, then
  duplicates removed by physical identity (`fs.realpathSync.native`) before
  any pass is written: grading mutates, so `eval grade runs/suite runs/suite/a`
  grades `a` once. One pass per run directory; per-test blocks and the mean
  (`formatGrade.ts`).
- `agency run <file> --capture-workdir <dir>` (`lib/cli/commands.ts`) — mints
  a trace id (`AGENCY_TRACE_ID`), points the child's statelog at a private
  staging file (`log.logFile` + `observability` overrides), and after exit
  wraps that one trace as `<dir>/<traceId>/`: the statelog, the entry file's
  code closure, and the working directory as the workdir snapshot. The
  snapshot is the whole cwd, so run it from the project you mean to capture.
  The destination may sit inside that cwd (`--capture-workdir ./runs` is the
  natural call); `<dir>` is left out of the snapshot rather than copied into
  itself. The capture statelog and the code identity always
  win over inherited config overrides (`runChildOverrides`), and the temp
  staging directory is removed whether or not the fold succeeded.
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
